// tests/unit/notifications/format-reminders.test.ts
import { describe, it, expect } from 'vitest';
import {
  formatRemindersMarkdown,
  formatReminderDetailMarkdown,
  type SubtaskCount,
} from '../../../src/notifications/format-reminders.js';
import type { ReminderRow } from '../../../src/db/reminders.js';
import type { ReminderCommentRow } from '../../../src/db/reminder-comments.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 'rem-001',
    content: 'Test task',
    embedding: [],
    metadata: null,
    category: null,
    project: null,
    section: null,
    parent_id: null,
    depth: 0,
    status: 'not_started',
    priority: null,
    source_context: null,
    source: 'mcp',
    archived: false,
    due_date: null,
    created_at: new Date('2026-03-15T10:00:00Z'),
    updated_at: new Date('2026-03-15T10:00:00Z'),
    ...overrides,
  };
}

function makeComment(overrides: Partial<ReminderCommentRow> = {}): ReminderCommentRow {
  return {
    id: 'cmt-001',
    content: 'A comment',
    embedding: [],
    reminder_id: 'rem-001',
    source: 'mcp',
    created_at: new Date('2026-03-15T12:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatRemindersMarkdown
// ---------------------------------------------------------------------------

describe('formatRemindersMarkdown', () => {
  it('returns empty state message when no reminders', () => {
    const result = formatRemindersMarkdown([]);
    expect(result).toBe('No active reminders.');
  });

  it('shows ungrouped header for reminders with no project', () => {
    const r = makeReminder({ content: 'Buy groceries' });
    const result = formatRemindersMarkdown([r]);
    expect(result).toContain('📌 Ungrouped (1 task)');
    expect(result).toContain('○ Buy groceries');
  });

  it('uses plural "tasks" for multiple items', () => {
    const reminders = [
      makeReminder({ id: 'r1', content: 'Task one' }),
      makeReminder({ id: 'r2', content: 'Task two' }),
    ];
    const result = formatRemindersMarkdown(reminders);
    expect(result).toContain('2 tasks');
  });

  it('groups reminders by project with 📋 icon', () => {
    const r = makeReminder({ content: 'Build feature', project: 'my-project' });
    const result = formatRemindersMarkdown([r]);
    expect(result).toContain('📋 my-project (1 task)');
    expect(result).toContain('○ Build feature');
  });

  it('shows correct status icons', () => {
    const statuses: Array<[string, string]> = [
      ['not_started', '○'],
      ['in_progress', '●'],
      ['researching', '🔍'],
      ['paused', '⏸'],
      ['blocked', '🚫'],
      ['done', '✓'],
      ['cancelled', '✗'],
    ];

    for (const [status, icon] of statuses) {
      const r = makeReminder({ id: `r-${status}`, status, content: `Task ${status}` });
      const result = formatRemindersMarkdown([r]);
      expect(result).toContain(`${icon} Task ${status}`);
    }
  });

  it('shows priority tag when set', () => {
    const r = makeReminder({ content: 'High priority task', priority: 'P1' });
    const result = formatRemindersMarkdown([r]);
    expect(result).toContain('[P1]');
  });

  it('omits priority tag when null', () => {
    const r = makeReminder({ content: 'Normal task', priority: null });
    const result = formatRemindersMarkdown([r]);
    expect(result).not.toContain('[P');
  });

  it('shows due date when present', () => {
    const r = makeReminder({ content: 'Task with deadline', due_date: new Date('2026-03-20T12:00:00Z') });
    const result = formatRemindersMarkdown([r]);
    expect(result).toContain('— due');
    expect(result).toContain('Mar');
  });

  it('groups multiple projects separately and sorts alphabetically', () => {
    const reminders = [
      makeReminder({ id: 'r1', content: 'Task B', project: 'zebra-project' }),
      makeReminder({ id: 'r2', content: 'Task A', project: 'alpha-project' }),
    ];
    const result = formatRemindersMarkdown(reminders);
    const alphaPos = result.indexOf('alpha-project');
    const zebraPos = result.indexOf('zebra-project');
    expect(alphaPos).toBeGreaterThanOrEqual(0);
    expect(zebraPos).toBeGreaterThanOrEqual(0);
    expect(alphaPos).toBeLessThan(zebraPos);
  });

  it('places ungrouped tasks after named projects', () => {
    const reminders = [
      makeReminder({ id: 'r1', content: 'Project task', project: 'work' }),
      makeReminder({ id: 'r2', content: 'Ungrouped task', project: null }),
    ];
    const result = formatRemindersMarkdown(reminders);
    const projectPos = result.indexOf('📋 work');
    const ungroupedPos = result.indexOf('📌 Ungrouped');
    expect(projectPos).toBeLessThan(ungroupedPos);
  });

  it('includes subtask count when provided', () => {
    const r = makeReminder({ id: 'rem-123', content: 'Parent task' });
    const counts: SubtaskCount[] = [{ reminderId: 'rem-123', total: 3, done: 1 }];
    const result = formatRemindersMarkdown([r], counts);
    expect(result).toContain('1/3 subtasks done');
  });

  it('omits subtask count when total is 0', () => {
    const r = makeReminder({ id: 'rem-123', content: 'Leaf task' });
    const counts: SubtaskCount[] = [{ reminderId: 'rem-123', total: 0, done: 0 }];
    const result = formatRemindersMarkdown([r], counts);
    expect(result).not.toContain('subtasks');
  });

  it('indents task content under project header', () => {
    const r = makeReminder({ content: 'Some task', project: 'proj' });
    const result = formatRemindersMarkdown([r]);
    // Task line must start with two spaces of indentation
    expect(result).toMatch(/^\s+[○●🔍⏸🚫✓✗]/m);
  });
});

// ---------------------------------------------------------------------------
// formatReminderDetailMarkdown
// ---------------------------------------------------------------------------

describe('formatReminderDetailMarkdown', () => {
  it('shows task content and status icon', () => {
    const r = makeReminder({ content: 'Do the thing', status: 'in_progress' });
    const result = formatReminderDetailMarkdown(r, [], []);
    expect(result).toContain('● Do the thing');
  });

  it('shows priority in header', () => {
    const r = makeReminder({ content: 'Urgent task', priority: 'P2' });
    const result = formatReminderDetailMarkdown(r, [], []);
    expect(result).toContain('[P2]');
  });

  it('shows project and section in meta line', () => {
    const r = makeReminder({ content: 'Task', project: 'meals', section: 'prep' });
    const result = formatReminderDetailMarkdown(r, [], []);
    expect(result).toContain('Project: meals');
    expect(result).toContain('Section: prep');
  });

  it('shows due date in meta line', () => {
    const r = makeReminder({ content: 'Task', due_date: new Date('2026-03-20T12:00:00Z') });
    const result = formatReminderDetailMarkdown(r, [], []);
    expect(result).toContain('Due:');
    expect(result).toContain('Mar 20');
  });

  it('shows status and created date', () => {
    const r = makeReminder({ content: 'Task', status: 'paused', created_at: new Date('2026-03-15T12:00:00Z') });
    const result = formatReminderDetailMarkdown(r, [], []);
    expect(result).toContain('Status: paused');
    expect(result).toContain('Created: Mar 15');
  });

  it('shows subtasks with done count', () => {
    const r = makeReminder({ content: 'Parent task' });
    const subtasks = [
      makeReminder({ id: 'st-1', content: 'Research recipes', status: 'done', depth: 1 }),
      makeReminder({ id: 'st-2', content: 'Buy ingredients', status: 'done', depth: 1 }),
      makeReminder({ id: 'st-3', content: 'Cook batch', status: 'not_started', depth: 1 }),
    ];
    const result = formatReminderDetailMarkdown(r, [], subtasks);
    expect(result).toContain('Subtasks (2/3 done)');
    expect(result).toContain('✓ Research recipes');
    expect(result).toContain('✓ Buy ingredients');
    expect(result).toContain('○ Cook batch');
  });

  it('indents subtasks under the Subtasks header', () => {
    const r = makeReminder({ content: 'Parent' });
    const st = makeReminder({ id: 'st-1', content: 'Child task', status: 'not_started', depth: 1 });
    const result = formatReminderDetailMarkdown(r, [], [st]);
    expect(result).toMatch(/^\s+○ Child task/m);
  });

  it('shows comments with date and content', () => {
    const r = makeReminder({ content: 'Task' });
    const comment = makeComment({
      content: 'Found a great recipe blog',
      created_at: new Date('2026-03-15T12:00:00Z'),
    });
    const result = formatReminderDetailMarkdown(r, [comment], []);
    expect(result).toContain('Comments:');
    expect(result).toContain('Mar 15 — Found a great recipe blog');
  });

  it('omits subtasks section when there are none', () => {
    const r = makeReminder({ content: 'Solo task' });
    const result = formatReminderDetailMarkdown(r, [], []);
    expect(result).not.toContain('Subtasks');
  });

  it('omits comments section when there are none', () => {
    const r = makeReminder({ content: 'Solo task' });
    const result = formatReminderDetailMarkdown(r, [], []);
    expect(result).not.toContain('Comments');
  });
});
