// tests/unit/capture/dedup.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import type { DbClient } from '../../../src/db/client.js';

function mockDb(): DbClient {
  return { pool: {} as any, query: vi.fn(), transaction: vi.fn(), close: vi.fn() };
}

describe('dedup', () => {
  describe('computeFileHash', () => {
    it('returns SHA-256 hex digest of buffer', async () => {
      const { computeFileHash } = await import('../../../src/capture/dedup.js');
      const data = Buffer.from('test data');
      const hash = computeFileHash(data);
      const expected = createHash('sha256').update(data).digest('hex');
      expect(hash).toBe(expected);
    });
  });

  describe('checkFileHashDedup', () => {
    it('returns existing URLs for matching hashes', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ file_hashes: ['hash1'], file_urls: ['https://blob/file1.jpg'] }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { checkFileHashDedup } = await import('../../../src/capture/dedup.js');
      const result = await checkFileHashDedup(db, ['hash1', 'hash2']);

      expect(result.get('hash1')).toBe('https://blob/file1.jpg');
      expect(result.has('hash2')).toBe(false);
    });
  });

  describe('checkSemanticDedup', () => {
    it('returns true (duplicate) when similarity > 0.95', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ id: 'existing', similarity: 0.97 }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      });

      const { checkSemanticDedup } = await import('../../../src/capture/dedup.js');
      const result = await checkSemanticDedup(db, new Array(3072).fill(0.1));

      expect(result.isDuplicate).toBe(true);
      expect(result.similarity).toBe(0.97);
    });

    it('returns false when no captures exceed threshold', async () => {
      const db = mockDb();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [],
      });

      const { checkSemanticDedup } = await import('../../../src/capture/dedup.js');
      const result = await checkSemanticDedup(db, new Array(3072).fill(0.1));

      expect(result.isDuplicate).toBe(false);
    });
  });
});
