// src/telegram/webhook.ts
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { runCapturePipeline, type FileInput } from '../capture/pipeline.js';
import { insertReminder, completeReminder as dbCompleteReminder, findActiveReminders, getReminderById, updateReminder, deleteReminder, findRemindersDueOnDate, findOverdueReminders } from '../db/reminders.js';
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

Return ONLY valid JSON.`,
          responseFormat: 'json',
          maxTokens: 256,
        },
      );
      parsed = JSON.parse(parseResponse.content);
    } catch {
      // Fallback: use raw text, no structured fields
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
      parsed.dueDate ? `due: ${parsed.dueDate.split('T')[0]}` : null,
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

    const text = formatRemindersMarkdown(reminders);

    // Build inline keyboard — one row per top-level task with Done + Pause buttons
    const keyboard = new InlineKeyboard();
    for (const r of reminders) {
      if (r.depth === 0) {
        const label = r.content.length > 30 ? r.content.slice(0, 27) + '…' : r.content;
        keyboard
          .text(`✓ ${label}`, `done:${r.id}`)
          .text(`⏸ ${label}`, `pause:${r.id}`)
          .row();
      }
    }

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

    if (action === 'done') {
      await dbCompleteReminder(deps.db, reminderId);
      await ctx.answerCallbackQuery({ text: 'Marked as done ✓' });
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ''}\n\n✓ Task marked done.`);
    } else if (action === 'pause') {
      await updateReminder(deps.db, reminderId, { status: 'paused' });
      await ctx.answerCallbackQuery({ text: 'Paused ⏸' });
      await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ''}\n\n⏸ Task paused.`);
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
      const details = [
        intent.project ? `project: ${intent.project}` : null,
        intent.priority,
        intent.dueDate ? `due: ${intent.dueDate.split('T')[0]}` : null,
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
      const formatted = header + formatRemindersMarkdown(reminders);
      const keyboard = new InlineKeyboard();
      for (const r of reminders) {
        if (r.depth === 0) {
          const label = r.content.length > 30 ? r.content.slice(0, 27) + '…' : r.content;
          keyboard.text(`✓ ${label}`, `done:${r.id}`).text(`⏸ ${label}`, `pause:${r.id}`).row();
        }
      }
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
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const result = await handlePhotoMessage(
      { caption: ctx.message.caption ?? null, fileId: largest.file_id, chatId: String(ctx.chat.id) },
      captureFn,
      downloadFile,
    );
    await ctx.reply(result.success ? `Photo captured! (${result.captureId?.slice(0, 8)})` : `Skipped: ${result.reason}`);
  });

  bot.on('message:voice', async (ctx) => {
    const result = await handleVoiceMessage(
      { fileId: ctx.message.voice.file_id, chatId: String(ctx.chat.id) },
      captureFn,
      downloadFile,
      async (audio) => {
        // Use Gemini Flash to transcribe + summarize audio
        const response = await deps.metadataLLM.complete(
          [{ role: 'user', content: [{ type: 'text', text: 'Transcribe and summarize this voice message.' }, { type: 'image', data: audio, mimeType: 'audio/ogg' }] }],
        );
        return response.content;
      },
    );
    await ctx.reply(result.success ? `Voice captured! (${result.captureId?.slice(0, 8)})` : `Skipped: ${result.reason}`);
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const result = await handleDocumentMessage(
      { fileId: doc.file_id, fileName: doc.file_name ?? 'document', mimeType: doc.mime_type ?? 'application/octet-stream', chatId: String(ctx.chat.id) },
      captureFn,
      downloadFile,
      async (fileBuffer, mimeType) => {
        const response = await deps.metadataLLM.complete(
          [{ role: 'user', content: [{ type: 'text', text: `Summarize this ${mimeType} document.` }, { type: 'image', data: fileBuffer, mimeType }] }],
        );
        return response.content;
      },
    );
    await ctx.reply(result.success ? `Document captured! (${result.captureId?.slice(0, 8)})` : `Skipped: ${result.reason}`);
  });

  // TODO: Media group handling — Telegram sends media groups as separate messages
  // with the same media_group_id. Requires batching messages with a short timeout
  // (e.g., 500ms) to collect all items before processing as a single capture.
  // Deferred to implementation — requires stateful message buffering.

  // Register webhook route
  app.post('/telegram/webhook', async (c) => {
    console.log(`[telegram] webhook route hit`);
    // Verify webhook secret
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== deps.config.telegramWebhookSecret) {
      return c.json({ error: 'Invalid secret' }, 403);
    }

    const handler = webhookCallback(bot, 'std/http');
    return handler(c.req.raw);
  });

  return bot;
}
