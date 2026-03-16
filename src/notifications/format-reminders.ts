// src/notifications/format-reminders.ts
import type { ReminderRow, ReminderDetail } from '../db/reminders.js';
import type { ReminderCommentRow } from '../db/reminder-comments.js';

// ---------------------------------------------------------------------------
// Status icon map
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  not_started: '○',
  in_progress: '●',
  researching: '🔍',
  paused: '⏸',
  blocked: '🚫',
  done: '✓',
  cancelled: '✗',
};

function statusIcon(status: string): string {
  return STATUS_ICONS[status] ?? '○';
}

// ---------------------------------------------------------------------------
// Priority display
// ---------------------------------------------------------------------------

function priorityTag(priority: string | null): string {
  if (!priority) return '';
  return ` [${priority}]`;
}

// ---------------------------------------------------------------------------
// Due date display — "Mar 20", "Mar 15 2025" (includes year when not current)
// ---------------------------------------------------------------------------

function formatDueDate(date: Date | null): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// ---------------------------------------------------------------------------
// Subtask count helper
// ---------------------------------------------------------------------------

export interface SubtaskCount {
  reminderId: string;
  total: number;
  done: number;
}

// ---------------------------------------------------------------------------
// formatRemindersMarkdown
// Groups by project (null → "Ungrouped"), emits emoji + markdown.
// ---------------------------------------------------------------------------

export function formatRemindersMarkdown(
  reminders: ReminderRow[],
  subtaskCounts: SubtaskCount[] = [],
): string {
  if (reminders.length === 0) {
    return 'No active reminders.';
  }

  // Build a lookup: reminderId → SubtaskCount
  const countMap = new Map<string, SubtaskCount>();
  for (const sc of subtaskCounts) {
    countMap.set(sc.reminderId, sc);
  }

  // Group by project
  const groups = new Map<string | null, ReminderRow[]>();
  for (const r of reminders) {
    const key = r.project ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const lines: string[] = [];

  // Sort: named projects first (alphabetically), then null/Ungrouped
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    const group = groups.get(key)!;
    const icon = key === null ? '📌' : '📋';
    const label = key ?? 'Ungrouped';
    const taskWord = group.length === 1 ? 'task' : 'tasks';
    lines.push(`${icon} ${label} (${group.length} ${taskWord})`);

    for (const r of group) {
      const icon = statusIcon(r.status);
      const pTag = priorityTag(r.priority);
      const due = r.due_date ? ` — due ${formatDueDate(r.due_date)}` : '';
      lines.push(`  ${icon} ${r.content}${pTag}${due}`);

      // Subtask summary line
      const sc = countMap.get(r.id);
      if (sc && sc.total > 0) {
        // We don't have individual subtask rows here — just show count summary
        lines.push(`    (${sc.done}/${sc.total} subtasks done)`);
      }
    }

    lines.push('');
  }

  // Remove trailing blank line
  if (lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatRemindersMarkdownWithSubtasks
// Variant that accepts subtask rows directly (used when the caller already
// has them, e.g. for the detail view list).
// ---------------------------------------------------------------------------

export function formatRemindersMarkdownWithSubtasks(
  reminders: ReminderRow[],
  subtasksByParent: Map<string, ReminderRow[]>,
): string {
  if (reminders.length === 0) {
    return 'No active reminders.';
  }

  const groups = new Map<string | null, ReminderRow[]>();
  for (const r of reminders) {
    const key = r.project ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const lines: string[] = [];

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    const group = groups.get(key)!;
    const icon = key === null ? '📌' : '📋';
    const label = key ?? 'Ungrouped';
    const taskWord = group.length === 1 ? 'task' : 'tasks';
    lines.push(`${icon} ${label} (${group.length} ${taskWord})`);

    for (const r of group) {
      const sIcon = statusIcon(r.status);
      const pTag = priorityTag(r.priority);
      const due = r.due_date ? ` — due ${formatDueDate(r.due_date)}` : '';
      lines.push(`  ${sIcon} ${r.content}${pTag}${due}`);

      const subtasks = subtasksByParent.get(r.id) ?? [];
      for (const st of subtasks) {
        lines.push(`    ${statusIcon(st.status)} ${st.content}`);
      }
    }

    lines.push('');
  }

  if (lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatReminderDetailMarkdown
// Full single-task view with comments and subtasks.
// ---------------------------------------------------------------------------

export function formatReminderDetailMarkdown(
  reminder: ReminderRow,
  comments: ReminderCommentRow[],
  subtasks: ReminderRow[],
): string {
  const lines: string[] = [];

  // Header line
  const sIcon = statusIcon(reminder.status);
  const pTag = priorityTag(reminder.priority);
  lines.push(`${sIcon} ${reminder.content}${pTag}`);

  // Meta line
  const meta: string[] = [];
  if (reminder.project) meta.push(`Project: ${reminder.project}`);
  if (reminder.section) meta.push(`Section: ${reminder.section}`);
  if (reminder.due_date) meta.push(`Due: ${formatDueDate(reminder.due_date)}`);
  if (meta.length > 0) {
    lines.push(`  ${meta.join(' | ')}`);
  }

  const created = (reminder.created_at instanceof Date ? reminder.created_at : new Date(reminder.created_at))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  lines.push(`  Status: ${reminder.status} | Created: ${created}`);

  // Subtasks block
  if (subtasks.length > 0) {
    const doneCount = subtasks.filter((s) => s.status === 'done').length;
    lines.push('');
    lines.push(`  Subtasks (${doneCount}/${subtasks.length} done):`);
    for (const st of subtasks) {
      lines.push(`    ${statusIcon(st.status)} ${st.content}`);
    }
  }

  // Comments block
  if (comments.length > 0) {
    lines.push('');
    lines.push('  Comments:');
    for (const c of comments) {
      const date = (c.created_at instanceof Date ? c.created_at : new Date(c.created_at))
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      lines.push(`    ${date} — ${c.content}`);
    }
  }

  return lines.join('\n');
}
