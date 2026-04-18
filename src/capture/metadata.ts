import type { LLMProvider, LLMMessage } from '../providers/types.js';

export interface CaptureMetadata {
  title: string;           // auto-generated concise title
  topics: string[];
  tags: string[];
  extracted_text: string | null;
}

export interface FileInput {
  data: Buffer;
  mimeType: string;
}

const EXTRACTION_PROMPT = `You analyze a piece of content (text, and optionally attached media) and produce structured metadata for a personal knowledge base.

Return JSON with these fields:
- title: a short, descriptive title (max 80 chars) capturing the essence of the content. For media files, describe what they show. Never return an empty title.
- topics: array of topics/subjects discussed (max 10)
- tags: array of flat organizational labels (max 5). Examples: "reference", "meeting-notes", "recipe", "coding", "research". Use lowercase kebab-case. These are flexible — pick what would help the user find this later.
- extracted_text: if media files contain clearly legible text (documents, signs, whiteboards, printed/handwritten text, PDFs, captions in images), extract ALL of it verbatim. For audio/video, transcribe speech. Return null if media doesn't contain readable text (photos of people, animals, scenery, food, objects, etc.). Do NOT hallucinate text that isn't clearly there.

Return ONLY valid JSON, no markdown formatting.`;

const FALLBACK: CaptureMetadata = {
  title: 'Untitled',
  topics: [],
  tags: [],
  extracted_text: null,
};

export async function extractMetadata(
  llm: LLMProvider,
  content: string,
  files?: FileInput[],
): Promise<CaptureMetadata> {
  const fileCount = files?.length ?? 0;
  const mimeTypes = files?.map((f) => f.mimeType).join(', ') ?? 'none';
  console.log(`[metadata] Extracting — files: ${fileCount} (${mimeTypes}), content: ${content.length} chars`);

  try {
    const messageContent: LLMMessage['content'] = files && files.length > 0
      ? [
          { type: 'text' as const, text: content || '(no text content)' },
          ...files.map((f) => ({
            type: 'image' as const,
            data: f.data,
            mimeType: f.mimeType,
          })),
        ]
      : content;

    // Flash 2.5 uses internal "thinking" tokens that count against the output
    // budget. For PDF-scale inputs (50K chars) the model needs room to both
    // think and emit large extracted_text fields — 2048 was truncating mid-JSON.
    const response = await llm.complete(
      [{ role: 'user', content: messageContent }],
      { systemPrompt: EXTRACTION_PROMPT, responseFormat: 'json', maxTokens: 8192 },
    );

    console.log(`[metadata] LLM response — tokens: ${response.tokensUsed.total}, raw length: ${response.content.length}`);

    let parsed: any;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      console.error(`[metadata] JSON parse failed — first 500 chars: ${response.content.slice(0, 500)}`);
      console.error(`[metadata] JSON parse failed — last 200 chars: ${response.content.slice(-200)}`);
      return FALLBACK;
    }

    const extractedText = typeof parsed.extracted_text === 'string' && parsed.extracted_text.trim()
      ? parsed.extracted_text.trim()
      : null;
    const title = typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 120)
      : 'Untitled';

    const result: CaptureMetadata = {
      title,
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 10) : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5).map((t: any) => String(t).toLowerCase()) : [],
      extracted_text: extractedText,
    };

    console.log(`[metadata] Result — title: "${result.title}", tags: [${result.tags.join(', ')}], extracted_text: ${extractedText ? `${extractedText.length} chars` : 'null'}`);
    return result;
  } catch (err) {
    console.error(`[metadata] Extraction failed:`, err);
    return FALLBACK;
  }
}
