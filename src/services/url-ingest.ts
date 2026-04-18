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
import { findByUrl } from '../db/content-items.js';
import { createContentItem } from './content-items.js';
import { FirecrawlClient } from '../providers/firecrawl.js';
// XaiClient import removed — live_search deprecated. Re-add when we wire Agent Tools API.
import {
  detectUrlType,
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

export async function ingestFromUrl(
  deps: ServiceDeps,
  url: string,
  opts: IngestFromUrlInput = {},
): Promise<IngestFromUrlResult> {
  const normalized = normalizeUrl(url);
  console.log(`[url-ingest] Starting — url: ${normalized}`);

  // Dedup by source_url
  const existing = await findByUrl(deps.db, normalized);
  if (existing) {
    console.log(`[url-ingest] Deduped — existing item: ${existing.id}`);
    return {
      id: existing.id,
      title: existing.title,
      type: existing.type,
      source_url: normalized,
      deduped: true,
      url_type: 'html', // we don't persist url_type; not used on dedup
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

  // Primary: direct scrape of the watch page (fast, free).
  // Fallback: Firecrawl stealth mode (works when Azure IPs are bot-blocked by YouTube;
  // Firecrawl's managed proxy pool bypasses most YouTube bot detection).
  let transcript = '';
  try {
    const items = await fetchYouTubeTranscript(videoId);
    transcript = items.map((t) => t.text).join(' ');
    if (!transcript.trim()) throw new Error('Empty transcript from direct scrape.');
    console.log(`[url-ingest][youtube] direct scrape succeeded — length: ${transcript.length}`);
  } catch (scrapeErr) {
    console.warn(
      `[url-ingest][youtube] direct scrape failed, falling back to Firecrawl stealth:`,
      scrapeErr instanceof Error ? scrapeErr.message : scrapeErr,
    );
    try {
      const firecrawl = new FirecrawlClient(deps.config.firecrawlApiKey);
      const res = await firecrawl.scrape(url, { stealth: true });
      transcript = res.markdown;
      if (!transcript.trim()) throw new Error('Firecrawl returned empty content.');
      console.log(`[url-ingest][youtube] Firecrawl fallback succeeded — length: ${transcript.length}`);
    } catch (fcErr) {
      throw new Error(
        `Couldn't fetch YouTube transcript — both direct scrape and Firecrawl fallback failed. ${
          fcErr instanceof Error ? fcErr.message : fcErr
        }`,
      );
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
  // Note: xAI's Grok live_search was deprecated in 2026 in favor of Agent Tools API.
  // Using Firecrawl stealth as the reliable primary path for X — their managed proxy
  // pool handles X's anti-scraping. xAI fallback path kept in XaiClient for when
  // we wire up the new Agent Tools API.
  const firecrawl = new FirecrawlClient(deps.config.firecrawlApiKey);

  let content: string;
  let fetchedTitle: string;

  try {
    const fc = await firecrawl.scrape(url, { stealth: true });
    content = fc.markdown;
    fetchedTitle = fc.title;
    console.log(`[url-ingest][x] Firecrawl stealth succeeded — length: ${content.length}`);
  } catch (err) {
    throw new Error(
      `Couldn't fetch X thread via Firecrawl. ${err instanceof Error ? err.message : err}`,
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
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);

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
