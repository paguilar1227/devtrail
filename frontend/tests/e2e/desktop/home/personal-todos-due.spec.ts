// Due-date editing + time-aware display flow.
//
//  - The detail drawer renders a datetime-local input wired to the
//    todo's due_at, supporting time of day (not just dates).
//  - Saving the drawer round-trips the new ISO timestamp to the
//    backend (verified via REST).
//  - The column renders a time-aware due meta when the time component
//    is set ('today 3pm' / 'tomorrow 9am' / 'Tue 4:30pm') instead of
//    the date-only relative format.
//
// We control time-relative assertions by creating a todo whose due
// date falls within ~7 days so the formatter's time-aware branch
// runs deterministically.

import { expect, test } from '@playwright/test';
import { createTodo, listTodos } from '../../helpers/api';
import { stamp } from '../../helpers/setup';
import { waitForAppReady } from '../../helpers/utils';

const TODOS_COL = '.home-personal-grid .pcol:has(h3:text-is("Todos"))';

// Returns a Date that's `days` from now at the given local hour:minute.
function dueAt(days: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

test('todo detail: datetime-local input persists time, column displays time-aware due', async ({ page }) => {
  const content = stamp() + ' Due time';
  // Pick a slot 2 days out at 3:30 PM local — within the 7-day
  // window that triggers time-aware display, and avoids the
  // today/tomorrow special cases.
  const target = dueAt(2, 15, 30);
  const created = await createTodo(content, null, { due_date: target.toISOString() });

  await page.reload();
  await waitForAppReady(page);

  // Column should show a time-aware due — "<weekday> 3:30pm".
  const expectedWeekday = target.toLocaleDateString('en-US', { weekday: 'short' });
  const row = page.locator(`${TODOS_COL} .prow`, { hasText: content });
  await expect(row).toBeVisible();
  await expect(row.locator('.ti-sub')).toContainText(`${expectedWeekday} 3:30pm`);

  // Open the detail drawer and bump the time forward 1 hour (4:30 PM).
  await row.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });

  const input = drawer.locator('input[type="datetime-local"]');
  await expect(input).toBeVisible();
  // Pad helpers for datetime-local format (YYYY-MM-DDTHH:mm).
  const pad = (n: number) => n.toString().padStart(2, '0');
  const newDue = dueAt(2, 16, 30);
  const newValue = `${newDue.getFullYear()}-${pad(newDue.getMonth() + 1)}-${pad(newDue.getDate())}T${pad(newDue.getHours())}:${pad(newDue.getMinutes())}`;
  await input.fill(newValue);
  await drawer.getByRole('button', { name: /^(Save|Done)$/ }).click();
  await expect(drawer).toHaveCount(0);

  // Verify the new ISO timestamp persisted at the backend.
  const todos = await listTodos();
  const after = todos.find((t) => t.id === created.id);
  expect(after?.due_date).toBeTruthy();
  const persisted = new Date(after!.due_date as string);
  expect(persisted.getHours()).toBe(16);
  expect(persisted.getMinutes()).toBe(30);

  // Column updates to reflect the new time after refetch.
  await expect(row.locator('.ti-sub')).toContainText(`${expectedWeekday} 4:30pm`);
});

test('todo detail: clear button removes the due date entirely', async ({ page }) => {
  const content = stamp() + ' Due clear';
  await createTodo(content, null, { due_date: dueAt(3, 9).toISOString() });
  await page.reload();
  await waitForAppReady(page);

  const row = page.locator(`${TODOS_COL} .prow`, { hasText: content });
  await row.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });

  await drawer.getByRole('button', { name: 'clear' }).click();
  await drawer.getByRole('button', { name: /^(Save|Done)$/ }).click();
  await expect(drawer).toHaveCount(0);

  // Backend should reflect cleared due_date. The poll returns the
  // raw value (null when cleared, ISO string otherwise) so the
  // assertion can distinguish "missing row" from "still set".
  await expect.poll(async () => {
    const todos = await listTodos();
    const t = todos.find((x) => x.content === content);
    if (!t) return 'not-found';
    return t.due_date;
  }).toBeNull();

  // Row no longer shows a due meta line.
  await expect(row.locator('.ti-sub')).toHaveCount(0);
});
