// src/providers/azure-foundry-responses.ts
//
// Azure Foundry client for the Responses API (`/openai/responses`).
// Required for GPT-5 reasoning-tier deployments like gpt-5-4-pro that
// don't expose chat completions.
//
// Implements the same LLMProvider interface as our chat-completions
// client so the RAG routing code doesn't care which tier is in use.

import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from './types.js';
import { extractJson } from './json-utils.js';

const DEFAULT_API_VERSION = '2025-04-01-preview';
const DEFAULT_MAX_TOKENS = 8192;

export interface AzureFoundryResponsesConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion?: string;
}

interface ResponsesInputItem {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
      >;
}

interface ResponsesAPIResult {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: string; message?: string };
}

export class AzureFoundryResponsesProvider implements LLMProvider {
  private endpoint: string;
  private apiKey: string;
  private defaultDeployment: string;
  private apiVersion: string;

  constructor(config: AzureFoundryResponsesConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.defaultDeployment = config.deployment;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const deployment = options?.model ?? this.defaultDeployment;
    const url = `${this.endpoint}/openai/responses?api-version=${this.apiVersion}`;

    const input: ResponsesInputItem[] = [];
    // Azure Responses API enforces: if text.format == json_object, the input
    // must literally contain the word "json" somewhere. Auto-append a system
    // instruction so callers don't have to think about it.
    const systemPieces = [options?.systemPrompt];
    if (options?.responseFormat === 'json') {
      systemPieces.push(
        'Respond with a single JSON value only. No markdown fences, no prose preamble.',
      );
    }
    const systemPrompt = systemPieces.filter(Boolean).join('\n\n');
    if (systemPrompt) {
      input.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of messages) {
      input.push({
        role: msg.role,
        content:
          typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((part) =>
                part.type === 'text'
                  ? { type: 'input_text' as const, text: part.text! }
                  : {
                      type: 'input_image' as const,
                      image_url: `data:${part.mimeType ?? 'image/png'};base64,${part.data!.toString('base64')}`,
                    },
              ),
      });
    }

    const body: Record<string, unknown> = {
      model: deployment,
      input,
      max_output_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (options?.responseFormat === 'json') {
      body.text = { format: { type: 'json_object' } };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Azure Responses ${res.status} (${deployment}): ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as ResponsesAPIResult;
    if (json.error) {
      throw new Error(`Azure Responses error: ${json.error.code ?? ''} ${json.error.message ?? ''}`.trim());
    }

    let content = json.output_text ?? extractTextFromOutputArray(json.output) ?? '';
    if (options?.responseFormat === 'json') {
      content = extractJson(content);
    }

    return {
      content,
      tokensUsed: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
        total: json.usage?.total_tokens ?? 0,
      },
    };
  }
}

/** Fallback extractor when `output_text` is not provided (older preview shapes). */
function extractTextFromOutputArray(
  output: ResponsesAPIResult['output'] | undefined,
): string | null {
  if (!output) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}
