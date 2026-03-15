// src/telegram/webhook.ts
import { Bot, webhookCallback } from 'grammy';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { runCapturePipeline, type FileInput } from '../capture/pipeline.js';
import { insertReminder, completeReminder as dbCompleteReminder, findActiveReminders } from '../db/reminders.js';
import {
  handleTextMessage,
  handlePhotoMessage,
  handleRemindCommand,
  handleTodosCommand,
  handleDoneCommand,
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
      await ctx.reply('Usage: /remind <text>');
      return;
    }

    const embedding = await deps.embeddingProvider.embed(content);
    const result = await insertReminder(deps.db, {
      content,
      embedding,
      category: null, // Auto-determined later
      source: 'telegram',
      sourceContext: null,
      dueDate: null,
    });
    await ctx.reply(`Reminder created (${result.id.slice(0, 8)})`);
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
