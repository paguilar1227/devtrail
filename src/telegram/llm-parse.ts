// src/telegram/llm-parse.ts
import type { AppDeps } from '../app.js';

/** Call LLM and parse JSON response with retry on non-JSON flakes */
export async function llmJsonParse<T>(
  llm: AppDeps['metadataLLM'],
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: { systemPrompt: string; responseFormat: 'json'; maxTokens: number },
  label: string,
  retries = 3,
): Promise<T | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await llm.complete(messages, options);
      return JSON.parse(response.content) as T;
    } catch (err) {
      if (attempt === retries - 1) {
        console.error(`[${label}] Failed after ${retries} attempts:`, err);
        return null;
      }
    }
  }
  return null;
}
