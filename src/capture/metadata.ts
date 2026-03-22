// src/capture/metadata.ts
import type { LLMProvider } from '../providers/types.js';
import { validateTags } from './tags.js';

export interface CaptureMetadata {
  people: string[];
  topics: string[];
  action_items: string[];
  dates: string[];
  type: string;
  tags: string[];
}

const EXTRACTION_PROMPT = `Extract structured metadata from the following text. Return JSON with these fields:
- people: array of person names mentioned
- topics: array of topics/subjects discussed
- action_items: array of tasks or things to do mentioned
- dates: array of dates or time references mentioned
- type: one of "statement", "preference", "experience", "question", "action", "reflection", "unknown"
- tags: array of applicable semantic tags from this list (select ALL that apply, empty array if none clearly apply):
  - preference: how the person likes things done
  - decision: a choice made with rationale
  - problem-solution: a problem encountered and how it was resolved
  - pattern: a recurring behavior or habit observed over time
  - goal: an aspiration, target, or planned direction
  - opinion: a stance or belief with reasoning
  - skill: a capability or expertise level
  - relationship: knowledge about a specific person
  - resource: a tool, link, article, or reference worth recalling
  - idea: an uncommitted exploration or possibility
  - interest: a hobby, passion, or thing enjoyed
  - health: medical, fitness, dietary, or wellness information
  - dislike: something to avoid or never suggest
  - milestone: a significant achievement or turning point

Return ONLY valid JSON, no markdown formatting.`;

const FALLBACK_METADATA: CaptureMetadata = {
  people: [],
  topics: [],
  action_items: [],
  dates: [],
  type: 'unknown',
  tags: [],
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
      tags: validateTags(Array.isArray(parsed.tags) ? parsed.tags : []),
    };
  } catch {
    return FALLBACK_METADATA;
  }
}
