import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return {
    pool: {} as any,
    query: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

describe('captures', () => {
  describe('insert', () => {
    it('inserts a capture with all fields', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1' }],
        command: 'INSERT', rowCount: 1, oid: 0, fields: [],
      });

      const { insertCapture } = await import('../../../src/db/captures.js');
      const result = await insertCapture(db, {
        content: 'I love TypeScript',
        contentTypes: ['text'],
        fileUrls: null,
        fileHashes: null,
        embedding: new Array(3072).fill(0.1),
        metadata: { people: [], topics: ['typescript'], action_items: [], dates: [], type: 'statement' },
        source: ['mcp'],
        tags: ['technology', 'programming'],
      });

      expect(result.id).toBe('uuid-1');
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO captures'),
        expect.arrayContaining(['I love TypeScript', ['mcp'], ['technology', 'programming']]),
      );
    });
  });

  describe('findByStatus', () => {
    it('returns captures with given status', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', content: 'test', status: 'pending' }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { findCapturesByStatus } = await import('../../../src/db/captures.js');
      const results = await findCapturesByStatus(db, 'pending');

      expect(results).toHaveLength(1);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("status = $1"),
        ['pending'],
      );
    });
  });

  describe('updateStatus', () => {
    it('updates capture status and updated_at', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', status: 'consolidated' }],
        command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
      });

      const { updateCaptureStatus } = await import('../../../src/db/captures.js');
      await updateCaptureStatus(db, 'uuid-1', 'consolidated');

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE captures'),
        expect.arrayContaining(['consolidated', 'uuid-1']),
      );
    });
  });

  describe('findSimilar', () => {
    it('finds captures by embedding similarity', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', content: 'similar', similarity: 0.96 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { findSimilarCaptures } = await import('../../../src/db/captures.js');
      const embedding = new Array(3072).fill(0.1);
      const results = await findSimilarCaptures(db, embedding, 0.95);

      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBe(0.96);
    });
  });

  describe('setArchived', () => {
    it('sets archived flag', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', archived: true }],
        command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
      });

      const { setCaptureArchived } = await import('../../../src/db/captures.js');
      await setCaptureArchived(db, 'uuid-1', true);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('archived'),
        expect.arrayContaining([true, 'uuid-1']),
      );
    });
  });

  describe('updateCaptureTags', () => {
    it('updates tags and returns the new tag array', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ tags: ['technology', 'productivity'] }],
        command: 'UPDATE', rowCount: 1, oid: 0, fields: [],
      });

      const { updateCaptureTags } = await import('../../../src/db/captures.js');
      const result = await updateCaptureTags(db, 'uuid-1', ['technology', 'productivity']);

      expect(result).toEqual(['technology', 'productivity']);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE captures SET tags'),
        [['technology', 'productivity'], 'uuid-1'],
      );
    });

    it('returns null when capture not found', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [],
      });

      const { updateCaptureTags } = await import('../../../src/db/captures.js');
      const result = await updateCaptureTags(db, 'nonexistent', ['tag']);

      expect(result).toBeNull();
    });
  });
});
