// tests/unit/notifications/digest.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { ConsolidationLogRow } from '../../../src/db/consolidation-log.js';

describe('digest', () => {
  it('formats daily digest message', async () => {
    const { formatDailyDigest } = await import('../../../src/notifications/digest.js');
    const digest = formatDailyDigest({
      capturesProcessed: 8,
      factsCreated: 2,
      factsUpdated: 3,
      insightsCreated: 1,
      pendingReview: 3,
      activeReminders: 5,
      completedToday: 2,
    });

    expect(digest).toContain('8 captures');
    expect(digest).toContain('2');
    expect(digest).toContain('3 items need your review');
    expect(digest).toContain('/review');
    expect(digest).toContain('/todos');
  });

  it('sends digest via Telegram', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue({});
    const { sendDigestViaTelegram } = await import('../../../src/notifications/digest.js');

    await sendDigestViaTelegram(mockSendMessage, '123456', 'Test digest');
    expect(mockSendMessage).toHaveBeenCalledWith('123456', 'Test digest', expect.any(Object));
  });
});
