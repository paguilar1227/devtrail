// src/mcp/reminder-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import { insertReminder, listReminders, updateReminder, completeReminder, getReminderById } from '../db/reminders.js';

export function registerReminderTools(server: McpServer, deps: AppDeps): void {
  // 1. create_reminder
  server.tool(
    'create_reminder',
    'Create a new reminder from "remind me to..." or "add to my todos"',
    {
      content: z.string().describe('Reminder text'),
      category: z.string().optional().describe('Category (auto-determined if omitted)'),
      due_date: z.string().optional().describe('ISO 8601 due date'),
      source_context: z.string().optional().describe('Context of the conversation that triggered this'),
    },
    async ({ content, category, due_date, source_context }) => {
      const embedding = await deps.embeddingProvider.embed(content);
      const result = await insertReminder(deps.db, {
        content,
        embedding,
        category: category ?? null,
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
    'List reminders filtered by status and/or category',
    {
      status: z.string().optional().describe('Filter by status'),
      category: z.string().optional().describe('Filter by category'),
      limit: z.number().int().positive().default(20).describe('Max results'),
    },
    async ({ status, category, limit }) => {
      const reminders = await listReminders(deps.db, { status, category, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(reminders, null, 2) }] };
    },
  );

  // 3. update_reminder
  server.tool(
    'update_reminder',
    'Change status, edit content, or set due date on a reminder',
    {
      id: z.string().uuid().describe('Reminder UUID'),
      status: z.string().optional().describe('New status'),
      content: z.string().optional().describe('New content'),
      due_date: z.string().optional().describe('New ISO 8601 due date'),
    },
    async ({ id, status, content, due_date }) => {
      await updateReminder(deps.db, id, {
        status,
        content,
        dueDate: due_date ? new Date(due_date) : undefined,
      });
      // Re-embed if content changed
      if (content) {
        const embedding = await deps.embeddingProvider.embed(content);
        await deps.db.query(`UPDATE reminders SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
      }
      return { content: [{ type: 'text' as const, text: `Reminder ${id} updated` }] };
    },
  );

  // 4. complete_reminder
  server.tool(
    'complete_reminder',
    'Shortcut for marking a reminder as done',
    {
      id: z.string().uuid().describe('Reminder UUID'),
    },
    async ({ id }) => {
      await completeReminder(deps.db, id);
      return { content: [{ type: 'text' as const, text: `Reminder ${id} marked as done` }] };
    },
  );
}
