// src/providers/anthropic-llm.ts
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from './types.js';

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 8192;

export class AnthropicLLMProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const anthropicMessages = messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((part) =>
            part.type === 'text'
              ? { type: 'text' as const, text: part.text! }
              : { type: 'image' as const, source: {
                  type: 'base64' as const,
                  media_type: (part.mimeType ?? 'image/png') as 'image/png',
                  data: part.data!.toString('base64'),
                } }
          ),
    }));

    const response = await this.client.messages.create({
      model: options?.model ?? DEFAULT_MODEL,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options?.systemPrompt && { system: options.systemPrompt }),
      messages: anthropicMessages,
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      content: textContent,
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        total: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }
}
