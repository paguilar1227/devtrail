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
    // x_search is a search tool, not a URL-fetch tool. Help Grok find the post
    // by extracting the author handle from the URL and scoping the search via
    // allowed_x_handles. Then describe what we want in the prompt.
    const parsed = parseXUrl(url);

    const prompt = parsed
      ? `Use the x_search tool to find and return the full content of a specific post by user @${parsed.handle} with status ID ${parsed.postId} (URL: ${url}).

Search for posts from @${parsed.handle}, find the one with ID ${parsed.postId}, and return:
- The original post content in full
- All replies and continuations in the thread (in thread order)
- Each post's author handle
- Timestamps when available

Format as readable prose with clear post boundaries. Do NOT summarize or add commentary. Return ONLY the post content.

If x_search returns no matching post, respond with exactly this line: X_FETCH_FAILED`
      : `Use x_search to find and return the content of this X post: ${url}

Return the post content only, no summary. If the post cannot be found, respond with exactly: X_FETCH_FAILED`;

    const tools = [
      {
        type: 'x_search',
        ...(parsed ? { allowed_x_handles: [parsed.handle] } : {}),
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
        `xAI x_search couldn't find this post. x_search is search-based (not URL-fetch) — it works best on recent posts from well-known accounts. Grok said: "${result.content.slice(0, 200)}"`,
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
