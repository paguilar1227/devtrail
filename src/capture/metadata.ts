// src/capture/metadata.ts
import type { LLMProvider } from '../providers/types.js';

export interface CaptureMetadata {
  people: string[];
  topics: string[];
  action_items: string[];
  dates: string[];
  type: string;
}

const EXTRACTION_PROMPT = `Extract structured metadata from the following text. Return JSON with these fields:
- people: array of person names mentioned
- topics: array of topics/subjects discussed
- action_items: array of tasks or things to do mentioned
- dates: array of dates or time references mentioned
- type: one of "statement", "preference", "experience", "question", "action", "reflection", "unknown"

Return ONLY valid JSON, no markdown formatting.`;

const FALLBACK_METADATA: CaptureMetadata = {
  people: [],
  topics: [],
  action_items: [],
  dates: [],
  type: 'unknown',
};

export async function extractMetadata(
  llm: LLMProvider,
  content: string,
): Promise<CaptureMetadata> {
  try {
    const response = await llm.complete(
      [{ role: 'user', content }],
      {
        systemPrompt: EXTRACTION_PROMPT,
        responseFormat: 'json',
        maxTokens: 1024,
      },
    );

    const parsed = JSON.parse(response.content);
    return {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
      type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
    };
  } catch {
    return FALLBACK_METADATA;
  }
}
