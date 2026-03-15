// tests/unit/capture/metadata.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '../../../src/providers/types.js';

function mockLLM(): LLMProvider {
  return { complete: vi.fn() };
}

describe('metadata extraction', () => {
  it('extracts structured metadata from text content', async () => {
    const llm = mockLLM();
    const response: LLMResponse = {
      content: JSON.stringify({
        people: ['Alice'],
        topics: ['cooking', 'italian food'],
        action_items: [],
        dates: [],
        type: 'preference',
      }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    };
    vi.mocked(llm.complete).mockResolvedValueOnce(response);

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Alice taught me to make pasta. I love Italian food.');

    expect(metadata.people).toContain('Alice');
    expect(metadata.topics).toContain('italian food');
    expect(metadata.type).toBe('preference');
  });

  it('handles LLM returning invalid JSON gracefully', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: 'not valid json',
      tokensUsed: { input: 50, output: 10, total: 60 },
    });

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Some content');

    expect(metadata.people).toEqual([]);
    expect(metadata.topics).toEqual([]);
    expect(metadata.type).toBe('unknown');
  });
});
