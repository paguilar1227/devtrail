// src/telegram/command-handlers.ts
import { Bot, InlineKeyboard } from 'grammy';
import type { AppDeps } from '../app.js';
import type { ServiceDeps } from '../services/index.js';
import * as remindersSvc from '../services/reminders.js';
import * as commentsSvc from '../services/comments.js';
import type { ReminderRow } from '../db/reminders.js';
import { resolveReminderId } from '../db/reminders.js';
import { countCommentsByReminderIds } from '../db/reminder-comments.js';
import { handleCommentCommand } from './handlers.js';
import { formatRemindersMarkdown, formatSingleReminder } from '../notifications/format-reminders.js';
import { buildReminderParserPrompt } from './prompts.js';
import { llmJsonParse } from './llm-parse.js';
import type { StateRefs } from './state.js';

/** Build a numbered todos keyboard + formatted text, storing the number map for the given chat. */
export async function buildTodosMessage(
  deps: AppDeps,
  stateRefs: StateRefs,
  chatId: string,
  reminders: ReminderRow[],
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const numMap = new Map<number, string>();
  stateRefs.todoNumberMaps.set(chatId, numMap);

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
      const children = await remindersSvc.findSubtasks(deps as ServiceDeps, r.id);
      if (children.length > 0) {
        subtasksMap.set(r.id, children);
        // Also fetch grandchildren for each child
        for (const child of children) {
          const grandchildren = await remindersSvc.findSubtasks(deps as ServiceDeps, child.id);
          if (grandchildren.length > 0) {
            subtasksMap.set(child.id, grandchildren);
          }
        }
      }
    }
  }

  // Fetch comment counts for all top-level reminders in one query
  const topLevelIds = reminders.filter(r => r.depth === 0).map(r => r.id);
  const commentCounts = await countCommentsByReminderIds(deps.db, topLevelIds);

  const text = formatRemindersMarkdown(reminders, subtasksMap, commentCounts);

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
      keyboard.text(`✓ ${num}`, `done:${remId}`).text(`${cycle.label} ${num}`, `cycle:${remId}`).text(`⚙ ${num}`, `actions:${remId}`).row();
    } else {
      keyboard.text(`✓ ${num}`, `done:${remId}`).text(`⚙ ${num}`, `actions:${remId}`).row();
    }
  }

  return { text, keyboard };
}

