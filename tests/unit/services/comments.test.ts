import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbClient } from '../../../src/db/client.js';
import type { EmbeddingProvider } from '../../../src/providers/types.js';
import type { ServiceDeps } from '../../../src/services/index.js';

// ---- Helpers ----------------------------------------------------------------

function mockDb(): DbClient {
  return {
    pool: {} as any,
    query: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
    dimensions: 3072,
  };
}

function makeQueryResult(rows: unknown[], rowCount = rows.length) {
  return { rows, rowCount, command: 'SELECT', oid: 0, fields: [] } as any;
}

function makeDeps(overrides?: Partial<ServiceDeps>): ServiceDeps {
  return {
    db: mockDb(),
    embeddingProvider: mockEmbeddingProvider(),
    metadataLLM: {} as any,
    consolidationLLM: {} as any,
    retrievalLLM: {} as any,
    blobStorage: {} as any,
    config: {} as any,
    ...overrides,
  };
}

// ---- Sample data ------------------------------------------------------------

const REMINDER_ID = 'aaaa0000-0000-0000-0000-000000000001';
const COMMENT_ID  = 'bbbb0000-0000-0000-0000-000000000002';

const sampleReminder = {
  id: REMINDER_ID,
  content: 'Deploy v2',
  depth: 0,
  status: 'not_started',
};

const sampleComment = {
  id: COMMENT_ID,
  content: 'Blocked on Azure credentials',
  embedding: new Array(3072).fill(0.1),
  reminder_id: REMINDER_ID,
  source: 'mcp',
  created_at: new Date('2026-03-21T14:30:00Z'),
};

// ---- Tests ------------------------------------------------------------------

describe('comments service', () => {
  describe('addComment', () => {
    it('embeds content and inserts comment when reminder exists', async () => {
      const deps = makeDeps();
      // getReminderById: returns the reminder
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([sampleReminder]));
      // insertComment: returns new comment id
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([{ id: COMMENT_ID }]));

      const { addComment } = await import('../../../src/services/comments.js');
      const result = await addComment(deps, REMINDER_ID, 'Blocked on Azure credentials', 'mcp');

      expect(result.id).toBe(COMMENT_ID);
      expect(deps.embeddingProvider.embed).toHaveBeenCalledWith('Blocked on Azure credentials');
      // Second db.query should be the INSERT
      const secondCall = vi.mocked(deps.db.query).mock.calls[1];
      expect(secondCall[0]).toContain('INSERT INTO reminder_comments');
    });

    it('throws when reminder does not exist', async () => {
      const deps = makeDeps();
      // getReminderById: returns nothing
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([]));

      const { addComment } = await import('../../../src/services/comments.js');
      await expect(addComment(deps, REMINDER_ID, 'Some text', 'mcp'))
        .rejects.toThrow(`Reminder ${REMINDER_ID} not found`);

      expect(deps.embeddingProvider.embed).not.toHaveBeenCalled();
    });
  });

  describe('listComments', () => {
    it('returns comments in ascending chronological order', async () => {
      const deps = makeDeps();
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([sampleComment]));

      const { listComments } = await import('../../../src/services/comments.js');
      const results = await listComments(deps, REMINDER_ID);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(COMMENT_ID);
      const [sql, params] = vi.mocked(deps.db.query).mock.calls[0];
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(params).toContain(REMINDER_ID);
    });

    it('returns empty array when reminder has no comments', async () => {
      const deps = makeDeps();
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([]));

      const { listComments } = await import('../../../src/services/comments.js');
      const results = await listComments(deps, REMINDER_ID);

      expect(results).toEqual([]);
    });
  });

  describe('getComment', () => {
    it('returns the comment when found', async () => {
      const deps = makeDeps();
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([sampleComment]));

      const { getComment } = await import('../../../src/services/comments.js');
      const result = await getComment(deps, COMMENT_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(COMMENT_ID);
    });

    it('returns null when comment does not exist', async () => {
      const deps = makeDeps();
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([]));

      const { getComment } = await import('../../../src/services/comments.js');
      const result = await getComment(deps, COMMENT_ID);

      expect(result).toBeNull();
    });
  });

  describe('updateComment', () => {
    it('re-embeds and updates comment when it exists', async () => {
      const deps = makeDeps();
      // getCommentById: returns the comment
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([sampleComment]));
      // updateComment: UPDATE statement
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([], 1));

      const { updateComment } = await import('../../../src/services/comments.js');
      await updateComment(deps, COMMENT_ID, 'Got the creds, deploying now');

      expect(deps.embeddingProvider.embed).toHaveBeenCalledWith('Got the creds, deploying now');
      const updateCall = vi.mocked(deps.db.query).mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE reminder_comments');
      expect(updateCall[1]).toContain('Got the creds, deploying now');
    });

    it('throws when comment does not exist', async () => {
      const deps = makeDeps();
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([]));

      const { updateComment } = await import('../../../src/services/comments.js');
      await expect(updateComment(deps, COMMENT_ID, 'new text'))
        .rejects.toThrow(`Comment ${COMMENT_ID} not found`);

      expect(deps.embeddingProvider.embed).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('returns the deleted comment and removes it from DB', async () => {
      const deps = makeDeps();
      // getCommentById: returns the comment
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([sampleComment]));
      // deleteComment: DELETE statement
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([], 1));

      const { deleteComment } = await import('../../../src/services/comments.js');
      const deleted = await deleteComment(deps, COMMENT_ID);

      expect(deleted.id).toBe(COMMENT_ID);
      expect(deleted.content).toBe('Blocked on Azure credentials');
      const deleteCall = vi.mocked(deps.db.query).mock.calls[1];
      expect(deleteCall[0]).toContain('DELETE FROM reminder_comments');
      expect(deleteCall[1]).toContain(COMMENT_ID);
    });

    it('throws when comment does not exist', async () => {
      const deps = makeDeps();
      vi.mocked(deps.db.query).mockResolvedValueOnce(makeQueryResult([]));

      const { deleteComment } = await import('../../../src/services/comments.js');
      await expect(deleteComment(deps, COMMENT_ID))
        .rejects.toThrow(`Comment ${COMMENT_ID} not found`);
    });
  });
});
