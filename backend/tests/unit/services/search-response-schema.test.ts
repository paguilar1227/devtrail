// tests/unit/services/search-response-schema.test.ts
//
// Regression: search hits from the lexical/graph arms carry no vector
// cosine `similarity` (it comes back null), but ChunkHitSchema declared
// `similarity: z.number()` — so the frontend's SearchResponseSchema.parse()
// threw a ZodError and the whole search surface errored out. `vector_score`
// was already nullable; `similarity` must be too. Surfaced when wiring the
// notes/docs drawers onto the real hybrid search.

import { describe, it, expect } from 'vitest';
import { ChunkHitSchema } from '@open-brain/shared';

const chunkHit = (similarity: number | null) => ({
  type: 'chunk' as const,
  similarity,
  final_score: 0.0317,
  retrieval_path: [{ step: 'lexical' }],
  chunk: {
    id: '11111111-1111-1111-1111-111111111111',
    content_item_id: '22222222-2222-2222-2222-222222222222',
    chunk_index: 0,
    chunk_type: 'text',
    content: 'a matched chunk',
    created_at: '2026-05-01T00:00:00.000Z',
    similarity,
    parent_type: 'note' as const,
    parent_title: 'A note',
    parent_project_ids: [],
    parent_tags: [],
    parent_source_url: null,
  },
});

describe('ChunkHitSchema — similarity nullable', () => {
  it('accepts a chunk hit with null similarity (lexical/graph-only, no vector score)', () => {
    expect(() => ChunkHitSchema.parse(chunkHit(null))).not.toThrow();
  });

  it('still accepts a numeric similarity (vector-matched hit)', () => {
    const parsed = ChunkHitSchema.parse(chunkHit(0.87));
    expect(parsed.similarity).toBe(0.87);
  });
});
