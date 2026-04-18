/**
 * URL ingestion orchestrator.
 *
 * Takes a URL → determines its type → uses the right handler to fetch content →
 * routes through the existing content-items pipeline with `source_url` set.
 *
 * Dedup: if we already have a content item for this URL, return it instead of
 * re-ingesting.
 *
 * Supported URL types (Tier 1):
 *   - YouTube → transcript via `youtube-transcript` npm package
 *   - X/Twitter threads → xAI Grok live-search primary, Firecrawl stealth fallback
 *   - PDF / image / audio / video direct links → download bytes, reuse the file pipeline
 *   - Generic HTML → Firecrawl markdown extraction
 */

import type { ServiceDeps } from './index.js';
import { fetchYouTubeTranscript } from '../providers/youtube-transcript.js';
import { findByUrl, updateContentItem as dbUpdate } from '../db/content-items.js';
import { createContentItem } from './content-items.js';
import { FirecrawlClient } from '../providers/firecrawl.js';
import { XaiClient } from '../providers/xai.js';
import {
  detectUrlType,
  detectUrlTypeByPattern,
  extractYouTubeVideoId,
  normalizeUrl,
  type UrlType,
} from '../capture/url-detect.js';

export interface IngestFromUrlInput {
  projectIds?: string[];
  tags?: string[];
  title?: string;
}

export interface IngestFromUrlResult {
  id: string;
  title: string;
  type: 'document' | 'note';
  source_url: string;
  deduped: boolean;
  chunkCount?: number;
  url_type: UrlType;
}

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB guardrail for binary URLs
const MIN_HTML_CONTENT_CHARS = 300; // reject Firecrawl results shorter than this (placeholder pages)

