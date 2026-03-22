// src/telegram/nl-router.ts
import { Bot, InlineKeyboard } from 'grammy';
import type { AppDeps } from '../app.js';
import type { FileInput } from '../capture/pipeline.js';
import {
  insertReminder,
  completeReminder as dbCompleteReminder,
  findActiveReminders,
  findAllReminders,
  getReminderById,
  updateReminder,
  deleteReminder,
  findSubtasks,
  findRemindersDueOnDate,
  findOverdueReminders,
  reparentReminder,
  resolveReminderId,
} from '../db/reminders.js';
import type { ReminderRow } from '../db/reminders.js';
import { insertComment, deleteComment } from '../db/reminder-comments.js';
import {
  handleTextMessage,
  handlePhotoMessage,
  handleVoiceMessage,
  handleDocumentMessage,
} from './handlers.js';
import { formatSingleReminder } from '../notifications/format-reminders.js';
import { buildIntentClassifierPrompt, buildReminderParserPrompt } from './prompts.js';
import { resolveMimeType } from './mime-utils.js';
import { llmJsonParse } from './llm-parse.js';
import { buildTodosMessage } from './command-handlers.js';
import type { StateRefs } from './state.js';

type CaptureFn = (input: { content: string; files: FileInput[]; source: string[] }) => Promise<{ success: boolean; captureId?: string; reason?: string }>;
type DownloadFileFn = (fileId: string) => Promise<Buffer>;

