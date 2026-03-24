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
// Due date display — "Fri, Mar 20, 2026" or "Mar 20" (short, no weekday)
// ---------------------------------------------------------------------------

function formatDueDate(date: Date | null): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  // Include time if it's not midnight (i.e., a specific time was set)
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
  if (hasTime) {
    const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${datePart} at ${timePart}`;
  }
  return datePart;
}

// Short variant without weekday — used by detail view
function formatDueDateShort(date: Date | null): string {
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
// Subtask count helper (kept for backward compatibility)
// ---------------------------------------------------------------------------

export interface SubtaskCount {
  reminderId: string;
  total: number;
  done: number;
}

// ---------------------------------------------------------------------------
// formatSingleReminder
// Format a single reminder row as a one-liner: icon + content + priority + due + id
// ---------------------------------------------------------------------------

export function formatSingleReminder(r: ReminderRow): string {
  const icon = statusIcon(r.status);
  const pTag = priorityTag(r.priority);
  const due = r.due_date ? ` — due ${formatDueDate(r.due_date)}` : '';
  const id = ` (${r.id.slice(0, 8)})`;
  return `${icon} ${r.content}${pTag}${due}${id}`;
}

// ---------------------------------------------------------------------------
// formatRemindersMarkdown
// Groups by project → section, shows short IDs, subtasks indented.
// Accepts subtasks map (parent_id → children) for inline subtask display.
// ---------------------------------------------------------------------------

export function formatRemindersMarkdown(
  reminders: ReminderRow[],
  subtasks: Map<string, ReminderRow[]> = new Map(),
): string {
  if (reminders.length === 0) {
    return 'No active reminders.';
  }

  // Only show top-level reminders (depth 0) as primary items
  const topLevel = reminders.filter(r => r.depth === 0);

  // Group by project → section
  const groups = new Map<string | null, Map<string | null, ReminderRow[]>>();
  for (const r of topLevel) {
    const projKey = r.project ?? null;
    if (!groups.has(projKey)) groups.set(projKey, new Map());
    const sectionMap = groups.get(projKey)!;
    const secKey = r.section ?? null;
    if (!sectionMap.has(secKey)) sectionMap.set(secKey, []);
    sectionMap.get(secKey)!.push(r);
  }

  const lines: string[] = [];
  let globalNum = 0;

  // Sort: named projects first (alphabetically), then null/Ungrouped
  const sortedProjKeys = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  for (const projKey of sortedProjKeys) {
    const sectionMap = groups.get(projKey)!;
    const projIcon = projKey === null ? '📌' : '📋';
    const projLabel = projKey ?? 'Ungrouped';
    lines.push(`${projIcon} ${projLabel}`);

    // Sort sections: named first (alphabetically), then null (no section)
    const sortedSecKeys = [...sectionMap.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    });

    for (const secKey of sortedSecKeys) {
      const sectionReminders = sectionMap.get(secKey)!;

      if (secKey !== null) {
        lines.push(`  ${secKey}:`);
      }

      const indent = secKey !== null ? '    ' : '    ';

      for (const r of sectionReminders) {
        globalNum++;
        const icon = statusIcon(r.status);
        const pTag = priorityTag(r.priority);
        const due = r.due_date ? ` — due ${formatDueDate(r.due_date)}` : '';
        const id = ` (${r.id.slice(0, 8)})`;
        lines.push(`${indent}${globalNum}. ${icon} ${r.content}${pTag}${due}${id}`);

        // Show subtasks indented under parent
        const children = subtasks.get(r.id) ?? [];
        renderSubtasks(lines, children, subtasks, indent + '   ');
      }
    }

    lines.push('');
  }

  // Remove trailing blank line
  if (lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

function renderSubtasks(
  lines: string[],
  children: ReminderRow[],
  subtasksMap: Map<string, ReminderRow[]>,
  indent: string,
): void {
  for (const st of children) {
    const icon = statusIcon(st.status);
    const pTag = priorityTag(st.priority);
    const due = st.due_date ? ` — due ${formatDueDate(st.due_date)}` : '';
    const id = ` (${st.id.slice(0, 8)})`;
    lines.push(`${indent}↳ ${icon} ${st.content}${pTag}${due}${id}`);

    // Recurse for nested subtasks
    const grandchildren = subtasksMap.get(st.id) ?? [];
    if (grandchildren.length > 0) {
      renderSubtasks(lines, grandchildren, subtasksMap, indent + '  ');
    }
  }
}

// ---------------------------------------------------------------------------
// formatRemindersMarkdownWithSubtasks
// Kept for backward compat — delegates to the updated formatRemindersMarkdown.
// ---------------------------------------------------------------------------

export function formatRemindersMarkdownWithSubtasks(
  reminders: ReminderRow[],
  subtasksByParent: Map<string, ReminderRow[]>,
): string {
  return formatRemindersMarkdown(reminders, subtasksByParent);
}

// ---------------------------------------------------------------------------
// formatReminderDetailMarkdown
// Full single-task view with comments and subtasks.
// ---------------------------------------------------------------------------

export function formatReminderDetailMarkdown(
  reminder: ReminderRow,
  comments: ReminderCommentRow[],
  subtasks: ReminderRow[],
  timezone?: string,
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
  if (reminder.due_date) meta.push(`Due: ${formatDueDateShort(reminder.due_date)}`);
  if (meta.length > 0) {
    lines.push(`  ${meta.join(' | ')}`);
  }

  const created = (reminder.created_at instanceof Date ? reminder.created_at : new Date(reminder.created_at))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(timezone && { timeZone: timezone }) });
  lines.push(`  Status: ${reminder.status} | Created: ${created}`);

  // Subtasks block
  if (subtasks.length > 0) {
    const doneCount = subtasks.filter((s) => s.status === 'done').length;
    lines.push('');
    lines.push(`  Subtasks (${doneCount}/${subtasks.length} done):`);
    for (const st of subtasks) {
      lines.push(`    ↳ ${statusIcon(st.status)} ${st.content}`);
    }
  }

  // Comments block
  if (comments.length > 0) {
    lines.push('');
    lines.push('  Comments:');
    for (const c of comments) {
      const date = (c.created_at instanceof Date ? c.created_at : new Date(c.created_at))
        .toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timezone && { timeZone: timezone }) });
      lines.push(`    ${date} — ${c.content}`);
    }
  }

  return lines.join('\n');
}
