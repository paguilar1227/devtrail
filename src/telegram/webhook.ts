// src/telegram/webhook.ts
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { runCapturePipeline, type FileInput } from '../capture/pipeline.js';
import { insertReminder, completeReminder as dbCompleteReminder, findActiveReminders, getReminderById, updateReminder, deleteReminder, findRemindersDueOnDate, findOverdueReminders } from '../db/reminders.js';
import type { ReminderRow } from '../db/reminders.js';
import { insertComment, deleteComment } from '../db/reminder-comments.js';
import {
  handleTextMessage,
  handlePhotoMessage,
  handleRemindCommand,
  handleTodosCommand,
  handleDoneCommand,
  handleCommentCommand,
  handleVoiceMessage,
  handleDocumentMessage,
} from './handlers.js';
import { formatRemindersMarkdown } from '../notifications/format-reminders.js';

export function setupTelegramWebhook(app: Hono, deps: AppDeps): Bot {
  const bot = new Bot(deps.config.telegramBotToken);

  const captureFn = async (input: { content: string; files: FileInput[]; source: string }) => {
    return runCapturePipeline({
      db: deps.db,
      embeddingProvider: deps.embeddingProvider,
      metadataLLM: deps.metadataLLM,
      blobStorage: deps.blobStorage,
      ...input,
    });
  };

  const downloadFile = async (fileId: string): Promise<Buffer> => {
    const file = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${deps.config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    return Buffer.from(await response.arrayBuffer());
  };

  // Undo tracking — stores the last action per chat for reversal
  const lastActions = new Map<string, { action: string; reminderId: string; previousState?: Record<string, unknown> }>();

  // Todo number maps — stores number → reminder ID per chat for inline keyboard navigation
  const todoNumberMaps = new Map<string, Map<number, string>>();

  /** Build a numbered todos keyboard + formatted text, storing the number map for the given chat. */
  function buildTodosMessage(chatId: string, reminders: ReminderRow[]): { text: string; keyboard: InlineKeyboard } {
    const numMap = new Map<number, string>();
    todoNumberMaps.set(chatId, numMap);

    // Build numbered text by prepending numbers to top-level tasks
    const numberedReminders = reminders.map((r) => {
      if (r.depth === 0) {
        const n = numMap.size + 1;
        numMap.set(n, r.id);
        return { ...r, content: `${n}. ${r.content}` };
      }
      return r;
    });

    const text = formatRemindersMarkdown(numberedReminders);

    const keyboard = new InlineKeyboard();
    for (const [n] of numMap) {
      const remId = numMap.get(n)!;
      const rem = reminders.find((r) => r.id === remId);
      if (!rem || rem.status === 'done' || rem.status === 'cancelled') continue;
      keyboard.text(`✓ ${n}`, `done:${remId}`).text(`⏸ ${n}`, `pause:${remId}`).row();
    }

    return { text, keyboard };
  }

  // Command handlers
  bot.command('remind', async (ctx) => {
    const text = ctx.message?.text ?? '';
    const content = text.replace(/^\/remind\s+/, '').trim();
    if (!content) {
      await ctx.reply('Usage: /remind <text>\nExamples:\n  /remind Buy groceries\n  /remind [project:meals] Research high-protein recipes P1\n  /remind Fix login bug by Friday [project:work, section:backend]');
      return;
    }

    // Use LLM to parse natural language into structured fields
    let parsed: { content: string; project: string | null; section: string | null; priority: string | null; category: string | null; dueDate: string | null };
    try {
      const parseResponse = await deps.metadataLLM.complete(
        [{ role: 'user', content }],
        {
          systemPrompt: `Parse this reminder text into structured fields. Extract any project, section, priority, category, and due date mentioned naturally or via tags like [project:name].

TODAY'S DATE: ${new Date().toISOString().split('T')[0]} (${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: deps.config.timezone }).format(new Date())})
USER TIMEZONE: ${deps.config.timezone}

When resolving relative dates like "next Wednesday", "tomorrow", "Friday", use TODAY'S DATE above as reference. Always return full ISO 8601 datetime strings with the correct year. If a time is specified, include it. If only a date, use T00:00:00Z.

For relative time expressions like "in 1 minute", "in 30 minutes", "in 2 hours", compute the exact UTC datetime by adding the offset to TODAY'S DATE and current time (assume current time is approximately now). Return the full ISO 8601 datetime string.

Return JSON:
{
  "content": "the clean task text without tags or metadata",
  "project": "project name or null",
  "section": "section name or null",
  "priority": "P1 or P2 or P3 or null",
  "category": "work|personal|health|learning|finance|social or null",
  "dueDate": "ISO 8601 date string or null"
}

Examples:
- "[project:meals] Research high-protein recipes P1" → {"content":"Research high-protein recipes","project":"meals","section":null,"priority":"P1","category":"health","dueDate":null}
- "Fix login bug by 2026-03-20 [project:work, section:backend]" → {"content":"Fix login bug","project":"work","section":"backend","priority":null,"category":"work","dueDate":"2026-03-20T00:00:00Z"}
- "Buy groceries" → {"content":"Buy groceries","project":null,"section":null,"priority":null,"category":"personal","dueDate":null}
- "Call dentist in 30 minutes" → {"content":"Call dentist","project":null,"section":null,"priority":null,"category":"health","dueDate":"<NOW + 30min as ISO 8601>"}
- "Check oven in 1 hour" → {"content":"Check oven","project":null,"section":null,"priority":null,"category":"personal","dueDate":"<NOW + 1hr as ISO 8601>"}

Return ONLY valid JSON.`,
          responseFormat: 'json',
          maxTokens: 256,
        },
      );
      parsed = JSON.parse(parseResponse.content);
    } catch (err) {
      // Fallback: use raw text, no structured fields
      console.error('[remind-parser] LLM parse failed:', err);
      parsed = { content, project: null, section: null, priority: null, category: null, dueDate: null };
    }

    const embedding = await deps.embeddingProvider.embed(parsed.content);
    const result = await insertReminder(deps.db, {
      content: parsed.content,
      embedding,
      category: parsed.category,
      project: parsed.project,
      section: parsed.section,
      parentId: null,
      depth: 0,
      priority: parsed.priority,
      source: 'telegram',
      sourceContext: null,
      dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
    });

    // Build confirmation with parsed details
    const details = [
      parsed.project ? `project: ${parsed.project}` : null,
      parsed.section ? `section: ${parsed.section}` : null,
      parsed.priority ? parsed.priority : null,
      parsed.dueDate ? `due: ${(() => {
        const d = new Date(parsed.dueDate!);
        const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: deps.config.timezone });
        const hasTime = !parsed.dueDate!.endsWith('T00:00:00Z') && !parsed.dueDate!.endsWith('T00:00:00.000Z');
        return hasTime ? `${date} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: deps.config.timezone })}` : date;
      })()}` : null,
    ].filter(Boolean);
    const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
    await ctx.reply(`Reminder created${detailStr} (${result.id.slice(0, 8)})`);
  });

  bot.command('todos', async (ctx) => {
    const reminders = await findActiveReminders(deps.db);

    if (reminders.length === 0) {
      await ctx.reply('No active reminders.');
      return;
    }

    const chatId = String(ctx.chat.id);
    const { text, keyboard } = buildTodosMessage(chatId, reminders);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const colonIdx = data.indexOf(':');
    if (colonIdx === -1) {
      await ctx.answerCallbackQuery({ text: 'Unknown action' });
      return;
    }
    const action = data.slice(0, colonIdx);
    const reminderId = data.slice(colonIdx + 1);
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id ?? '');

    if (action === 'done') {
      await dbCompleteReminder(deps.db, reminderId);
      await ctx.answerCallbackQuery({ text: 'Marked as done ✓' });
      // Re-render the full list with updated statuses
      const reminders = await findActiveReminders(deps.db);
      if (reminders.length === 0) {
        await ctx.editMessageText('All done! No active reminders.');
      } else {
        const { text, keyboard } = buildTodosMessage(chatId, reminders);
        await ctx.editMessageText(text, { reply_markup: keyboard });
      }
    } else if (action === 'pause') {
      await updateReminder(deps.db, reminderId, { status: 'paused' });
      await ctx.answerCallbackQuery({ text: 'Paused ⏸' });
      // Re-render the full list with updated statuses
      const reminders = await findActiveReminders(deps.db);
      if (reminders.length === 0) {
        await ctx.editMessageText('No active reminders.');
      } else {
        const { text, keyboard } = buildTodosMessage(chatId, reminders);
        await ctx.editMessageText(text, { reply_markup: keyboard });
      }
    } else {
      await ctx.answerCallbackQuery({ text: 'Unknown action' });
    }
  });

  bot.command('done', async (ctx) => {
    const id = (ctx.message?.text ?? '').replace(/^\/done\s+/, '').trim();
    if (!id) {
      await ctx.reply('Usage: /done <reminder-id>');
      return;
    }
    await dbCompleteReminder(deps.db, id);
    await ctx.reply('Reminder completed!');
  });

  bot.command('comment', async (ctx) => {
    const text = ctx.message?.text ?? '';
    try {
      const result = await handleCommentCommand(
        { text, chatId: String(ctx.chat.id) },
        async (reminderId, content, source) => {
          const reminder = await getReminderById(deps.db, reminderId);
          if (!reminder) throw new Error(`Reminder ${reminderId} not found`);
          const embedding = await deps.embeddingProvider.embed(content);
          return insertComment(deps.db, { content, embedding, reminderId, source });
        },
      );
      await ctx.reply(`Comment added to ${result.reminderId.slice(0, 8)} (${result.id.slice(0, 8)})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await ctx.reply(message);
    }
  });

  bot.command('review', async (ctx) => {
    // Placeholder — will be implemented in Task 29 (notifications/review)
    await ctx.reply('Review feature coming soon.');
  });

  // Natural language router — classify intent before acting
  bot.on('message:text', async (ctx) => {
    console.log(`[telegram] message:text handler hit: "${ctx.message.text}"`);
    if (ctx.message.text.startsWith('/')) return; // Skip unhandled commands
    const text = ctx.message.text;
    const chatId = String(ctx.chat.id);

    // Fast-path: undo last action without hitting the LLM
    if (text.toLowerCase().trim() === 'undo') {
      const last = lastActions.get(chatId);
      if (!last) {
        await ctx.reply('Nothing to undo.');
        return;
      }
      try {
        if (last.action === 'create') {
          await deleteReminder(deps.db, last.reminderId);
          await ctx.reply(`↩️ Undone: deleted the reminder (${last.reminderId.slice(0, 8)})`);
        } else if (last.action === 'complete') {
          const prev = last.previousState ?? {};
          await updateReminder(deps.db, last.reminderId, { status: (prev.status as string) ?? 'not_started' });
          await ctx.reply(`↩️ Undone: restored reminder status to ${(prev.status as string) ?? 'not_started'} (${last.reminderId.slice(0, 8)})`);
        } else if (last.action === 'update') {
          const prev = last.previousState ?? {};
          await updateReminder(deps.db, last.reminderId, {
            status: prev.status as string | undefined,
            priority: prev.priority as string | null | undefined,
            project: prev.project as string | null | undefined,
          });
          await ctx.reply(`↩️ Undone: restored reminder to previous state (${last.reminderId.slice(0, 8)})`);
        } else if (last.action === 'comment') {
          await deleteComment(deps.db, last.reminderId); // reminderId holds the commentId for this action
          await ctx.reply(`↩️ Undone: removed the comment (${last.reminderId.slice(0, 8)})`);
        } else {
          await ctx.reply('Cannot undo that action.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await ctx.reply(`Undo failed: ${msg}`);
      }
      lastActions.delete(chatId);
      return;
    }

    // Use LLM to classify intent
    let intent: { action: string; content?: string; project?: string; section?: string; priority?: string; category?: string; dueDate?: string; taskSearch?: string; status?: string; dueFilter?: string };
    try {
      console.log(`[intent-classifier] Input: "${text}"`);
      const classifyResponse = await deps.metadataLLM.complete(
        [{ role: 'user', content: text }],
        {
          systemPrompt: `You are an intent classifier for a personal assistant. The user sent a message. Determine if it's a task/reminder action or a thought to capture.

TODAY'S DATE: ${new Date().toISOString().split('T')[0]} (${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: deps.config.timezone }).format(new Date())})
USER TIMEZONE: ${deps.config.timezone}

When resolving relative dates like "next Wednesday", "tomorrow", "Friday", use TODAY'S DATE above as reference. Always return full ISO 8601 datetime strings with the correct year.

For relative time expressions like "in 1 minute", "in 30 minutes", "in 2 hours", compute the exact UTC datetime by adding the offset to today's current time. Return the full ISO 8601 datetime string.

Return JSON with one of these actions:

{"action": "create_reminder", "content": "clean task text", "project": "project or null", "section": "section or null", "priority": "P1|P2|P3 or null", "category": "work|personal|health|learning|finance|social or null", "dueDate": "ISO date or null"}
  Triggers: "add", "remind me", "I need to", "todo", "don't forget", "put on my list", "task:", creating any kind of task or reminder

{"action": "list_reminders", "project": "filter by project or null", "status": "filter by status or null", "dueFilter": "today|overdue|this_week or null"}
  Triggers: "what are my todos", "show my tasks", "what am I working on", "my reminders", "what's on my plate", "what's due today", "show overdue tasks", "due this week"

{"action": "complete_reminder", "taskSearch": "description of which task to complete"}
  Triggers: "mark X as done", "finished X", "completed X", "done with X", "X is done"

{"action": "update_reminder", "taskSearch": "description of which task", "status": "new status or null", "priority": "new priority or null", "project": "move to project or null"}
  Triggers: "change X to", "pause X", "block X", "move X to", "set priority of X"

{"action": "add_comment", "taskSearch": "description of which task", "content": "the comment text"}
  Triggers: "update on X:", "note on X:", "progress on X:", "regarding X:"

{"action": "undo"}
  Triggers: "undo", "undo that", "take that back", "reverse that", "nevermind"

{"action": "capture_thought"}
  Default — anything that isn't a task action. Personal observations, opinions, experiences, preferences, feelings, information sharing.

IMPORTANT: Lean toward capture_thought for ambiguous cases. Only classify as a task action if the intent is clear. "I love pizza" is a thought. "Add buy pizza to my list" is a task.

Return ONLY valid JSON.`,
          responseFormat: 'json',
          maxTokens: 256,
        },
      );
      intent = JSON.parse(classifyResponse.content);
      console.log(`[intent-classifier] Result: ${JSON.stringify(intent)}`);
    } catch (err) {
      // If classification fails, default to capture
      console.error(`[intent-classifier] Failed:`, err);
      intent = { action: 'capture_thought' };
    }

    const INTENT_PREFIX = '🤖 Interpreted as';
    const UNDO_HINT = '\n↩️ Wrong? Say "undo" or reply with what you meant.';

    if (intent.action === 'create_reminder') {
      const taskContent = intent.content ?? text;
      const embedding = await deps.embeddingProvider.embed(taskContent);
      const result = await insertReminder(deps.db, {
        content: taskContent,
        embedding,
        category: intent.category ?? null,
        project: intent.project ?? null,
        section: intent.section ?? null,
        parentId: null,
        depth: 0,
        priority: intent.priority ?? null,
        source: 'telegram',
        sourceContext: null,
        dueDate: intent.dueDate ? new Date(intent.dueDate) : null,
      });
      const formatDue = (iso: string) => {
        const d = new Date(iso);
        const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: deps.config.timezone });
        const hasTime = !iso.endsWith('T00:00:00Z') && !iso.endsWith('T00:00:00.000Z');
        if (hasTime) {
          const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: deps.config.timezone });
          return `${date} at ${time}`;
        }
        return date;
      };
      const details = [
        intent.project ? `project: ${intent.project}` : null,
        intent.priority,
        intent.dueDate ? `due: ${formatDue(intent.dueDate)}` : null,
      ].filter(Boolean);
      const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
      lastActions.set(chatId, { action: 'create', reminderId: result.id });
      await ctx.reply(`${INTENT_PREFIX} new reminder.\nCreated: "${taskContent}"${detailStr} (${result.id.slice(0, 8)})${UNDO_HINT}`);

    } else if (intent.action === 'list_reminders') {
      let reminders;
      let header = '';
      if (intent.dueFilter === 'today') {
        reminders = await findRemindersDueOnDate(deps.db, new Date(), deps.config.timezone);
        header = '📅 *Due Today*\n';
      } else if (intent.dueFilter === 'overdue') {
        reminders = await findOverdueReminders(deps.db);
        header = '🔴 *Overdue*\n';
      } else if (intent.dueFilter === 'this_week') {
        // Get reminders due in the next 7 days
        const now = new Date();
        const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const { listReminders } = await import('../db/reminders.js');
        reminders = await listReminders(deps.db, { due_before: weekEnd, due_after: now });
        header = '📅 *Due This Week*\n';
      } else {
        reminders = await findActiveReminders(deps.db);
      }
      if (reminders.length === 0) {
        await ctx.reply(intent.dueFilter ? `No ${intent.dueFilter === 'overdue' ? 'overdue' : 'due'} reminders.` : 'No active reminders.');
        return;
      }
      const { text: todosText, keyboard } = buildTodosMessage(chatId, reminders);
      const formatted = header + todosText;
      await ctx.reply(formatted, { reply_markup: keyboard });

    } else if (intent.action === 'complete_reminder') {
      // Search for the task by description
      const reminders = await findActiveReminders(deps.db);
      const search = (intent.taskSearch ?? '').toLowerCase();
      const match = reminders.find((r) => r.content.toLowerCase().includes(search));
      if (match) {
        lastActions.set(chatId, { action: 'complete', reminderId: match.id, previousState: { status: match.status } });
        await dbCompleteReminder(deps.db, match.id);
        await ctx.reply(`${INTENT_PREFIX} task completion.\n✓ Done: "${match.content}" (${match.id.slice(0, 8)})${UNDO_HINT}`);
      } else {
        await ctx.reply(`Couldn't find a matching task for "${intent.taskSearch}". Try /todos to see your list.`);
      }

    } else if (intent.action === 'update_reminder') {
      const reminders = await findActiveReminders(deps.db);
      const search = (intent.taskSearch ?? '').toLowerCase();
      const match = reminders.find((r) => r.content.toLowerCase().includes(search));
      if (match) {
        lastActions.set(chatId, { action: 'update', reminderId: match.id, previousState: { status: match.status, priority: match.priority, project: match.project } });
        await updateReminder(deps.db, match.id, {
          status: intent.status,
          priority: intent.priority ?? undefined,
          project: intent.project ?? undefined,
          dueDate: intent.dueDate ? new Date(intent.dueDate) : undefined,
        });
        const changes = [intent.status, intent.priority, intent.project ? `→ ${intent.project}` : null].filter(Boolean).join(', ');
        await ctx.reply(`${INTENT_PREFIX} task update.\nUpdated: "${match.content}" (${changes})${UNDO_HINT}`);
      } else {
        await ctx.reply(`Couldn't find a matching task for "${intent.taskSearch}". Try /todos to see your list.`);
      }

    } else if (intent.action === 'add_comment') {
      const reminders = await findActiveReminders(deps.db);
      const search = (intent.taskSearch ?? '').toLowerCase();
      const match = reminders.find((r) => r.content.toLowerCase().includes(search));
      if (match && intent.content) {
        const embedding = await deps.embeddingProvider.embed(intent.content);
        const commentResult = await insertComment(deps.db, { content: intent.content, embedding, reminderId: match.id, source: 'telegram' });
        lastActions.set(chatId, { action: 'comment', reminderId: commentResult.id });
        await ctx.reply(`${INTENT_PREFIX} comment on task.\nAdded to "${match.content}": "${intent.content}"${UNDO_HINT}`);
      } else {
        await ctx.reply(`Couldn't find a matching task for "${intent.taskSearch}".`);
      }

    } else if (intent.action === 'undo') {
      // LLM-classified undo — reuse the fast-path logic
      const last = lastActions.get(chatId);
      if (!last) {
        await ctx.reply('Nothing to undo.');
      } else {
        try {
          if (last.action === 'create') {
            await deleteReminder(deps.db, last.reminderId);
            await ctx.reply(`↩️ Undone: deleted the reminder (${last.reminderId.slice(0, 8)})`);
          } else if (last.action === 'complete') {
            const prev = last.previousState ?? {};
            await updateReminder(deps.db, last.reminderId, { status: (prev.status as string) ?? 'not_started' });
            await ctx.reply(`↩️ Undone: restored reminder status to ${(prev.status as string) ?? 'not_started'} (${last.reminderId.slice(0, 8)})`);
          } else if (last.action === 'update') {
            const prev = last.previousState ?? {};
            await updateReminder(deps.db, last.reminderId, {
              status: prev.status as string | undefined,
              priority: prev.priority as string | null | undefined,
              project: prev.project as string | null | undefined,
            });
            await ctx.reply(`↩️ Undone: restored reminder to previous state (${last.reminderId.slice(0, 8)})`);
          } else if (last.action === 'comment') {
            await deleteComment(deps.db, last.reminderId);
            await ctx.reply(`↩️ Undone: removed the comment (${last.reminderId.slice(0, 8)})`);
          } else {
            await ctx.reply('Cannot undo that action.');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await ctx.reply(`Undo failed: ${msg}`);
        }
        lastActions.delete(chatId);
      }

    } else {
      // Default: capture as thought
      const result = await captureFn({ content: text, files: [], source: 'telegram' });
      if (result.success) {
        await ctx.reply(`Captured! (${result.captureId?.slice(0, 8)})`);
      } else {
        await ctx.reply(`Skipped: ${result.reason}`);
      }
    }
  });

  bot.on('message:photo', async (ctx) => {
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const result = await handlePhotoMessage(
        { caption: ctx.message.caption ?? null, fileId: largest.file_id, chatId: String(ctx.chat.id) },
        captureFn,
        downloadFile,
      );
      const photoWarnings = result.warnings?.length ? `\n⚠️ ${result.warnings.join('\n⚠️ ')}` : '';
      await ctx.reply(result.success ? `Photo captured! (${result.captureId?.slice(0, 8)})${photoWarnings}` : `Skipped: ${result.reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Photo handler error: ${msg}`, err);
      await ctx.reply(`Error processing photo: ${msg}`).catch(() => {});
    }
  });

  bot.on('message:voice', async (ctx) => {
    try {
      const result = await handleVoiceMessage(
        { fileId: ctx.message.voice.file_id, chatId: String(ctx.chat.id) },
        captureFn,
        downloadFile,
        async (audio) => {
          const response = await deps.metadataLLM.complete(
            [{ role: 'user', content: [{ type: 'text', text: 'Transcribe and summarize this voice message.' }, { type: 'image', data: audio, mimeType: 'audio/ogg' }] }],
          );
          return response.content;
        },
      );
      const voiceWarnings = result.warnings?.length ? `\n⚠️ ${result.warnings.join('\n⚠️ ')}` : '';
      await ctx.reply(result.success ? `Voice captured! (${result.captureId?.slice(0, 8)})${voiceWarnings}` : `Skipped: ${result.reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Voice handler error: ${msg}`, err);
      await ctx.reply(`Error processing voice message: ${msg}`).catch(() => {});
    }
  });

  bot.on('message:document', async (ctx) => {
    try {
      const doc = ctx.message.document;
      // Infer MIME type from extension if Telegram gives us a generic one
      console.log(`[telegram] Document: name=${doc.file_name}, telegram_mime=${doc.mime_type}`);
      let docMimeType = doc.mime_type ?? 'application/octet-stream';
      if (docMimeType === 'application/octet-stream' && doc.file_name) {
        const ext = doc.file_name.split('.').pop()?.toLowerCase();
        const mimeMap: Record<string, string> = {
          pdf: 'application/pdf',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          mp4: 'video/mp4',
          mp3: 'audio/mpeg',
          wav: 'audio/wav',
          ogg: 'audio/ogg',
          txt: 'text/plain',
          csv: 'text/csv',
          json: 'application/json',
          doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          html: 'text/html',
          htm: 'text/html',
          xml: 'text/xml',
          md: 'text/markdown',
          rtf: 'application/rtf',
          xls: 'application/vnd.ms-excel',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ppt: 'application/vnd.ms-powerpoint',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          zip: 'application/zip',
        };
        if (ext && mimeMap[ext]) docMimeType = mimeMap[ext];
      }
      const result = await handleDocumentMessage(
        { fileId: doc.file_id, fileName: doc.file_name ?? 'document', mimeType: docMimeType, chatId: String(ctx.chat.id) },
        captureFn,
        downloadFile,
        async (fileBuffer, mimeType) => {
          // Gemini-supported binary types for inline data
          const geminiSupported = new Set([
            'application/pdf',
            'image/png', 'image/jpeg',
            'audio/mpeg', 'audio/wav',
            'video/mp4', 'video/quicktime',
          ]);
          // Text-based types we can read as UTF-8
          const textTypes = new Set([
            'text/html', 'text/plain', 'text/csv', 'text/xml', 'text/markdown',
            'application/json', 'application/rtf',
          ]);

          if (geminiSupported.has(mimeType)) {
            const response = await deps.metadataLLM.complete(
              [{ role: 'user', content: [{ type: 'text', text: `Summarize this ${mimeType} document.` }, { type: 'image', data: fileBuffer, mimeType }] }],
            );
            return response.content;
          } else if (textTypes.has(mimeType)) {
            const textContent = fileBuffer.toString('utf-8').slice(0, 30000);
            const response = await deps.metadataLLM.complete(
              [{ role: 'user', content: `Summarize this document:\n\n${textContent}` }],
              { maxTokens: 1024 },
            );
            return response.content;
          } else {
            // Unsupported — notify user, skip summarization, use filename as content
            console.warn(`[telegram] Unsupported MIME type for summarization: ${mimeType} (file: ${doc.file_name})`);
            await ctx.reply(`⚠️ MIME type "${mimeType}" is not supported for summarization. File will be stored but not summarized. Let me know so this type can be added.`);
            return `[Unsummarized document: ${doc.file_name ?? 'unknown'} (${mimeType})]`;
          }
        },
      );
      const docWarnings = result.warnings?.length ? `\n⚠️ ${result.warnings.join('\n⚠️ ')}` : '';
      await ctx.reply(result.success ? `Document captured! (${result.captureId?.slice(0, 8)})${docWarnings}` : `Skipped: ${result.reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Document handler error: ${msg}`, err);
      await ctx.reply(`Error processing document: ${msg}`).catch(() => {});
    }
  });

  // TODO: Media group handling — Telegram sends media groups as separate messages
  // with the same media_group_id. Requires batching messages with a short timeout
  // (e.g., 500ms) to collect all items before processing as a single capture.
  // Deferred to implementation — requires stateful message buffering.

  // Initialize bot info (required for bot.handleUpdate)
  bot.init().catch((err) => console.error('[telegram] Bot init failed:', err));

  // Global error handler — grammY wraps errors in BotError, extract the cause
  bot.catch((err) => {
    const cause = err.error;
    console.error(`[telegram] Handler error for update ${err.ctx?.update?.update_id}:`, cause);
    // Try to reply to the user
    err.ctx?.reply?.(`Error: ${cause instanceof Error ? cause.message : String(cause)}`).catch(() => {});
  });

  // Dedup guard — track recently processed update IDs to prevent retry loops.
  // Telegram retries if we don't respond within its timeout (~60s).
  // We respond 200 immediately and process in the background, but if a retry
  // still arrives, this set ensures we don't process the same update twice.
  const processedUpdates = new Set<number>();
  const MAX_PROCESSED_CACHE = 1000;

  // Register webhook route
  app.post('/telegram/webhook', async (c) => {
    // Verify webhook secret
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== deps.config.telegramWebhookSecret) {
      return c.json({ error: 'Invalid secret' }, 403);
    }

    // Parse the update to check for duplicates
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: true });
    }

    const updateId = body?.update_id;
    if (updateId && processedUpdates.has(updateId)) {
      console.log(`[telegram] Skipping duplicate update_id: ${updateId}`);
      return c.json({ ok: true }); // Respond 200 so Telegram stops retrying
    }

    if (updateId) {
      processedUpdates.add(updateId);
      // Evict old entries to prevent unbounded memory growth
      if (processedUpdates.size > MAX_PROCESSED_CACHE) {
        const oldest = processedUpdates.values().next().value;
        if (oldest !== undefined) processedUpdates.delete(oldest);
      }
    }

    // Process in the background — respond 200 immediately to prevent Telegram retries
    // The bot handlers send replies directly via the Telegram API, so they don't need
    // the webhook response.
    bot.handleUpdate(body).catch((err) => {
      console.error(`[telegram] Error processing update ${updateId}:`, err);
    });

    return c.json({ ok: true });
  });

  return bot;
}
