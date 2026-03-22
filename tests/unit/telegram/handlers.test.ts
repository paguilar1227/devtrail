// tests/unit/telegram/handlers.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('telegram handlers', () => {
  it('handles text message → calls capture pipeline', async () => {
    const mockPipeline = vi.fn().mockResolvedValue({ success: true, captureId: 'cap-1' });
    const { handleTextMessage } = await import('../../../src/telegram/handlers.js');

    const result = await handleTextMessage(
      { text: 'I love hiking in the mountains', chatId: '123' },
      mockPipeline,
    );

    expect(result.success).toBe(true);
    expect(mockPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'I love hiking in the mountains',
        source: ['telegram'],
      }),
    );
  });

  it('handles /remind command → creates reminder', async () => {
    const mockCreateReminder = vi.fn().mockResolvedValue({ id: 'rem-1' });
    const { handleRemindCommand } = await import('../../../src/telegram/handlers.js');

    const result = await handleRemindCommand(
      { text: '/remind Buy groceries tomorrow', chatId: '123' },
      mockCreateReminder,
    );

    expect(result.content).toBe('Buy groceries tomorrow');
    expect(mockCreateReminder).toHaveBeenCalled();
  });

  it('handles /todos command → lists active reminders', async () => {
    const mockList = vi.fn().mockResolvedValue([
      { id: 'r1', content: 'Buy groceries', status: 'not_started' },
    ]);
    const { handleTodosCommand } = await import('../../../src/telegram/handlers.js');

    const result = await handleTodosCommand(mockList);
    expect(result).toContain('Buy groceries');
  });

  it('handles /done command → completes reminder', async () => {
    const mockComplete = vi.fn().mockResolvedValue(undefined);
    const { handleDoneCommand } = await import('../../../src/telegram/handlers.js');

    await handleDoneCommand('rem-1', mockComplete);
    expect(mockComplete).toHaveBeenCalledWith('rem-1');
  });

  it('handles /comment command → adds progress comment', async () => {
    const mockAddComment = vi.fn().mockResolvedValue({ id: 'cmt-1' });
    const { handleCommentCommand } = await import('../../../src/telegram/handlers.js');

    const result = await handleCommentCommand(
      { text: '/comment rem-abc-123 Finished the auth module', chatId: '123' },
      mockAddComment,
    );

    expect(result.id).toBe('cmt-1');
    expect(result.reminderId).toBe('rem-abc-123');
    expect(result.content).toBe('Finished the auth module');
    expect(mockAddComment).toHaveBeenCalledWith('rem-abc-123', 'Finished the auth module', 'telegram');
  });

  it('/comment throws on missing text', async () => {
    const mockAddComment = vi.fn();
    const { handleCommentCommand } = await import('../../../src/telegram/handlers.js');

    await expect(
      handleCommentCommand({ text: '/comment rem-abc-123', chatId: '123' }, mockAddComment),
    ).rejects.toThrow('Usage:');
  });

  it('/comment throws when no id and text provided', async () => {
    const mockAddComment = vi.fn();
    const { handleCommentCommand } = await import('../../../src/telegram/handlers.js');

    await expect(
      handleCommentCommand({ text: '/comment', chatId: '123' }, mockAddComment),
    ).rejects.toThrow('Usage:');
  });

  it('handles photo message → downloads and captures', async () => {
    const mockPipeline = vi.fn().mockResolvedValue({ success: true, captureId: 'cap-1' });
    const mockDownload = vi.fn().mockResolvedValue(Buffer.from('photo bytes'));

    const { handlePhotoMessage } = await import('../../../src/telegram/handlers.js');
    const result = await handlePhotoMessage(
      { caption: 'My desk setup', fileId: 'abc123', chatId: '123' },
      mockPipeline,
      mockDownload,
    );

    expect(result.success).toBe(true);
    expect(mockDownload).toHaveBeenCalledWith('abc123');
  });
});