/** Register all /command handlers and the callback_query handler on the bot. */
export function registerCommandHandlers(
  bot: Bot,
  deps: AppDeps,
  stateRefs: StateRefs,
): void {
  // AppDeps and ServiceDeps have the same shape
  const svcDeps = deps as ServiceDeps;

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

    const result = await remindersSvc.createReminder(svcDeps, {
      content: parsed.content,
      category: parsed.category,
      project: parsed.project,
      section: parsed.section,
      parentId: null,
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
    stateRefs.lastActions.set(chatId, { action: 'create', reminderId: result.id });
    await ctx.reply(`Reminder created.\n  ${formatSingleReminder(createdReminder)}${projectLine}`);
  });

  bot.command('todos', async (ctx) => {
    const reminders = await remindersSvc.findActiveReminders(svcDeps);

    if (reminders.length === 0) {
      await ctx.reply('No active reminders.');
      return;
    }

    const chatId = String(ctx.chat.id);
    const { text, keyboard } = await buildTodosMessage(deps, stateRefs, chatId, reminders);
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
      const doneResult = await remindersSvc.completeReminder(svcDeps, reminderId);
      const doneSubCount = doneResult.completed.length - 1;
      const doneSubText = doneSubCount > 0 ? ` + ${doneSubCount} subtask${doneSubCount > 1 ? 's' : ''}` : '';
      await ctx.answerCallbackQuery({ text: `Marked as done ✓${doneSubText}` });
      // Re-render the full list with updated statuses
      const reminders = await remindersSvc.findActiveReminders(svcDeps);
      if (reminders.length === 0) {
        await ctx.editMessageText('All done! No active reminders.');
      } else {
        const { text, keyboard } = await buildTodosMessage(deps, stateRefs, chatId, reminders);
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
      const current = await remindersSvc.getReminder(svcDeps, reminderId);
      if (!current) { await ctx.answerCallbackQuery({ text: 'Reminder not found' }); return; }
      const nextStatus = cycleMap[current.status];
      if (!nextStatus) { await ctx.answerCallbackQuery({ text: 'Already done' }); return; }
      await remindersSvc.updateReminder(svcDeps, reminderId, { status: nextStatus });
      await ctx.answerCallbackQuery({ text: cycleLabels[nextStatus] ?? nextStatus });
      // Re-render the full list with updated statuses
      const cycleReminders = await remindersSvc.findActiveReminders(svcDeps);
      if (cycleReminders.length === 0) {
        await ctx.editMessageText('No active reminders.');
      } else {
        const { text, keyboard } = await buildTodosMessage(deps, stateRefs, chatId, cycleReminders);
        await ctx.editMessageText(text, { reply_markup: keyboard });
      }
    } else if (action === 'subtask') {
      // Subtask selection — show parent + existing subtasks, prompt for new subtask text
      const parent = await remindersSvc.getReminder(svcDeps, reminderId);
      if (!parent) { await ctx.answerCallbackQuery({ text: 'Reminder not found' }); return; }
      if (parent.depth >= 3) { await ctx.answerCallbackQuery({ text: 'Max subtask depth reached (4 levels)' }); return; }

      const existingSubtasks = await remindersSvc.findSubtasks(svcDeps, reminderId);
      let text = `Adding subtask to:\n  ${formatSingleReminder(parent)}\n`;
      if (existingSubtasks.length > 0) {
        text += '\nExisting subtasks:\n';
        for (const st of existingSubtasks) {
          text += `    ${formatSingleReminder(st)}\n`;
        }
      }
      text += '\nType your subtask below:';

      // Track pending subtask state
      stateRefs.pendingSubtask.set(chatId, { parentId: reminderId, parentContent: parent.content, parentProject: parent.project, parentSection: parent.section, depth: parent.depth + 1 });

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
    } else if (action === 'actions') {
      // Action menu — send a new message with action buttons for the specific task
      const reminder = await remindersSvc.getReminder(svcDeps, reminderId);
      if (!reminder) { await ctx.answerCallbackQuery({ text: 'Reminder not found' }); return; }
      const shortId = reminderId.slice(0, 8);
      const actionKeyboard = new InlineKeyboard()
        .text('✏ Edit', `action-edit:${reminderId}`)
        .text('💬 Comments', `action-comments:${reminderId}`)
        .text('↕ Move', `action-move:${reminderId}`)
        .row()
        .text('🗑 Delete', `action-delete:${reminderId}`)
        .text('➕ Subtask', `action-subtask:${reminderId}`);
      await ctx.answerCallbackQuery();
      await ctx.reply(`Actions for: ${reminder.content} (${shortId})`, { reply_markup: actionKeyboard });
    } else if (action === 'action-edit') {
      stateRefs.pendingAction.set(chatId, { action: 'edit', reminderId });
      await ctx.answerCallbackQuery();
      await ctx.reply('Type the new text for this reminder:');
    } else if (action === 'action-comments') {
      // View comments for this reminder
      const comments = await commentsSvc.listComments(svcDeps, reminderId);
      const reminder = await remindersSvc.getReminder(svcDeps, reminderId);
      const title = reminder?.content ?? reminderId;

      let commentText = `💬 Comments on "${title}" (${reminderId.slice(0, 8)})\n\n`;

      if (comments.length === 0) {
        commentText += 'No comments yet.';
      } else {
        comments.forEach((c, i) => {
          const date = new Date(c.created_at).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            timeZone: deps.config.timezone,
          });
          commentText += `${i + 1}. ${c.content}\n   ${date}\n\n`;
        });
      }

      const keyboard = new InlineKeyboard();
      comments.forEach((c, i) => {
        keyboard.text(`✏ ${i + 1}`, `cedit:${c.id}`).text(`🗑 ${i + 1}`, `cdel:${c.id}`).row();
      });
      keyboard.text('➕ Add Comment', `cadd:${reminderId}`);

      await ctx.answerCallbackQuery();
      await ctx.reply(commentText, { reply_markup: keyboard });
    } else if (action === 'cedit') {
      // Edit a comment — reminderId here is actually commentId
      const commentId = reminderId;
      const comment = await commentsSvc.getComment(svcDeps, commentId);
      if (!comment) {
        await ctx.answerCallbackQuery({ text: 'Comment not found' });
        return;
      }
      stateRefs.pendingAction.set(chatId, { action: 'comment-edit', reminderId: comment.reminder_id, commentId });
      await ctx.answerCallbackQuery();
      await ctx.reply(`✏ Editing comment:\n"${comment.content}"\n\nType the new text:`);
    } else if (action === 'cdel') {
      // Delete a comment instantly
      const commentId = reminderId;
      let deleted;
      try {
        deleted = await commentsSvc.deleteComment(svcDeps, commentId);
      } catch {
        await ctx.answerCallbackQuery({ text: 'Comment not found' });
        return;
      }
      stateRefs.lastActions.set(chatId, {
        action: 'delete-comment',
        reminderId: deleted.id,
        previousState: { content: deleted.content, reminderId: deleted.reminder_id, source: deleted.source },
      });
      await ctx.answerCallbackQuery();
      await ctx.reply(`🗑 Comment deleted: "${deleted.content}"`);
    } else if (action === 'cadd') {
      // Add comment — reuse existing pending action flow
      stateRefs.pendingAction.set(chatId, { action: 'comment', reminderId });
      await ctx.answerCallbackQuery();
      await ctx.reply('Type your comment:');
    } else if (action === 'action-move') {
      stateRefs.pendingAction.set(chatId, { action: 'move', reminderId });
      await ctx.answerCallbackQuery();
      await ctx.reply('Type the target task ID or short ID (or "root" to move to top level):');
    } else if (action === 'action-delete') {
      const delReminder = await remindersSvc.getReminder(svcDeps, reminderId);
      await remindersSvc.deleteReminder(svcDeps, reminderId);
      await ctx.answerCallbackQuery({ text: 'Deleted' });
      await ctx.reply(`🗑 Deleted: "${delReminder?.content ?? reminderId}" (${reminderId.slice(0, 8)}) and all subtasks/comments.`);
    } else if (action === 'action-subtask') {
      // Reuse subtask flow: treat same as tapping subtask:<reminderId>
      const subtaskParent = await remindersSvc.getReminder(svcDeps, reminderId);
      if (!subtaskParent) { await ctx.answerCallbackQuery({ text: 'Reminder not found' }); return; }
      if (subtaskParent.depth >= 3) { await ctx.answerCallbackQuery({ text: 'Max subtask depth reached (4 levels)' }); return; }

      const existingSubs = await remindersSvc.findSubtasks(svcDeps, reminderId);
      let subtaskText = `Adding subtask to:\n  ${formatSingleReminder(subtaskParent)}\n`;
      if (existingSubs.length > 0) {
        subtaskText += '\nExisting subtasks:\n';
        for (const st of existingSubs) {
          subtaskText += `    ${formatSingleReminder(st)}\n`;
        }
      }
      subtaskText += '\nType your subtask below:';

      stateRefs.pendingSubtask.set(chatId, { parentId: reminderId, parentContent: subtaskParent.content, parentProject: subtaskParent.project, parentSection: subtaskParent.section, depth: subtaskParent.depth + 1 });

      await ctx.answerCallbackQuery();
      await ctx.reply(subtaskText);

      if (existingSubs.length > 0 && existingSubs[0].depth < 3) {
        const subKeyboard = new InlineKeyboard();
        for (const st of existingSubs) {
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
    const chatId = String(ctx.chat.id);
    const result = await remindersSvc.completeReminder(svcDeps, fullId);
    const subtaskCount = result.completed.length - 1;
    const subtaskMsg = subtaskCount > 0 ? ` (+ ${subtaskCount} subtask${subtaskCount > 1 ? 's' : ''})` : '';
    stateRefs.lastActions.set(chatId, { action: 'complete', reminderId: fullId, previousState: { status: 'not_started' } });
    await ctx.reply(`✓ Reminder completed${subtaskMsg}! (${fullId.slice(0, 8)})`);
  });

  bot.command('move', async (ctx) => {
    const text = (ctx.message?.text ?? '').replace(/^\/move\s+/, '').trim();
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('Usage: /move <task-id> root  OR  /move <task-id> <parent-id>');
      return;
    }
    const rawTaskId = parts[0];
    const target = parts.slice(1).join(' ');
    const fullTaskId = await resolveReminderId(deps.db, rawTaskId);
    if (!fullTaskId) {
      await ctx.reply(`No reminder found matching "${rawTaskId}". Use /todos to see IDs.`);
      return;
    }
    if (target.toLowerCase() === 'root') {
      await remindersSvc.reparentReminder(svcDeps, fullTaskId, null);
      await ctx.reply(`Moved (${fullTaskId.slice(0, 8)}) to root level.`);
    } else {
      const fullParentId = await resolveReminderId(deps.db, target);
      if (!fullParentId) {
        await ctx.reply(`No reminder found matching "${target}" for the new parent.`);
        return;
      }
      await remindersSvc.reparentReminder(svcDeps, fullTaskId, fullParentId);
      const parent = await remindersSvc.getReminder(svcDeps, fullParentId);
      await ctx.reply(`Moved (${fullTaskId.slice(0, 8)}) under "${parent?.content ?? fullParentId}".`);
    }
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
    const reminder = await remindersSvc.getReminder(svcDeps, fullId);
    const chatId = String(ctx.chat.id);
    stateRefs.lastActions.set(chatId, { action: 'create', reminderId: fullId }); // undo will try to re-create, but delete is destructive — undo just notifies
    await remindersSvc.deleteReminder(svcDeps, fullId);
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
    const old = await remindersSvc.getReminder(svcDeps, fullId);
    stateRefs.lastActions.set(chatId, { action: 'update', reminderId: fullId, previousState: { content: old?.content, status: old?.status, priority: old?.priority, project: old?.project } });

    // Update content (service handles re-embedding)
    await remindersSvc.updateReminder(svcDeps, fullId, { content: newContent });

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
          return commentsSvc.addComment(svcDeps, fullId, content, source);
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
    const reminders = await remindersSvc.findActiveReminders(svcDeps);
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
}
