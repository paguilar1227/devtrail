/**
 * Minimal YouTube transcript fetcher — no external dependencies.
 *
 * Scrapes the YouTube watch page for the caption tracks in the initial player
 * data, then fetches the first available track and parses the XML/VTT response.
 *
 * Known limits:
 *   - Videos with captions disabled will throw.
 *   - Age-gated or region-locked videos may fail.
 *   - YouTube's internal page structure can change — this is best-effort scraping.
 */

const HEADERS = {
  // Pretend to be a desktop browser so YouTube serves the full page
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface TranscriptEntry {
  text: string;
  start?: number;
  duration?: number;
}

export async function fetchYouTubeTranscript(videoId: string): Promise<TranscriptEntry[]> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl);

  // Extract ytInitialPlayerResponse JSON (contains captionTracks)
  const captionTracks = extractCaptionTracks(html);
  if (!captionTracks.length) {
    throw new Error('No captions available for this video (none published, age-gated, or region-locked).');
  }

  // Prefer English if available, fall back to the first track
  const track =
    captionTracks.find((t) => t.languageCode?.toLowerCase().startsWith('en')) ??
    captionTracks[0];

  const xml = await fetchText(track.baseUrl);
  return parseTranscriptXml(xml);
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  name?: { simpleText?: string };
  kind?: string;
}

function extractCaptionTracks(html: string): CaptionTrack[] {
  // The captionTracks array is inline in the page as JSON. Find it without
  // parsing the whole document.
  const match = html.match(/"captionTracks":(\[.*?\])/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]) as CaptionTrack[];
  } catch {
    return [];
  }
}

function parseTranscriptXml(xml: string): TranscriptEntry[] {
  // YouTube timedtext XML looks like:
  //   <transcript><text start="0.0" dur="3.2">Hello world</text> ... </transcript>
  const results: TranscriptEntry[] = [];
  const textRe = /<text(?:\s+start="([\d.]+)")?(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(xml)) !== null) {
    const text = decodeEntities(m[3]).trim();
    if (!text) continue;
    results.push({
      text,
      start: m[1] ? parseFloat(m[1]) : undefined,
      duration: m[2] ? parseFloat(m[2]) : undefined,
    });
  }
  return results;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n/g, ' ');
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url.slice(0, 60)}...`);
  return await res.text();
}
