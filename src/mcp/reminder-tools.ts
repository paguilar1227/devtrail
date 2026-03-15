// src/mcp/reminder-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import {
  insertReminder,
  listReminders,
  updateReminder,
  completeReminder,
  deleteReminder,
  getReminderById,
  getReminderDetail,
  listProjects,
} from '../db/reminders.js';
import { insertComment } from '../db/reminder-comments.js';

export function registerReminderTools(server: McpServer, deps: AppDeps): void {
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
      let depth = 0;

      if (parent_id) {
        const parent = await getReminderById(deps.db, parent_id);
        if (!parent) {
          return { content: [{ type: 'text' as const, text: `Error: parent reminder ${parent_id} not found` }] };
        }
        depth = parent.depth + 1;
        if (depth >= 4) {
          return { content: [{ type: 'text' as const, text: 'Error: maximum subtask depth (4 levels) exceeded' }] };
        }
      }

      const embedding = await deps.embeddingProvider.embed(content);
      const result = await insertReminder(deps.db, {
        content,
        embedding,
        category: category ?? null,
        project: project ?? null,
        section: section ?? null,
        parentId: parent_id ?? null,
        depth,
        priority: priority ?? null,
        source: 'mcp',
        sourceContext: source_context ?? null,
        dueDate: due_date ? new Date(due_date) : null,
      });
      return { content: [{ type: 'text' as const, text: `Reminder created: ${result.id}` }] };
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
      const reminders = await listReminders(deps.db, {
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(reminders, null, 2) }] };
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
      const detail = await getReminderDetail(deps.db, id);
      if (!detail) {
        return { content: [{ type: 'text' as const, text: `Reminder ${id} not found` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
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
      await updateReminder(deps.db, id, {
        status,
        priority,
        content,
        dueDate: due_date ? new Date(due_date) : undefined,
        project,
        section,
      });
      // Re-embed if content changed
      if (content) {
        const embedding = await deps.embeddingProvider.embed(content);
        await deps.db.query(`UPDATE reminders SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
      }
      return { content: [{ type: 'text' as const, text: `Reminder ${id} updated` }] };
    },
  );

  // 5. complete_reminder
  server.tool(
    'complete_reminder',
    'Shortcut for marking a reminder as done. Does NOT auto-complete subtasks — each is completed independently.',
    {
      id: z.string().uuid().describe('Reminder UUID'),
    },
    async ({ id }) => {
      await completeReminder(deps.db, id);
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
      await deleteReminder(deps.db, id);
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
      const reminder = await getReminderById(deps.db, id);
      if (!reminder) {
        return { content: [{ type: 'text' as const, text: `Error: reminder ${id} not found` }] };
      }
      const embedding = await deps.embeddingProvider.embed(content);
      const result = await insertComment(deps.db, {
        content,
        embedding,
        reminderId: id,
        source: 'mcp',
      });
      return { content: [{ type: 'text' as const, text: `Comment added: ${result.id}` }] };
    },
  );

  // 8. list_projects
  server.tool(
    'list_projects',
    'List all distinct projects with task count stats (by status)',
    {},
    async () => {
      const projects = await listProjects(deps.db);
      return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
    },
  );
}
