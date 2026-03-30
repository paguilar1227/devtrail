// src/providers/gemini-llm.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from './types.js';
import { extractJson } from './json-utils.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

export class GeminiLLMProvider implements LLMProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const modelName = options?.model ?? DEFAULT_MODEL;
    const model = this.client.getGenerativeModel({
      model: modelName,
      ...(options?.systemPrompt && { systemInstruction: options.systemPrompt }),
      ...(options?.responseFormat === 'json' && {
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    const contents = messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: typeof msg.content === 'string'
        ? [{ text: msg.content }]
        : msg.content.map((part) =>
            part.type === 'text'
              ? { text: part.text! }
              : { inlineData: { data: part.data!.toString('base64'), mimeType: part.mimeType! } }
          ),
    }));

    const generationConfig: Record<string, unknown> = {};
    if (options?.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
    if (options?.responseFormat === 'json') generationConfig.responseMimeType = 'application/json';

    const result = await model.generateContent({
      contents,
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    });

    const usage = result.response.usageMetadata;
    let content = result.response.text();

    // Gemini 2.5 Flash often wraps JSON in markdown code blocks even when
    // responseMimeType is set to application/json. Strip the wrapping.
    if (options?.responseFormat === 'json') {
      content = extractJson(content);
    }

    return {
      content,
      tokensUsed: {
        input: usage?.promptTokenCount ?? 0,
        output: usage?.candidatesTokenCount ?? 0,
        total: usage?.totalTokenCount ?? 0,
      },
    };
  }
}

