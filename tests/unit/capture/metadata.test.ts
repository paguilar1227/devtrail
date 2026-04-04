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

  it('returns tags from LLM classification', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        people: [], topics: ['typescript'], action_items: [], dates: [],
        type: 'preference', tags: ['preference', 'skill'],
      }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    });
    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Pedro strongly prefers TypeScript.');
    expect(metadata.tags).toEqual(['preference', 'skill']);
  });

  it('returns empty tags array when LLM returns none', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        people: [], topics: [], action_items: [], dates: [], type: 'unknown',
      }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    });
    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'test');
    expect(metadata.tags).toEqual([]);
  });

  it('validates tags against allowlist in metadata response', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        people: [], topics: [], action_items: [], dates: [],
        type: 'preference', tags: ['preference', 'invalid_tag', 'skill'],
      }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    });
    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Some content');
    expect(metadata.tags).toEqual(['preference', 'skill']);
    expect(metadata.tags).not.toContain('invalid_tag');
  });

  it('returns empty tags on LLM error', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockRejectedValueOnce(new Error('LLM failed'));
    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Content');
    expect(metadata.tags).toEqual([]);
    expect(metadata.extracted_text).toBeNull();
  });

  it('sends files as multimodal content parts to LLM', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        people: [], topics: ['whiteboard'], action_items: ['Review design'],
        dates: [], type: 'action', tags: ['resource'],
        extracted_text: 'Architecture diagram: API → Service → DB',
      }),
      tokensUsed: { input: 200, output: 80, total: 280 },
    });

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const files = [{ data: Buffer.from('img-bytes'), mimeType: 'image/jpeg' }];
    const metadata = await extractMetadata(llm, 'Whiteboard photo', files);

    // Verify LLM received multimodal content (array of parts, not plain string)
    const callArgs = vi.mocked(llm.complete).mock.calls[0];
    const messageContent = callArgs[0][0].content;
    expect(Array.isArray(messageContent)).toBe(true);
    const parts = messageContent as any[];
    expect(parts[0]).toEqual({ type: 'text', text: 'Whiteboard photo' });
    expect(parts[1].type).toBe('image');
    expect(parts[1].data).toEqual(Buffer.from('img-bytes'));
    expect(parts[1].mimeType).toBe('image/jpeg');

    // Verify extracted_text is returned
    expect(metadata.extracted_text).toBe('Architecture diagram: API → Service → DB');
    expect(metadata.topics).toContain('whiteboard');
  });

  it('returns extracted_text from LLM response for media files', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        people: [], topics: ['grocery list'], action_items: [],
        dates: [], type: 'statement', tags: [],
        extracted_text: 'Milk\nEggs\nBread\nButter',
      }),
      tokensUsed: { input: 150, output: 60, total: 210 },
    });

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Shopping list photo', [
      { data: Buffer.from('photo'), mimeType: 'image/png' },
    ]);

    expect(metadata.extracted_text).toBe('Milk\nEggs\nBread\nButter');
  });

  it('returns null extracted_text when LLM returns empty string', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        people: [], topics: [], action_items: [], dates: [],
        type: 'statement', tags: [], extracted_text: '  ',
      }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    });

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Some image', [
      { data: Buffer.from('img'), mimeType: 'image/jpeg' },
    ]);

    expect(metadata.extracted_text).toBeNull();
  });

  it('returns null extracted_text when no files provided', async () => {
    const llm = mockLLM();
    vi.mocked(llm.complete).mockResolvedValueOnce({
      content: JSON.stringify({
        people: [], topics: [], action_items: [], dates: [],
        type: 'statement', tags: [],
      }),
      tokensUsed: { input: 50, output: 30, total: 80 },
    });

    const { extractMetadata } = await import('../../../src/capture/metadata.js');
    const metadata = await extractMetadata(llm, 'Just text');

    // No files → plain string message, no extracted_text field → null
    const callArgs = vi.mocked(llm.complete).mock.calls[0];
    expect(typeof callArgs[0][0].content).toBe('string');
    expect(metadata.extracted_text).toBeNull();
  });
});
