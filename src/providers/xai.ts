/**
 * xAI Grok client — used specifically to fetch X (Twitter) thread content
 * via Grok's live-search capability over X.
 *
 * Docs reference: https://docs.x.ai/docs/api-reference — live_search parameters
 * let Grok pull from X, news, web, and RSS. We restrict to X.
 */

const XAI_ENDPOINT = 'https://api.x.ai/v1/chat/completions';
const XAI_MODEL = 'grok-4-latest';

export interface XThreadResult {
  title: string;   // short descriptor, usually first-tweet excerpt
  content: string; // full thread text with author attribution where possible
}

export class XaiClient {
  constructor(private apiKey: string) {}

  /**
   * Fetch the full content of an X thread (original post + replies) with
   * author attribution and timestamps. Uses Grok's live search restricted
   * to X as the source.
   */
  async fetchXThread(url: string): Promise<XThreadResult> {
    const prompt = `Fetch the full content of this X (Twitter) thread: ${url}

Return the complete thread as plain text, including:
- The original post
- All replies in the thread
- Author handle and display name for each post
- Post timestamp (if available)

Format it as readable prose with clear post boundaries. Do NOT add commentary, analysis, or summary. Return ONLY the thread content.`;

    const res = await fetch(XAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: XAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        search_parameters: {
          mode: 'on',
          sources: [{ type: 'x' }],
          return_citations: false,
        },
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`xAI API ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? '';

    if (!content.trim()) {
      throw new Error('xAI returned empty content — thread may be unavailable, deleted, or private.');
    }

    // Title: first 80 chars of first non-empty line, stripped
    const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
    const title = firstLine.trim().slice(0, 80);

    return { title, content: content.trim() };
  }
}
