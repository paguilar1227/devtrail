// src/capture/metadata.ts
import type { LLMProvider, LLMMessage } from '../providers/types.js';
import { validateTags } from './tags.js';

export interface CaptureMetadata {
  people: string[];
  topics: string[];
  action_items: string[];
  dates: string[];
  type: string;
  tags: string[];
  extracted_text: string | null;
}

const EXTRACTION_PROMPT = `Extract structured metadata from the following content. If media files (images, PDFs, audio, video) are attached, analyze them too — extract any visible text, describe key content, and incorporate into your metadata.

Return JSON with these fields:
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
- extracted_text: if media files are present, extract ALL readable text (OCR for images, full text for PDFs, transcription for audio/video). Return null if no media or no text found in media. This should be the raw text content, not a summary.

Return ONLY valid JSON, no markdown formatting.`;

const FALLBACK_METADATA: CaptureMetadata = {
  people: [],
  topics: [],
  action_items: [],
  dates: [],
  type: 'unknown',
  tags: [],
  extracted_text: null,
};

export interface FileInput {
  data: Buffer;
  mimeType: string;
}

export async function extractMetadata(
  llm: LLMProvider,
  content: string,
  files?: FileInput[],
): Promise<CaptureMetadata> {
  const fileCount = files?.length ?? 0;
  const mimeTypes = files?.map((f) => f.mimeType).join(', ') ?? 'none';
  console.log(`[metadata] Extracting metadata — files: ${fileCount} (${mimeTypes}), content length: ${content.length}`);

  try {
    // Build multimodal message when files are present
    const messageContent: LLMMessage['content'] = files && files.length > 0
      ? [
          { type: 'text' as const, text: content },
          ...files.map((f) => ({
            type: 'image' as const,
            data: f.data,
            mimeType: f.mimeType,
          })),
        ]
      : content;

    const response = await llm.complete(
      [{ role: 'user', content: messageContent }],
      {
        systemPrompt: EXTRACTION_PROMPT,
        responseFormat: 'json',
        maxTokens: 2048,
      },
    );

    console.log(`[metadata] LLM response — tokens: ${response.tokensUsed.total}, raw length: ${response.content.length}`);

    let parsed: any;
    try {
      parsed = JSON.parse(response.content);
    } catch (parseErr) {
      console.error(`[metadata] JSON parse failed — raw response (first 500): ${response.content.slice(0, 500)}`);
      return FALLBACK_METADATA;
    }
    const extractedText = typeof parsed.extracted_text === 'string' && parsed.extracted_text.trim()
      ? parsed.extracted_text.trim()
      : null;

    const result: CaptureMetadata = {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
      type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
      tags: validateTags(Array.isArray(parsed.tags) ? parsed.tags : []),
      extracted_text: extractedText,
    };

    console.log(`[metadata] Result — type: ${result.type}, tags: [${result.tags.join(', ')}], topics: [${result.topics.join(', ')}], people: [${result.people.join(', ')}], extracted_text: ${extractedText ? `${extractedText.length} chars — "${extractedText.slice(0, 150)}${extractedText.length > 150 ? '...' : ''}"` : 'null'}`);
    return result;
  } catch (err) {
    console.error(`[metadata] Extraction failed — files: ${fileCount}, error:`, err);
    return FALLBACK_METADATA;
  }
}
