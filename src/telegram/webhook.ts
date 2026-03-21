// src/telegram/webhook.ts
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { runCapturePipeline, type FileInput } from '../capture/pipeline.js';
import { insertReminder, completeReminder as dbCompleteReminder, findActiveReminders, findAllReminders, getReminderById, updateReminder, deleteReminder, findRemindersDueOnDate, findOverdueReminders, findSubtasks, resolveReminderId } from '../db/reminders.js';
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
import { formatRemindersMarkdown, formatSingleReminder } from '../notifications/format-reminders.js';
import { buildIntentClassifierPrompt, buildReminderParserPrompt } from './prompts.js';
import { resolveMimeType, getSummarizationRoute } from './mime-utils.js';

/** Call LLM and parse JSON response with retry on non-JSON flakes */
async function llmJsonParse<T>(
  llm: AppDeps['metadataLLM'],
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: { systemPrompt: string; responseFormat: 'json'; maxTokens: number },
  label: string,
  retries = 3,
): Promise<T | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await llm.complete(messages, options);
      return JSON.parse(response.content) as T;
    } catch (err) {
      if (attempt === retries - 1) {
        console.error(`[${label}] Failed after ${retries} attempts:`, err);
        return null;
      }
    }
  }
  return null;
}

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

  // Pending subtask state — tracks when user should next type a subtask for a parent
  const pendingSubtask = new Map<string, { parentId: string; parentContent: string; parentProject: string | null; parentSection: string | null; depth: number }>();

  /** Build a numbered todos keyboard + formatted text, storing the number map for the given chat. */
  async function buildTodosMessage(chatId: string, reminders: ReminderRow[]): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const numMap = new Map<number, string>();
    todoNumberMaps.set(chatId, numMap);

    // Assign numbers to top-level tasks (the formatter will use them)
    let n = 0;
    for (const r of reminders) {
      if (r.depth === 0) {
        n++;
        numMap.set(n, r.id);
      }
    }

    // Build subtask map: parentId → children
    const subtasksMap = new Map<string, ReminderRow[]>();
    for (const r of reminders) {
      if (r.depth === 0) {
        const children = await findSubtasks(deps.db, r.id);
        if (children.length > 0) {
          subtasksMap.set(r.id, children);
          // Also fetch grandchildren for each child
          for (const child of children) {
            const grandchildren = await findSubtasks(deps.db, child.id);
            if (grandchildren.length > 0) {
              subtasksMap.set(child.id, grandchildren);
            }
          }
        }
      }
    }

    const text = formatRemindersMarkdown(reminders, subtasksMap);

    const keyboard = new InlineKeyboard();
    // Status cycle: not_started → in_progress → paused → blocked → not_started (loops)
    // Done is excluded — use the dedicated ✓ button for that.
    const cycleNextStatus: Record<string, { label: string; next: string }> = {
      not_started: { label: '●', next: 'in_progress' },
      in_progress:  { label: '⏸', next: 'paused' },
      paused:       { label: '🚫', next: 'blocked' },
      blocked:      { label: '○', next: 'not_started' },
    };
    for (const [num] of numMap) {
      const remId = numMap.get(num)!;
      const rem = reminders.find((r) => r.id === remId);
      if (!rem || rem.status === 'done' || rem.status === 'cancelled') continue;
      const cycle = cycleNextStatus[rem.status];
      if (cycle) {
        keyboard.text(`✓ ${num}`, `done:${remId}`).text(`${cycle.label} ${num}`, `cycle:${remId}`).row();
      } else {
        keyboard.text(`✓ ${num}`, `done:${remId}`).row();
      }
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

    // Use LLM to parse natural language into structured fields (with retry)
    const remindTodayISO = new Date().toISOString().split('T')[0];
    const remindDayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: deps.config.timezone }).format(new Date());
    const parsed = await llmJsonParse<{ content: string; project: string | null; section: string | null; priority: string | null; category: string | null; dueDate: string | null }>(
      deps.metadataLLM,
      [{ role: 'user', content }],
      { systemPrompt: buildReminderParserPrompt(remindTodayISO, remindDayOfWeek, deps.config.timezone), responseFormat: 'json', maxTokens: 1024 },
      'remind-parser',
    ) ?? { content, project: null, section: null, priority: null, category: null, dueDate: null };

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

    // Build formatted confirmation showing the reminder as it will appear
    const createdReminder: ReminderRow = {
      id: result.id,
      content: parsed.content,
      embedding: [],
      metadata: null,
      category: parsed.category,
      project: parsed.project,
      section: parsed.section,
      parent_id: null,
      depth: 0,
      status: 'not_started',
      priority: parsed.priority,
      source_context: null,
      source: 'telegram',
      archived: false,
      due_date: parsed.dueDate ? new Date(parsed.dueDate) : null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const projectLine = parsed.project
      ? `\n  📋 ${parsed.project}${parsed.section ? ` / ${parsed.section}` : ''}`
      : '';
    const chatId = String(ctx.chat.id);
    lastActions.set(chatId, { action: 'create', reminderId: result.id });
    await ctx.reply(`Reminder created.\n  ${formatSingleReminder(createdReminder)}${projectLine}`);
  });

  bot.command('todos', async (ctx) => {
    const reminders = await findActiveReminders(deps.db);

    if (reminders.length === 0) {
      await ctx.reply('No active reminders.');
      return;
    }

    const chatId = String(ctx.chat.id);
    const { text, keyboard } = await buildTodosMessage(chatId, reminders);
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
      const { completed } = await dbCompleteReminder(deps.db, reminderId);
      const subtaskCount = completed.length - 1;
      const doneText = subtaskCount > 0 ? `Marked as done ✓ (+ ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'})` : 'Marked as done ✓';
      await ctx.answerCallbackQuery({ text: doneText });
      // Re-render the full list with updated statuses
      const reminders = await findActiveReminders(deps.db);
      if (reminders.length === 0) {
        await ctx.editMessageText('All done! No active reminders.');
      } else {
        const { text, keyboard } = await buildTodosMessage(chatId, reminders);
        await ctx.editMessageText(text, { reply_markup: keyboard });
      }
    } else if (action === 'cycle') {
      // Advance to next status in the cycle (loops, done excluded)
      const cycleMap: Record<string, string> = {
        not_started: 'in_progress',
        in_progress: 'paused',
        paused: 'blocked',
        blocked: 'not_started',
      };
      const cycleLabels: Record<string, string> = {
        in_progress: 'In progress ●',
        paused: 'Paused ⏸',
        blocked: 'Blocked 🚫',
        not_started: 'Not started ○',
      };
      const current = await getReminderById(deps.db, reminderId);
      if (!current) { await ctx.answerCallbackQuery({ text: 'Reminder not found' }); return; }
      const nextStatus = cycleMap[current.status];
      if (!nextStatus) { await ctx.answerCallbackQuery({ text: 'Already done' }); return; }
      await updateReminder(deps.db, reminderId, { status: nextStatus });
      await ctx.answerCallbackQuery({ text: cycleLabels[nextStatus] ?? nextStatus });
      // Re-render the full list with updated statuses
      const cycleReminders = await findActiveReminders(deps.db);
      if (cycleReminders.length === 0) {
        await ctx.editMessageText('No active reminders.');
      } else {
        const { text, keyboard } = await buildTodosMessage(chatId, cycleReminders);
        await ctx.editMessageText(text, { reply_markup: keyboard });
      }
    } else if (action === 'subtask') {
      // Subtask selection — show parent + existing subtasks, prompt for new subtask text
      const parent = await getReminderById(deps.db, reminderId);
      if (!parent) { await ctx.answerCallbackQuery({ text: 'Reminder not found' }); return; }
      if (parent.depth >= 3) { await ctx.answerCallbackQuery({ text: 'Max subtask depth reached (4 levels)' }); return; }

      const existingSubtasks = await findSubtasks(deps.db, reminderId);
      let text = `Adding subtask to:\n  ${formatSingleReminder(parent)}\n`;
      if (existingSubtasks.length > 0) {
        text += '\nExisting subtasks:\n';
        for (const st of existingSubtasks) {
          text += `    ${formatSingleReminder(st)}\n`;
        }
      }
      text += '\nType your subtask below:';

      // Track pending subtask state
      pendingSubtask.set(chatId, { parentId: reminderId, parentContent: parent.content, parentProject: parent.project, parentSection: parent.section, depth: parent.depth + 1 });

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text);

      // Show buttons for existing subtasks (for sub-subtask creation)
      if (existingSubtasks.length > 0 && existingSubtasks[0].depth < 3) {
        const subKeyboard = new InlineKeyboard();
        for (const st of existingSubtasks) {
          const label = st.content.length > 30 ? st.content.slice(0, 27) + '...' : st.content;
          subKeyboard.text(`➕ ${label}`, `subtask:${st.id}`).row();
        }
        await ctx.reply('Or add a sub-subtask:', { reply_markup: subKeyboard });
      }
    } else {
      await ctx.answerCallbackQuery({ text: 'Unknown action' });
    }
  });

  bot.command('done', async (ctx) => {
    const rawId = (ctx.message?.text ?? '').replace(/^\/done\s+/, '').trim();
    if (!rawId) {
      await ctx.reply('Usage: /done <reminder-id>');
      return;
    }
    const fullId = await resolveReminderId(deps.db, rawId);
    if (!fullId) {
      await ctx.reply(`No reminder found matching "${rawId}". Use /todos to see IDs.`);
      return;
    }
    const { completed } = await dbCompleteReminder(deps.db, fullId);
    const subtaskCount = completed.length - 1;
    const subtaskSuffix = subtaskCount > 0 ? ` (+ ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'})` : '';
    await ctx.reply(`✓ Reminder completed!${subtaskSuffix} (${fullId.slice(0, 8)})`);
  });

  bot.command('delete', async (ctx) => {
    const rawId = (ctx.message?.text ?? '').replace(/^\/delete\s+/, '').trim();
    if (!rawId) {
      await ctx.reply('Usage: /delete <reminder-id>');
      return;
    }
    const fullId = await resolveReminderId(deps.db, rawId);
    if (!fullId) {
      await ctx.reply(`No reminder found matching "${rawId}". Use /todos to see IDs.`);
      return;
    }
    const reminder = await getReminderById(deps.db, fullId);
    const chatId = String(ctx.chat.id);
    lastActions.set(chatId, { action: 'create', reminderId: fullId }); // undo will try to re-create, but delete is destructive — undo just notifies
    await deleteReminder(deps.db, fullId);
    await ctx.reply(`🗑 Deleted: "${reminder?.content ?? fullId}" (${fullId.slice(0, 8)}) and all subtasks/comments.`);
  });

  bot.command('edit', async (ctx) => {
    const text = (ctx.message?.text ?? '').replace(/^\/edit\s+/, '').trim();
    const spaceIdx = text.indexOf(' ');
    if (spaceIdx === -1) {
      await ctx.reply('Usage: /edit <id> <new text>');
      return;
    }
    const rawId = text.slice(0, spaceIdx).trim();
    const newContent = text.slice(spaceIdx + 1).trim();

    const fullId = await resolveReminderId(deps.db, rawId);
    if (!fullId) {
      await ctx.reply(`No reminder found matching "${rawId}".`);
      return;
    }

    // Store previous state for undo
    const chatId = String(ctx.chat.id);
    const old = await getReminderById(deps.db, fullId);
    lastActions.set(chatId, { action: 'update', reminderId: fullId, previousState: { content: old?.content, status: old?.status, priority: old?.priority, project: old?.project } });

    // Update content and re-embed
    await updateReminder(deps.db, fullId, { content: newContent });
    const embedding = await deps.embeddingProvider.embed(newContent);
    await deps.db.query('UPDATE reminders SET embedding = $1 WHERE id = $2', [JSON.stringify(embedding), fullId]);

    await ctx.reply(`Updated (${fullId.slice(0, 8)}): "${newContent}"`);
  });

  bot.command('comment', async (ctx) => {
    const text = ctx.message?.text ?? '';
    try {
      const result = await handleCommentCommand(
        { text, chatId: String(ctx.chat.id) },
        async (rawReminderId, content, source) => {
          const fullId = await resolveReminderId(deps.db, rawReminderId);
          if (!fullId) throw new Error(`No reminder found matching "${rawReminderId}". Use /todos to see IDs.`);
          const embedding = await deps.embeddingProvider.embed(content);
          return insertComment(deps.db, { content, embedding, reminderId: fullId, source });
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

  bot.command('subtask', async (ctx) => {
    const reminders = await findActiveReminders(deps.db);
    const topLevel = reminders.filter(r => r.depth === 0);
    if (topLevel.length === 0) {
      await ctx.reply('No reminders to add subtasks to.');
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const r of topLevel) {
      const label = r.content.length > 35 ? r.content.slice(0, 32) + '...' : r.content;
      keyboard.text(`➕ ${label}`, `subtask:${r.id}`).row();
    }
    await ctx.reply('Select a reminder to add a subtask to:', { reply_markup: keyboard });
  });

  // Natural language router — classify intent before acting
  bot.on('message:text', async (ctx) => {
    console.log(`[telegram] message:text handler hit: "${ctx.message.text}"`);
    if (ctx.message.text.startsWith('/')) return; // Skip unhandled commands
    const text = ctx.message.text;
    const chatId = String(ctx.chat.id);

    // Check for pending subtask creation (must be FIRST — before undo/intent classifier)
    const pendingSub = pendingSubtask.get(chatId);
    if (pendingSub) {
      pendingSubtask.delete(chatId);
      try {
        // Parse subtask text through LLM for priority, due date, etc.
        let parsedContent = text;
        let parsedPriority: string | null = null;
        let parsedDueDate: Date | null = null;
        let parsedCategory: string | null = null;
        console.log(`[subtask-parser] Parsing: "${text}"`);
        const subTodayISO = new Date().toISOString().split('T')[0];
        const subDayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: deps.config.timezone }).format(new Date());
        const subParsed = await llmJsonParse<{ content: string; priority: string | null; dueDate: string | null; category: string | null }>(
          deps.metadataLLM,
          [{ role: 'user', content: text }],
          { systemPrompt: buildReminderParserPrompt(subTodayISO, subDayOfWeek, deps.config.timezone), responseFormat: 'json', maxTokens: 1024 },
          'subtask-parser',
        );
        if (subParsed) {
          parsedContent = subParsed.content ?? text;
          parsedPriority = subParsed.priority ?? null;
          parsedDueDate = subParsed.dueDate ? new Date(subParsed.dueDate) : null;
          parsedCategory = subParsed.category ?? null;
          console.log(`[subtask-parser] Result: content="${parsedContent}", priority=${parsedPriority}, due=${parsedDueDate}`);
        }

        const embedding = await deps.embeddingProvider.embed(parsedContent);
        const subtaskResult = await insertReminder(deps.db, {
          content: parsedContent,
          embedding,
          category: parsedCategory,
          project: pendingSub.parentProject,
          section: pendingSub.parentSection,
          parentId: pendingSub.parentId,
          depth: pendingSub.depth,
          priority: parsedPriority,
          source: 'telegram',
          sourceContext: null,
          dueDate: parsedDueDate,
        });

        // Show parent with all subtasks including the new one
        const parentReminder = await getReminderById(deps.db, pendingSub.parentId);
        const allSubtasks = await findSubtasks(deps.db, pendingSub.parentId);
        const newSubtask = allSubtasks.find(st => st.id === subtaskResult.id);

        let replyText = `Subtask added to "${pendingSub.parentContent}":\n`;
        if (parentReminder) {
          replyText = `Subtask added!\n  ${formatSingleReminder(parentReminder)}\n`;
          if (allSubtasks.length > 0) {
            for (const st of allSubtasks) {
              const depthIndent = '  '.repeat(st.depth);
              replyText += `  ${depthIndent}↳ ${formatSingleReminder(st)}\n`;
            }
          }
        } else {
          replyText += `  ${formatSingleReminder(newSubtask ?? { id: subtaskResult.id, content: text, status: 'not_started', priority: null, due_date: null } as ReminderRow)}\n`;
        }

        // Offer buttons for drilling deeper if depth allows
        if (pendingSub.depth < 3) {
          const subKeyboard = new InlineKeyboard();
          for (const st of allSubtasks) {
            if (st.depth < 3) {
              const label = st.content.length > 30 ? st.content.slice(0, 27) + '...' : st.content;
              subKeyboard.text(`➕ ${label}`, `subtask:${st.id}`).row();
            }
          }
          if (allSubtasks.length > 0) {
            await ctx.reply(replyText.trim(), { reply_markup: subKeyboard });
          } else {
            await ctx.reply(replyText.trim());
          }
        } else {
          await ctx.reply(replyText.trim());
        }

        lastActions.set(chatId, { action: 'create', reminderId: subtaskResult.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await ctx.reply(`Failed to create subtask: ${msg}`);
      }
      return;
    }

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
            content: prev.content as string | undefined,
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

    // Use LLM to classify intent (with retry)
    console.log(`[intent-classifier] Input: "${text}"`);
    const todayISO = new Date().toISOString().split('T')[0];
    const dayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: deps.config.timezone }).format(new Date());
    const intent = await llmJsonParse<{ action: string; content?: string; project?: string; section?: string; priority?: string; category?: string; dueDate?: string; taskSearch?: string; status?: string; dueFilter?: string }>(
      deps.metadataLLM,
      [{ role: 'user', content: text }],
      { systemPrompt: buildIntentClassifierPrompt(todayISO, dayOfWeek, deps.config.timezone), responseFormat: 'json', maxTokens: 1024 },
      'intent-classifier',
    ) ?? { action: 'capture_thought' as const };
    console.log(`[intent-classifier] Result: ${JSON.stringify(intent)}`);

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
      // Build formatted confirmation
      const createdRow: ReminderRow = {
        id: result.id,
        content: taskContent,
        embedding: [],
        metadata: null,
        category: intent.category ?? null,
        project: intent.project ?? null,
        section: intent.section ?? null,
        parent_id: null,
        depth: 0,
        status: 'not_started',
        priority: intent.priority ?? null,
        source_context: null,
        source: 'telegram',
        archived: false,
        due_date: intent.dueDate ? new Date(intent.dueDate) : null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const nlProjectLine = intent.project
        ? `\n  📋 ${intent.project}${intent.section ? ` / ${intent.section}` : ''}`
        : '';
      lastActions.set(chatId, { action: 'create', reminderId: result.id });
      await ctx.reply(`${INTENT_PREFIX} new reminder.\n  ${formatSingleReminder(createdRow)}${nlProjectLine}${UNDO_HINT}`);

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
      const { text: todosText, keyboard } = await buildTodosMessage(chatId, reminders);
      const formatted = header + todosText;
      await ctx.reply(formatted, { reply_markup: keyboard });

    } else if (intent.action === 'complete_reminder') {
      // Search all reminders (including done/subtasks) by description
      const reminders = await findAllReminders(deps.db);
      const search = (intent.taskSearch ?? '').toLowerCase();
      const match = reminders.find((r) => r.content.toLowerCase().includes(search));
      if (match) {
        lastActions.set(chatId, { action: 'complete', reminderId: match.id, previousState: { status: match.status } });
        const { completed } = await dbCompleteReminder(deps.db, match.id);
        const nlSubtaskCount = completed.length - 1;
        const nlSubtaskSuffix = nlSubtaskCount > 0 ? ` (+ ${nlSubtaskCount} subtask${nlSubtaskCount === 1 ? '' : 's'})` : '';
        await ctx.reply(`${INTENT_PREFIX} task completion.\n✓ Done: "${match.content}"${nlSubtaskSuffix} (${match.id.slice(0, 8)})${UNDO_HINT}`);
      } else {
        await ctx.reply(`Couldn't find a matching task for "${intent.taskSearch}". Try /todos to see your list.`);
      }

    } else if (intent.action === 'update_reminder') {
      const reminders = await findAllReminders(deps.db);
      const search = (intent.taskSearch ?? '').toLowerCase();
      const match = reminders.find((r) => r.content.toLowerCase().includes(search));
      if (match) {
        lastActions.set(chatId, { action: 'update', reminderId: match.id, previousState: { content: match.content, status: match.status, priority: match.priority, project: match.project } });
        await updateReminder(deps.db, match.id, {
          status: intent.status,
          priority: intent.priority ?? undefined,
          project: intent.project ?? undefined,
          dueDate: intent.dueDate ? new Date(intent.dueDate) : undefined,
          content: intent.content ?? undefined,
        });
        if (intent.content) {
          const embedding = await deps.embeddingProvider.embed(intent.content);
          await deps.db.query('UPDATE reminders SET embedding = $1 WHERE id = $2', [JSON.stringify(embedding), match.id]);
        }
        const changes = [
          intent.content ? `content → "${intent.content}"` : null,
          intent.status,
          intent.priority,
          intent.project ? `→ ${intent.project}` : null,
        ].filter(Boolean).join(', ');
        await ctx.reply(`${INTENT_PREFIX} task update.\nUpdated: "${match.content}" (${changes})${UNDO_HINT}`);
      } else {
        await ctx.reply(`Couldn't find a matching task for "${intent.taskSearch}". Try /todos to see your list.`);
      }

    } else if (intent.action === 'add_comment') {
      const reminders = await findAllReminders(deps.db);
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
              content: prev.content as string | undefined,
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
      const docMimeType = resolveMimeType(doc.mime_type, doc.file_name);
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