/** Register the NL intent router (message:text) and all media handlers on the bot. */
export function registerNlRouter(
  bot: Bot,
  deps: AppDeps,
  stateRefs: StateRefs,
  captureFn: CaptureFn,
  downloadFile: DownloadFileFn,
): void {
  // Natural language router — classify intent before acting
  bot.on('message:text', async (ctx) => {
    console.log(`[telegram] message:text handler hit: "${ctx.message.text}"`);
    if (ctx.message.text.startsWith('/')) return; // Skip unhandled commands
    const text = ctx.message.text;
    const chatId = String(ctx.chat.id);

    // Check for pending subtask creation (must be FIRST — before undo/intent classifier)
    const pendingSub = stateRefs.pendingSubtask.get(chatId);
    if (pendingSub) {
      stateRefs.pendingSubtask.delete(chatId);
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

        stateRefs.lastActions.set(chatId, { action: 'create', reminderId: subtaskResult.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await ctx.reply(`Failed to create subtask: ${msg}`);
      }
      return;
    }

    // Check for pending action (edit/comment/move) set by the ⚙ action menu
    const pendingAct = stateRefs.pendingAction.get(chatId);
    if (pendingAct) {
      stateRefs.pendingAction.delete(chatId);
      if (pendingAct.action === 'edit') {
        await updateReminder(deps.db, pendingAct.reminderId, { content: text });
        const editEmbedding = await deps.embeddingProvider.embed(text);
        await deps.db.query('UPDATE reminders SET embedding = $1 WHERE id = $2', [JSON.stringify(editEmbedding), pendingAct.reminderId]);
        stateRefs.lastActions.set(chatId, { action: 'update', reminderId: pendingAct.reminderId });
        await ctx.reply(`Updated (${pendingAct.reminderId.slice(0, 8)}): "${text}"`);
      } else if (pendingAct.action === 'comment') {
        const commentEmbedding = await deps.embeddingProvider.embed(text);
        const commentResult = await insertComment(deps.db, { content: text, embedding: commentEmbedding, reminderId: pendingAct.reminderId, source: 'telegram' });
        stateRefs.lastActions.set(chatId, { action: 'comment', reminderId: commentResult.id });
        await ctx.reply(`Comment added to (${pendingAct.reminderId.slice(0, 8)}): "${text}"`);
      } else if (pendingAct.action === 'move') {
        if (text.toLowerCase().trim() === 'root') {
          await reparentReminder(deps.db, pendingAct.reminderId, null);
          await ctx.reply(`Moved (${pendingAct.reminderId.slice(0, 8)}) to root level.`);
        } else {
          const targetId = await resolveReminderId(deps.db, text.trim());
          if (!targetId) {
            // Re-set the pending action so the user can try again
            stateRefs.pendingAction.set(chatId, pendingAct);
            await ctx.reply(`No reminder found matching "${text}". Try again with a valid ID or short ID, or type "root".`);
            return;
          }
          await reparentReminder(deps.db, pendingAct.reminderId, targetId);
          await ctx.reply(`Moved (${pendingAct.reminderId.slice(0, 8)}) under (${targetId.slice(0, 8)}).`);
        }
      }
      return;
    }

    // Fast-path: undo last action without hitting the LLM
    if (text.toLowerCase().trim() === 'undo') {
      const last = stateRefs.lastActions.get(chatId);
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
      stateRefs.lastActions.delete(chatId);
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
      stateRefs.lastActions.set(chatId, { action: 'create', reminderId: result.id });
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
      const { text: todosText, keyboard } = await buildTodosMessage(deps, stateRefs, chatId, reminders);
      const formatted = header + todosText;
      await ctx.reply(formatted, { reply_markup: keyboard });

    } else if (intent.action === 'complete_reminder') {
      // Search all reminders (including done/subtasks) by description
      const reminders = await findAllReminders(deps.db);
      const search = (intent.taskSearch ?? '').toLowerCase();
      const match = reminders.find((r) => r.content.toLowerCase().includes(search));
      if (match) {
        stateRefs.lastActions.set(chatId, { action: 'complete', reminderId: match.id, previousState: { status: match.status } });
        const nlDoneResult = await dbCompleteReminder(deps.db, match.id);
        const nlSubCount = nlDoneResult.completed.length - 1;
        const nlSubMsg = nlSubCount > 0 ? ` (+ ${nlSubCount} subtask${nlSubCount > 1 ? 's' : ''})` : '';
        await ctx.reply(`${INTENT_PREFIX} task completion.\n✓ Done${nlSubMsg}: "${match.content}" (${match.id.slice(0, 8)})${UNDO_HINT}`);
      } else {
        await ctx.reply(`Couldn't find a matching task for "${intent.taskSearch}". Try /todos to see your list.`);
      }

    } else if (intent.action === 'update_reminder') {
      const reminders = await findAllReminders(deps.db);
      const search = (intent.taskSearch ?? '').toLowerCase();
      const match = reminders.find((r) => r.content.toLowerCase().includes(search));
      if (match) {
        stateRefs.lastActions.set(chatId, { action: 'update', reminderId: match.id, previousState: { content: match.content, status: match.status, priority: match.priority, project: match.project } });
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
        stateRefs.lastActions.set(chatId, { action: 'comment', reminderId: commentResult.id });
        await ctx.reply(`${INTENT_PREFIX} comment on task.\nAdded to "${match.content}": "${intent.content}"${UNDO_HINT}`);
      } else {
        await ctx.reply(`Couldn't find a matching task for "${intent.taskSearch}".`);
      }

    } else if (intent.action === 'undo') {
      // LLM-classified undo — reuse the fast-path logic
      const last = stateRefs.lastActions.get(chatId);
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
        stateRefs.lastActions.delete(chatId);
      }

    } else if (intent.action === 'move_reminder') {
      const reminders = await findAllReminders(deps.db);
      const taskSearch = ((intent as any).taskSearch ?? '').toLowerCase();
      const targetSearch = ((intent as any).targetSearch ?? '').toLowerCase();
      const task = reminders.find((r) => r.content.toLowerCase().includes(taskSearch));
      if (!task) {
        await ctx.reply(`Couldn't find a matching task for "${(intent as any).taskSearch}".`);
      } else if (targetSearch === 'root' || targetSearch === 'top level') {
        await reparentReminder(deps.db, task.id, null);
        await ctx.reply(`${INTENT_PREFIX} move.\nMoved: "${task.content}" to root level (${task.id.slice(0, 8)})${UNDO_HINT}`);
      } else {
        const target = reminders.find((r) => r.content.toLowerCase().includes(targetSearch) && r.id !== task.id);
        if (!target) {
          await ctx.reply(`Couldn't find a matching task for "${(intent as any).targetSearch}" to move under.`);
        } else {
          await reparentReminder(deps.db, task.id, target.id);
          await ctx.reply(`${INTENT_PREFIX} move.\nMoved: "${task.content}" under "${target.content}" (${task.id.slice(0, 8)})${UNDO_HINT}`);
        }
      }

    } else {
      // Default: capture as thought
      const result = await captureFn({ content: text, files: [], source: ['telegram'] });
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
}
