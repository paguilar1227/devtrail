// src/telegram/webhook.ts
import { Bot, webhookCallback } from 'grammy';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { runCapturePipeline, type FileInput } from '../capture/pipeline.js';
import { insertReminder, completeReminder as dbCompleteReminder, findActiveReminders, getReminderById } from '../db/reminders.js';
import { insertComment } from '../db/reminder-comments.js';
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
    const text = await handleTodosCommand(async () =>
      reminders.map((r) => ({ id: r.id, content: r.content, status: r.status }))
    );
    await ctx.reply(text);
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

  // Message handlers (non-command text → capture)
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return; // Skip unhandled commands
    const result = await captureFn({
      content: ctx.message.text,
      files: [],
      source: 'telegram',
    });
    if (result.success) {
      await ctx.reply(`Captured! (${result.captureId?.slice(0, 8)})`);
    } else {
      await ctx.reply(`Skipped: ${result.reason}`);
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
