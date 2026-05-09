// Due-date editing + time-aware display flow.
//
//  - The detail drawer renders a custom <DateTimePicker/> (not the
//    native <input type="datetime-local">). Trigger button shows the
//    formatted value; clicking opens a popover with month nav, day
//    grid, hour/minute inputs, AM/PM toggle, and Clear/Today/Done.
//  - Picker commits on Done — the new ISO round-trips to the backend.
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

test('todo detail: DateTimePicker commits a new time, column displays time-aware due', async ({ page }) => {
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

  // Open the detail drawer.
  await row.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });

  // Open the picker. The trigger summarizes the current value.
  const trigger = drawer.locator('.dtp-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const pop = drawer.locator('.dtp-pop');
  await expect(pop).toBeVisible();

  // Bump the time to 4:30 PM (same day) and commit. The hour input
  // accepts 1-12; selected day stays put.
  const hourInput = pop.locator('input[aria-label="Hour"]');
  await hourInput.fill('4');
  // Minute already 30; AM/PM already PM. Just commit via Done.
  await pop.getByRole('button', { name: 'Done' }).click();
  await expect(pop).toHaveCount(0);

  // Verify the new ISO timestamp persisted at the backend.
  await expect.poll(async () => {
    const todos = await listTodos();
    const after = todos.find((t) => t.id === created.id);
    if (!after?.due_date) return null;
    const d = new Date(after.due_date);
    return { h: d.getHours(), m: d.getMinutes() };
  }).toEqual({ h: 16, m: 30 });

  // Column updates to reflect the new time after refetch.
  await expect(row.locator('.ti-sub')).toContainText(`${expectedWeekday} 4:30pm`);
});

test('todo detail: DateTimePicker Clear removes the due date entirely', async ({ page }) => {
  const content = stamp() + ' Due clear';
  await createTodo(content, null, { due_date: dueAt(3, 9).toISOString() });
  await page.reload();
  await waitForAppReady(page);

  const row = page.locator(`${TODOS_COL} .prow`, { hasText: content });
  await row.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });

  // Open the picker, hit Clear. The picker's Clear button both fires
  // onChange(null) AND closes the popover.
  await drawer.locator('.dtp-trigger').click();
  const pop = drawer.locator('.dtp-pop');
  await expect(pop).toBeVisible();
  await pop.getByRole('button', { name: 'Clear' }).click();
  await expect(pop).toHaveCount(0);

  // Trigger now reads "No due date".
  await expect(drawer.locator('.dtp-trigger')).toContainText('No due date');

  // Backend reflects cleared due_date. Polling distinguishes "missing
  // row" from "still set".
  await expect.poll(async () => {
    const todos = await listTodos();
    const t = todos.find((x) => x.content === content);
    if (!t) return 'not-found';
    return t.due_date;
  }).toBeNull();

  // Row no longer shows a due meta line.
  await expect(row.locator('.ti-sub')).toHaveCount(0);
});

test('todo detail: DateTimePicker keyboard nav (arrows + Enter) commits selection', async ({ page }) => {
  const content = stamp() + ' Due keys';
  // Seed 5 days out at 9:00 AM so the day grid has a visible selection
  // we can navigate from.
  const start = dueAt(5, 9, 0);
  await createTodo(content, null, { due_date: start.toISOString() });
  await page.reload();
  await waitForAppReady(page);

  const row = page.locator(`${TODOS_COL} .prow`, { hasText: content });
  await row.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible({ timeout: 15000 });

  await drawer.locator('.dtp-trigger').click();
  const pop = drawer.locator('.dtp-pop');
  await expect(pop).toBeVisible();

  // The selected day cell receives focus on open via requestAnimationFrame
  // — wait for the focus to land before pressing keys, otherwise the
  // arrow ends up swallowed by the document. Explicitly focusing the
  // selected cell makes the test deterministic regardless of raf timing.
  const selected = pop.locator('.dtp-day.selected');
  await expect(selected).toBeVisible();
  await selected.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(pop).toHaveCount(0);

  // Persisted day should be start + 1 day, time preserved.
  const expected = new Date(start);
  expected.setDate(expected.getDate() + 1);
  await expect.poll(async () => {
    const todos = await listTodos();
    const t = todos.find((x) => x.content === content);
    if (!t?.due_date) return null;
    const d = new Date(t.due_date);
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  }).toEqual({
    y: expected.getFullYear(),
    m: expected.getMonth(),
    d: expected.getDate(),
    h: 9,
    min: 0,
  });
});