/** Title patterns that indicate the URL resolved to an error/placeholder page, not real content. */
const ERROR_TITLE_PATTERNS = [
  /^example domain$/i,
  /\b(not found|doesn't exist|page not found|article not found)\b/i,
  /^404\b/i,
  /^error\s+\d/i,
];

/** Title strings that are entirely generic — not a real article. */
const GENERIC_TITLES = new Set([
  'untitled',
  'error',
  'page not found',
  '404',
  '',
]);

export async function ingestFromUrl(
  deps: ServiceDeps,
  url: string,
  opts: IngestFromUrlInput = {},
): Promise<IngestFromUrlResult> {
  const normalized = normalizeUrl(url);
  console.log(`[url-ingest] Starting — url: ${normalized}`);

  // Dedup by source_url. On hit: merge incoming project_ids and tags into the
  // existing item (previously we silently dropped them — user thought their
  // save scoped to a project, but the item's project_ids stayed as-is).
  const existing = await findByUrl(deps.db, normalized);
  if (existing) {
    // Cheap URL-type detection for the response (no HEAD, just the pattern match).
    const urlTypeByPattern = detectUrlTypeByPattern(normalized) ?? 'html';

    const incomingProjectIds = opts.projectIds ?? [];
    const incomingTags = opts.tags ?? [];
    const mergedProjectIds = Array.from(new Set([...(existing.project_ids ?? []), ...incomingProjectIds]));
    const mergedTags = Array.from(new Set([...(existing.tags ?? []), ...incomingTags]));

    const projectsChanged = mergedProjectIds.length !== (existing.project_ids?.length ?? 0);
    const tagsChanged = mergedTags.length !== (existing.tags?.length ?? 0);

    if (projectsChanged || tagsChanged) {
      console.log(
        `[url-ingest] Deduped + merging — item: ${existing.id}, ` +
        `+projects: ${projectsChanged ? JSON.stringify(incomingProjectIds) : '(none)'}, ` +
        `+tags: ${tagsChanged ? JSON.stringify(incomingTags) : '(none)'}`,
      );
      await dbUpdate(deps.db, existing.id, {
        projectIds: mergedProjectIds,
        tags: mergedTags,
      });
    } else {
      console.log(`[url-ingest] Deduped — existing item: ${existing.id}, no membership changes`);
    }

    return {
      id: existing.id,
      title: existing.title,
      type: existing.type,
      source_url: normalized,
      deduped: true,
      url_type: urlTypeByPattern,
    };
  }

  const urlType = await detectUrlType(normalized);
  console.log(`[url-ingest] Detected type: ${urlType}`);

  switch (urlType) {
    case 'youtube':
      return await handleYoutube(deps, normalized, opts);
    case 'x':
      return await handleXThread(deps, normalized, opts);
    case 'pdf':
      return await handleBinary(deps, normalized, opts, 'application/pdf');
    case 'image':
    case 'audio':
    case 'video':
      return await handleBinary(deps, normalized, opts, null);
    case 'html':
    default:
      return await handleHtml(deps, normalized, opts);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleYoutube(
  deps: ServiceDeps,
  url: string,
  opts: IngestFromUrlInput,
): Promise<IngestFromUrlResult> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL.');

  // Tier 1: direct scrape of the watch page (fast, free).
  // Tier 2: Firecrawl stealth (managed proxy, bypasses YouTube bot detection).
  // Tier 3: xAI web_search (Grok browses the page server-side via Agent Tools API).
  let transcript = '';

  try {
    const items = await fetchYouTubeTranscript(videoId);
    transcript = items.map((t) => t.text).join(' ');
    if (!transcript.trim()) throw new Error('Empty transcript from direct scrape.');
    console.log(`[url-ingest][youtube] direct scrape succeeded — length: ${transcript.length}`);
  } catch (scrapeErr) {
    console.warn(
      `[url-ingest][youtube] direct scrape failed, trying Firecrawl:`,
      scrapeErr instanceof Error ? scrapeErr.message : scrapeErr,
    );
    try {
      const firecrawl = new FirecrawlClient(deps.config.firecrawlApiKey);
      const res = await firecrawl.scrape(url, { stealth: true });
      transcript = res.markdown;
      if (!transcript.trim()) throw new Error('Firecrawl returned empty content.');
      console.log(`[url-ingest][youtube] Firecrawl succeeded — length: ${transcript.length}`);
    } catch (fcErr) {
      console.warn(
        `[url-ingest][youtube] Firecrawl failed, trying xAI:`,
        fcErr instanceof Error ? fcErr.message : fcErr,
      );
      try {
        const xai = new XaiClient(deps.config.xaiApiKey);
        const res = await xai.fetchYoutubeTranscript(url);
        transcript = res.content;
        console.log(`[url-ingest][youtube] xAI fallback succeeded — length: ${transcript.length}`);
      } catch (xaiErr) {
        throw new Error(
          `Couldn't fetch YouTube transcript — direct scrape, Firecrawl, AND xAI all failed. ${
            xaiErr instanceof Error ? xaiErr.message : xaiErr
          }`,
        );
      }
    }
  }

  if (!transcript.trim()) {
    throw new Error('YouTube transcript was empty after all fetch attempts.');
  }

  const result = await createContentItem(deps, {
    type: 'document',
    content: transcript,
    title: opts.title, // auto-generated via Gemini Flash if omitted
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
  });

  return {
    id: result.id,
    title: result.title,
    type: 'document',
    source_url: url,
    deduped: false,
    chunkCount: result.chunkCount,
    url_type: 'youtube',
  };
}

async function handleXThread(
  deps: ServiceDeps,
  url: string,
  opts: IngestFromUrlInput,
): Promise<IngestFromUrlResult> {
  // Primary: xAI Agent Tools API with x_search built-in tool (the 2026 replacement
  //   for the deprecated live_search). Grok does the X fetch server-side.
  // Firecrawl is NOT a useful fallback here — they explicitly refuse x.com.
  const xai = new XaiClient(deps.config.xaiApiKey);

  let content: string;
  let fetchedTitle: string;

  try {
    const res = await xai.fetchXThread(url);
    content = res.content;
    fetchedTitle = res.title;
    console.log(`[url-ingest][x] xAI x_search succeeded — length: ${content.length}`);
  } catch (err) {
    throw new Error(
      `Couldn't fetch X thread via xAI x_search: ${err instanceof Error ? err.message : err}`,
    );
  }

  const result = await createContentItem(deps, {
    type: 'document',
    content,
    title: opts.title ?? fetchedTitle,
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
  });

  return {
    id: result.id,
    title: result.title,
    type: 'document',
    source_url: url,
    deduped: false,
    chunkCount: result.chunkCount,
    url_type: 'x',
  };
}

async function handleHtml(
  deps: ServiceDeps,
  url: string,
  opts: IngestFromUrlInput,
): Promise<IngestFromUrlResult> {
  const firecrawl = new FirecrawlClient(deps.config.firecrawlApiKey);
  const { title, markdown } = await firecrawl.scrape(url);
  console.log(`[url-ingest][html] scraped — title: "${title}", length: ${markdown.length}`);

  // Guard against saving placeholder pages and error pages. Wikipedia, example.com,
  // and similar often return 200 OK with a tiny "not found"-style body; we need to
  // detect those ourselves since HTTP status didn't help.
  if (markdown.length < MIN_HTML_CONTENT_CHARS) {
    throw new Error(
      `Scraped content from ${url} is suspiciously short (${markdown.length} chars, threshold ${MIN_HTML_CONTENT_CHARS}). ` +
      `Likely a placeholder or error page — not saving. Title was: "${title}"`,
    );
  }
  if (ERROR_TITLE_PATTERNS.some((p) => p.test(title)) || GENERIC_TITLES.has(title.toLowerCase().trim())) {
    throw new Error(
      `Page title "${title}" indicates a 404/error/placeholder page at ${url}. Not saving.`,
    );
  }

  const result = await createContentItem(deps, {
    type: 'document',
    content: markdown,
    title: opts.title ?? title,
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
  });

  return {
    id: result.id,
    title: result.title,
    type: 'document',
    source_url: url,
    deduped: false,
    chunkCount: result.chunkCount,
    url_type: 'html',
  };
}

async function handleBinary(
  deps: ServiceDeps,
  url: string,
  opts: IngestFromUrlInput,
  forcedMimeType: string | null,
): Promise<IngestFromUrlResult> {
  const res = await fetch(url, { redirect: 'follow' });
  // fetch.ok is true for any 2xx. Treat 3xx (follow should have handled),
  // 4xx and 5xx as failures with a clear message.
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText || ''}`.trim());
  }

  // Enforce size cap up front via Content-Length when available
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const len = parseInt(lenHeader, 10);
    if (len > MAX_DOWNLOAD_BYTES) {
      throw new Error(`File too large (${(len / 1024 / 1024).toFixed(1)} MB, max ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB)`);
    }
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB, max ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB)`);
  }

  const mimeType =
    forcedMimeType ??
    res.headers.get('content-type')?.split(';')[0]?.trim() ??
    'application/octet-stream';
  const filename = (() => {
    try {
      const path = new URL(url).pathname;
      return path.split('/').filter(Boolean).pop() ?? 'download';
    } catch {
      return 'download';
    }
  })();

  console.log(`[url-ingest][binary] downloaded ${(buf.length / 1024).toFixed(1)} KB, mime: ${mimeType}`);

  const result = await createContentItem(deps, {
    type: 'document',
    title: opts.title,
    projectIds: opts.projectIds,
    tags: opts.tags,
    sourceUrl: url,
    file: { data: buf, mimeType, filename },
  });

  // url_type already determined by caller; we don't re-derive here. Caller sets it via detection.
  return {
    id: result.id,
    title: result.title,
    type: 'document',
    source_url: url,
    deduped: false,
    chunkCount: result.chunkCount,
    url_type: inferUrlTypeFromMime(mimeType),
  };
}

function inferUrlTypeFromMime(mime: string): UrlType {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'html';
}
