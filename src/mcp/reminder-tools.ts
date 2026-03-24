// src/mcp/reminder-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import type { ServiceDeps } from '../services/index.js';
import * as remindersSvc from '../services/reminders.js';
import * as commentsSvc from '../services/comments.js';
import {
  formatRemindersMarkdown,
  formatReminderDetailMarkdown,
} from '../notifications/format-reminders.js';

export function registerReminderTools(server: McpServer, deps: AppDeps): void {
  // AppDeps and ServiceDeps have the same shape — cast once and use throughout
  const svcDeps: ServiceDeps = deps;

  // 1. create_reminder
  server.tool(
    'create_reminder',
    'Create a new reminder or subtask. Use parent_id to create a subtask (max 4 levels deep).',
    {
      content: z.string().describe('Reminder text'),
      project: z.string().optional().describe('Project grouping (e.g., "deep-research-engine")'),
      section: z.string().optional().describe('Section within the project (e.g., "backend")'),
      parent_id: z.string().uuid().optional().describe('Parent reminder UUID — creates a subtask'),
      category: z.string().optional().describe('Category (auto-determined if omitted)'),
      priority: z.enum(['P1', 'P2', 'P3']).optional().describe('Task priority'),
      due_date: z.string().optional().describe('ISO 8601 due date'),
      source_context: z.string().optional().describe('Context of the conversation that triggered this'),
    },
    async ({ content, project, section, parent_id, category, priority, due_date, source_context }) => {
      try {
        const result = await remindersSvc.createReminder(svcDeps, {
          content,
          project: project ?? null,
          section: section ?? null,
          parentId: parent_id ?? null,
          category: category ?? null,
          priority: priority ?? null,
          dueDate: due_date ? new Date(due_date) : null,
          source: 'mcp',
          sourceContext: source_context ?? null,
        });
        return { content: [{ type: 'text' as const, text: `Reminder created: ${result.id}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }] };
      }
    },
  );

  // 2. list_reminders
  server.tool(
    'list_reminders',
    'List reminders with flexible filtering. By default only top-level tasks (depth=0) and excludes done/cancelled.',
    {
      project: z.string().optional().describe('Filter by project'),
      section: z.string().optional().describe('Filter by section'),
      status: z.string().optional().describe('Filter by status'),
      priority: z.enum(['P1', 'P2', 'P3']).optional().describe('Filter by priority'),
      category: z.string().optional().describe('Filter by category'),
      due_before: z.string().optional().describe('ISO 8601 date — only tasks due before this date'),
      due_after: z.string().optional().describe('ISO 8601 date — only tasks due after this date'),
      include_done: z.boolean().optional().default(false).describe('Include done and cancelled tasks'),
      top_level_only: z.boolean().optional().default(true).describe('Only return top-level tasks (depth=0)'),
      limit: z.number().int().positive().default(20).describe('Max results'),
    },
    async ({ project, section, status, priority, category, due_before, due_after, include_done, top_level_only, limit }) => {
      const reminders = await remindersSvc.listReminders(svcDeps, {
        project,
        section,
        status,
        priority,
        category,
        due_before: due_before ? new Date(due_before) : undefined,
        due_after: due_after ? new Date(due_after) : undefined,
        include_done,
        top_level_only,
        limit,
      });

      // Build subtask map for display
      const subtasksMap = new Map<string, import('../db/reminders.js').ReminderRow[]>();
      for (const reminder of reminders) {
        const subtasks = await remindersSvc.findSubtasks(svcDeps, reminder.id);
        if (subtasks.length > 0) {
          subtasksMap.set(reminder.id, subtasks);
        }
      }

      const text = formatRemindersMarkdown(reminders, subtasksMap);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // 3. get_reminder_detail
  server.tool(
    'get_reminder_detail',
    'Get a single task with all its comments and full subtask tree',
    {
      id: z.string().uuid().describe('Reminder UUID'),
    },
    async ({ id }) => {
      const detail = await remindersSvc.getReminderDetail(svcDeps, id);
      if (!detail) {
        return { content: [{ type: 'text' as const, text: `Reminder ${id} not found` }] };
      }
      const text = formatReminderDetailMarkdown(detail, detail.comments, detail.subtasks, deps.config.timezone);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // 4. update_reminder
  server.tool(
    'update_reminder',
    'Change status, priority, content, due date, or move to a different project/section',
    {
      id: z.string().uuid().describe('Reminder UUID'),
      status: z.string().optional().describe('New status'),
      priority: z.enum(['P1', 'P2', 'P3']).optional().describe('New priority'),
      content: z.string().optional().describe('New content'),
      due_date: z.string().optional().describe('New ISO 8601 due date'),
      project: z.string().optional().describe('Move to a different project'),
      section: z.string().optional().describe('Move to a different section'),
    },
    async ({ id, status, priority, content, due_date, project, section }) => {
      await remindersSvc.updateReminder(svcDeps, id, {
        status,
        priority,
        content,
        dueDate: due_date ? new Date(due_date) : undefined,
        project,
        section,
      });
      return { content: [{ type: 'text' as const, text: `Reminder ${id} updated` }] };
    },
  );

  // 5. complete_reminder
  server.tool(
    'complete_reminder',
    'Shortcut for marking a reminder as done. Auto-cascades to all subtasks.',
    {
      id: z.string().uuid().describe('Reminder UUID'),
    },
    async ({ id }) => {
      await remindersSvc.completeReminder(svcDeps, id);
      return { content: [{ type: 'text' as const, text: `Reminder ${id} marked as done` }] };
    },
  );

  // 6. delete_reminder
  server.tool(
    'delete_reminder',
    'Delete a task and cascade-delete all its subtasks and comments',
    {
      id: z.string().uuid().describe('Reminder UUID'),
    },
    async ({ id }) => {
      await remindersSvc.deleteReminder(svcDeps, id);
      return { content: [{ type: 'text' as const, text: `Reminder ${id} and all subtasks/comments deleted` }] };
    },
  );

  // 7. add_reminder_comment
  server.tool(
    'add_reminder_comment',
    'Add a progress comment to a task (timestamped log entry — "what happened")',
    {
      id: z.string().uuid().describe('Reminder UUID'),
      content: z.string().describe('Comment text'),
    },
    async ({ id, content }) => {
      try {
        const result = await commentsSvc.addComment(svcDeps, id, content, 'mcp');
        return { content: [{ type: 'text' as const, text: `Comment added: ${result.id}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }] };
      }
    },
  );

  // 8. list_projects
  server.tool(
    'list_projects',
    'List all distinct projects with task count stats (by status)',
    {},
    async () => {
      const projects = await remindersSvc.listProjects(svcDeps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
    },
  );

  // 9. edit_comment
  server.tool(
    'edit_comment',
    'Edit the text of an existing comment on a reminder',
    {
      id: z.string().uuid().describe('Comment UUID'),
      content: z.string().describe('New comment text'),
    },
    async ({ id, content }) => {
      try {
        await commentsSvc.updateComment(svcDeps, id, content);
        return { content: [{ type: 'text' as const, text: `Comment ${id} updated` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    },
  );

  // 10. delete_comment
  server.tool(
    'delete_comment',
    'Delete a comment from a reminder. Returns the deleted comment content.',
    {
      id: z.string().uuid().describe('Comment UUID'),
    },
    async ({ id }) => {
      try {
        const deleted = await commentsSvc.deleteComment(svcDeps, id);
        return { content: [{ type: 'text' as const, text: `Comment ${id} deleted. Content was: "${deleted.content}"` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    },
  );
}
