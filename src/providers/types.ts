// src/providers/types.ts

export interface EmbeddingProvider {
  /**
   * Generate an embedding vector from text and optional file buffers.
   * Files and text are embedded together into a single vector space.
   */
  embed(content: string, files?: Buffer[]): Promise<number[]>;

  /** Dimensionality of output vectors (3072 for Gemini Embedding 2) */
  readonly dimensions: number;
}

export interface LLMProvider {
  /**
   * Send a completion request to the LLM.
   * Returns the text content of the response.
   */
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContentPart[];
}

export interface LLMContentPart {
  type: 'text' | 'image';
  text?: string;
  data?: Buffer;
  mimeType?: string;
}

export interface LLMOptions {
  model?: string;
  systemPrompt?: string;
  responseFormat?: 'json' | 'text';
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
}
