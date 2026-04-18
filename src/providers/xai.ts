/**
 * xAI client using the Agent Tools API (/v1/responses).
 *
 * The older /v1/chat/completions + search_parameters (live_search) flow
 * was deprecated in 2026. The replacement is:
 *   - Endpoint: /v1/responses
 *   - Payload: { model, input: [{role, content}], tools: [{type: '...'}] }
 *   - Built-in tools: 'web_search', 'x_search', 'code_interpreter', etc.
 *     The API executes them server-side and folds results into the response.
 *
 * For X threads: use the `x_search` tool. For YouTube transcripts: `web_search`
 * (no dedicated YouTube tool; web_search can browse video pages).
 */

const XAI_ENDPOINT = 'https://api.x.ai/v1/responses';
const XAI_MODEL = 'grok-4.20-reasoning';

export interface LiveSearchResult {
  title: string;
  content: string;
}

export class XaiClient {
  constructor(private apiKey: string) {}

  /**
   * Fetch an X thread using the x_search built-in tool. Grok browses X
   * server-side and returns the thread content.
   */
  async fetchXThread(url: string): Promise<LiveSearchResult> {
    // x_search is really x_keyword_search — it searches X by keyword/user/date,
    // it doesn't fetch by post ID directly. Strategy:
    //   1. Parse URL → extract @handle and post ID
    //   2. Decode post ID → timestamp (Twitter snowflakes encode millis since 2010-11-04)
    //   3. Build a search prompt that scopes to this user + a ±1 day window around
    //      the timestamp so Grok can find the specific post via keyword search
    const parsed = parseXUrl(url);
    if (!parsed) {
      throw new Error(`URL does not match the X status pattern: ${url}`);
    }

    const postDate = snowflakeToDate(parsed.postId);
    const fromDate = new Date(postDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(postDate.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const postDateStr = postDate.toISOString();

    const prompt = `Use x_search to find and return a specific X post, then follow its thread.

Target post:
- Author: @${parsed.handle}
- Post ID: ${parsed.postId}
- Approximate timestamp: ${postDateStr}
- URL: ${url}

Steps:
1. Use x_search scoped to @${parsed.handle}'s posts around ${postDateStr}.
2. Find the post with ID ${parsed.postId} (the ID is the final number in the URL).
3. Return the full post content AND all replies / follow-ups in the thread in order.

Format: author handle + post text for each tweet, one tweet per block separated by blank lines. Do NOT summarize or add commentary.

If x_search can't surface the specific post with ID ${parsed.postId}, respond with exactly this single line and nothing else: X_FETCH_FAILED`;

    const tools = [
      {
        type: 'x_search',
        allowed_x_handles: [parsed.handle],
        from_date: fromDate,
        to_date: toDate,
        enable_image_understanding: true,
        enable_video_understanding: true,
      },
    ];

    const result = await this.callAgentTools(prompt, tools);

    if (
      result.content.trim() === 'X_FETCH_FAILED' ||
      /\bX_FETCH_FAILED\b/.test(result.content) ||
      /fetch error|could not be retrieved|unable to fetch|failed to fetch/i.test(result.content)
    ) {
      throw new Error(
        `xAI x_search couldn't find post ${parsed.postId} by @${parsed.handle}. x_search is keyword-based — it works best when x_keyword_search can surface the post in its result set. Grok said: "${result.content.slice(0, 200)}"`,
      );
    }

    return result;
  }

  /**
   * Fetch a YouTube video's transcript via web_search. Grok's web tool can
   * browse YouTube pages and extract captions.
   */
  async fetchYoutubeTranscript(url: string): Promise<LiveSearchResult> {
    const prompt = `Fetch the full transcript (captions) of this YouTube video: ${url}

Return the complete spoken content as plain text. Do NOT summarize, analyze, or add commentary. Just the raw transcript.

If the video has no captions available, respond with exactly: NO_CAPTIONS_AVAILABLE`;

    const result = await this.callAgentTools(prompt, [{ type: 'web_search' } as Record<string, unknown>]);
    if (result.content.trim() === 'NO_CAPTIONS_AVAILABLE' || /\bNO_CAPTIONS_AVAILABLE\b/.test(result.content)) {
      throw new Error('No captions available for this YouTube video.');
    }
    return result;
  }

  /**
   * Core Agent Tools API call. Extracts the assistant text from the
   * /v1/responses output.
   */
  private async callAgentTools(
    prompt: string,
    tools: Array<Record<string, unknown>>,
  ): Promise<LiveSearchResult> {
    const res = await fetch(XAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: XAI_MODEL,
        input: [{ role: 'user', content: prompt }],
        tools,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`xAI /v1/responses ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as unknown;
    const text = extractAssistantText(json);

    if (!text.trim()) {
      throw new Error('xAI returned no assistant text (tool may have found nothing).');
    }

    const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
    const title = firstLine.trim().slice(0, 80);
    return { title, content: text.trim() };
  }
}

/** Extract @handle and post ID from an X URL. Returns null on mismatch. */
function parseXUrl(url: string): { handle: string; postId: string } | null {
  const m = url.match(/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/i);
  if (!m) return null;
  return { handle: m[1], postId: m[2] };
}

/**
 * Decode a Twitter/X snowflake ID into its creation timestamp.
 * Snowflake format: (ms since 2010-11-04T01:42:54.657Z) << 22 | metadata.
 * Use BigInt because IDs exceed Number.MAX_SAFE_INTEGER.
 */
const TWITTER_EPOCH_MS = 1288834974657n;
function snowflakeToDate(postId: string): Date {
  try {
    const id = BigInt(postId);
    const ms = (id >> 22n) + TWITTER_EPOCH_MS;
    const date = new Date(Number(ms));
    // Sanity: if decoded date is wildly wrong, fall back to "now"
    if (isNaN(date.getTime()) || date.getFullYear() < 2006 || date.getFullYear() > 2100) {
      return new Date();
    }
    return date;
  } catch {
    return new Date();
  }
}

/**
 * The /v1/responses format is similar to OpenAI's: an array of output items,
 * each with a type (e.g. "message", "tool_call"). The assistant's final text
 * lives in items where type === "message", content[].text.
 *
 * This extractor is defensive — the exact shape may evolve. We look for text
 * in the most likely places and concatenate.
 */
function extractAssistantText(resp: unknown): string {
  if (!resp || typeof resp !== 'object') return '';
  const obj = resp as Record<string, unknown>;

  // Shape 1: { output: [{ type: 'message', content: [{ type: 'output_text', text: '...' }] }] }
  if (Array.isArray(obj.output)) {
    const parts: string[] = [];
    for (const item of obj.output) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      if (it.type === 'message' && Array.isArray(it.content)) {
        for (const c of it.content) {
          if (!c || typeof c !== 'object') continue;
          const cc = c as Record<string, unknown>;
          if (typeof cc.text === 'string') parts.push(cc.text);
        }
      }
    }
    if (parts.length > 0) return parts.join('\n\n');
  }

  // Shape 2: { output_text: '...' } (OpenAI-compat convenience field)
  if (typeof obj.output_text === 'string') return obj.output_text;

  // Shape 3: legacy choices[].message.content for transition period
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const choice = obj.choices[0] as Record<string, unknown>;
    const msg = choice.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === 'string') return msg.content;
  }

  return '';
}
