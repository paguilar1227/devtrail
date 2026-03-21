// src/telegram/webhook.ts
import { Bot } from 'grammy';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { runCapturePipeline, type FileInput } from '../capture/pipeline.js';
import { registerCommandHandlers } from './command-handlers.js';
import { registerNlRouter } from './nl-router.js';
import type { StateRefs } from './state.js';

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

  // Shared mutable state — passed by reference to all handler modules
  const stateRefs: StateRefs = {
    // Undo tracking — stores the last action per chat for reversal
    lastActions: new Map<string, { action: string; reminderId: string; previousState?: Record<string, unknown> }>(),
    // Todo number maps — stores number → reminder ID per chat for inline keyboard navigation
    todoNumberMaps: new Map<string, Map<number, string>>(),
    // Pending subtask state — tracks when user should next type a subtask for a parent
    pendingSubtask: new Map<string, { parentId: string; parentContent: string; parentProject: string | null; parentSection: string | null; depth: number }>(),
  };

  // Register all /command handlers and the callback_query handler
  registerCommandHandlers(bot, deps, stateRefs);

  // Register the NL intent router (message:text) and media handlers
  registerNlRouter(bot, deps, stateRefs, captureFn, downloadFile);

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
