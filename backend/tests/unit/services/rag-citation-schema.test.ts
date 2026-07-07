// tests/unit/services/rag-citation-schema.test.ts
//
// Regression: ragQuery built citations with `content_item_id` +
// `chunk_preview` but the wire contract (RagCitationSchema) requires `id`,
// `content_item_id`, `title`, `excerpt`. The frontend Zod-parses the REST
// response, so every cited answer failed validation and the Chat tab
// rendered "Error: Response failed validation" instead of the answer —
// in production too, not just stub mode. Surfaced by the PCHAT-2 e2e.
// This pins the hit → citation mapping against the shared schema for both
// hit kinds, including the lexical-only null-similarity shape.

import { describe, it, expect } from 'vitest';
import { RagCitationSchema } from '@open-brain/shared';
import { hitToCitation } from '../../../src/services/rag.js';

const chunkHit = {
  type: 'chunk' as const,
  retrieval_path: [{ step: 'vector' as const, score: 0.82 }],
  chunk: {
    id: '11111111-1111-1111-1111-111111111111',
    content_item_id: '22222222-2222-2222-2222-222222222222',
    parent_title: 'Session model notes',
    parent_type: 'note',
    content: 'Claude Code multiplexes sessions over a single control socket…',
    similarity: 0.82,
    parent_source_url: null,
  },
};

const todoHit = {
  type: 'todo' as const,
  retrieval_path: [{ step: 'lexical' as const, score: 1 }],
  todo: {
    id: '33333333-3333-3333-3333-333333333333',
    content: 'Wire SSE reconnect backoff',
    status: 'in_progress',
    due_date: null,
    similarity: null, // lexical-only hit — no vector signal
  },
};

describe('hitToCitation → RagCitationSchema conformance', () => {
  it('chunk hit maps to a schema-valid citation (id + excerpt present)', () => {
    const citation = hitToCitation(chunkHit);
    expect(citation).not.toBeNull();
    const parsed = RagCitationSchema.parse(citation);
    expect(parsed.id).toBe(chunkHit.chunk.id);
    expect(parsed.content_item_id).toBe(chunkHit.chunk.content_item_id);
    expect(parsed.excerpt).toContain('multiplexes sessions');
    // Entity kind must survive the schema parse — the Chat tab's
    // "Open source" uses it to pick the surface to open.
    expect(parsed.type).toBe('note');
  });

  it('todo hit maps to a schema-valid citation (todo id doubles as content_item_id)', () => {
    const citation = hitToCitation(todoHit);
    expect(citation).not.toBeNull();
    const parsed = RagCitationSchema.parse(citation);
    expect(parsed.id).toBe(todoHit.todo.id);
    expect(parsed.content_item_id).toBe(todoHit.todo.id);
    expect(parsed.excerpt).toContain('in_progress');
    expect(parsed.type).toBe('todo');
  });

  it('null-content chunk still yields a string excerpt', () => {
    const citation = hitToCitation({
      ...chunkHit,
      chunk: { ...chunkHit.chunk, content: null },
    });
    const parsed = RagCitationSchema.parse(citation);
    expect(parsed.excerpt).toBe('');
  });
});
