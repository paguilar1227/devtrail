/**
 * xAI Grok client — used specifically to fetch X (Twitter) thread content
 * via Grok's live-search capability over X.
 *
 * Docs reference: https://docs.x.ai/docs/api-reference — live_search parameters
 * let Grok pull from X, news, web, and RSS. We restrict to X.
 */

const XAI_ENDPOINT = 'https://api.x.ai/v1/chat/completions';
const XAI_MODEL = 'grok-4-latest';

export interface LiveSearchResult {
  title: string;
  content: string;
}

export class XaiClient {
  constructor(private apiKey: string) {}

  /**
   * Fetch the full content of an X thread (original post + replies).
   * Uses Grok's live search restricted to X.
   */
  async fetchXThread(url: string): Promise<LiveSearchResult> {
    const prompt = `Fetch the full content of this X (Twitter) thread: ${url}

Return the complete thread as plain text, including:
- The original post
- All replies in the thread
- Author handle and display name for each post
- Post timestamp (if available)

Format it as readable prose with clear post boundaries. Do NOT add commentary, analysis, or summary. Return ONLY the thread content.`;

    return await this.liveSearchRequest(prompt, [{ type: 'x' }]);
  }

  /**
   * Fetch a YouTube video's transcript via Grok's web search.
   * Fallback for when direct scraping fails (Azure IPs often get bot-detected
   * or served a stripped page that doesn't include captionTracks).
   */
  async fetchYoutubeTranscript(url: string): Promise<LiveSearchResult> {
    const prompt = `Fetch the FULL transcript (captions) of this YouTube video: ${url}

Return the complete spoken content as plain text. Do NOT summarize, analyze, or add commentary. Do NOT add timestamps unless they're clearly useful for separating speakers. Just the transcript text as uttered in the video. If there are no captions available, say exactly: "NO_CAPTIONS_AVAILABLE".`;

    const result = await this.liveSearchRequest(prompt, [{ type: 'web' }]);

    if (result.content.trim() === 'NO_CAPTIONS_AVAILABLE' || /\bNO_CAPTIONS_AVAILABLE\b/.test(result.content)) {
      throw new Error('No captions available for this YouTube video.');
    }
    return result;
  }

  private async liveSearchRequest(
    prompt: string,
    sources: Array<{ type: string }>,
  ): Promise<LiveSearchResult> {
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
          sources,
          return_citations: false,
        },
        max_tokens: 8192,
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
      throw new Error('xAI returned empty content.');
    }

    const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
    const title = firstLine.trim().slice(0, 80);

    return { title, content: content.trim() };
  }
}
