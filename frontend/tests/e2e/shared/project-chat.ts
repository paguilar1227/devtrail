// Project Chat tab — RAG composer, depth pill, stub answer + citations
// (PCHAT-1..3). Uses the seeded ClaudePit project (fully ingested at seed
// time) so retrieval always has chunks; LLM_PROVIDER=stub makes the answer
// text deterministic ("[stub] Based on the retrieved context…") and drops
// the similarity floor so citations are always returned.
//
// Audit finding (untested, inert): the "Open source" button inside an
// expanded citation has no handler.

import { expect, test } from '../helpers/setup';
import { gotoProjectPage } from '../helpers/nav';
import { expectDialogTitled } from '../helpers/utils';

const PROJECT = 'ClaudePit';

export function defineProjectChatTests() {
  test('chat: empty-state suggestion chip fills the composer', async ({ page }) => {
    await gotoProjectPage(page, PROJECT);
    await expect(page.locator('.chat-empty')).toBeVisible();

    await page.locator('.chat-suggest .s', { hasText: 'How am I authenticating to Claude?' }).click();
    await expect(page.locator('.composer textarea')).toHaveValue('How am I authenticating to Claude?');
  });

  test('chat: depth pill flips active state and swaps the explainer', async ({ page }) => {
    await gotoProjectPage(page, PROJECT);
    const pill = page.locator('.composer-controls .depth-pill');
    await expect(pill.locator('button', { hasText: 'Balanced' })).toHaveClass(/active/);
    await expect(page.locator('.composer-depth-desc')).toContainText('auto-tunes');

    await pill.locator('button', { hasText: 'Shallow' }).click();
    await expect(pill.locator('button', { hasText: 'Shallow' })).toHaveClass(/active/);
    await expect(pill.locator('button', { hasText: 'Balanced' })).not.toHaveClass(/active/);
    await expect(page.locator('.composer-depth-desc')).toContainText('Fastest');
  });

  test('chat: sending a question renders the user bubble, stub answer, citations and timings', async ({ page }) => {
    await gotoProjectPage(page, PROJECT);

    await page.locator('.composer textarea').fill('What is the session model?');
    await page.keyboard.press('Enter');

    await expect(page.locator('.msg.user .msg-bubble')).toContainText('What is the session model?');
    // Stub synthesis is deterministic and fast; 15s covers a cold retrieval.
    const answer = page.locator('.msg:not(.user) .msg-bubble', { hasText: '[stub]' });
    await expect(answer).toBeVisible({ timeout: 15_000 });

    // Citations: first row expanded by default, header click collapses it.
    const firstCite = page.locator('.cite-row').first();
    await expect(firstCite).toBeVisible();
    await expect(firstCite.locator('.cite-chunk')).toBeVisible();
    await firstCite.locator('.cite-head').click();
    await expect(firstCite.locator('.cite-chunk')).toHaveCount(0);

    await expect(page.locator('.timing-foot')).toContainText('chunks');
  });

  test('chat: Open source opens the cited entity (intent fix)', async ({ page }) => {
    await gotoProjectPage(page, PROJECT);

    await page.locator('.composer textarea').fill('What is the session model?');
    await page.keyboard.press('Enter');
    const answer = page.locator('.msg:not(.user) .msg-bubble', { hasText: '[stub]' });
    await expect(answer).toBeVisible({ timeout: 15000 });

    // First citation is expanded by default; its title tells us which
    // entity surface should open (ClaudePit cites its own notes).
    const firstCite = page.locator('.cite-row').first();
    const citedTitle = (await firstCite.locator('.nm').innerText()).trim();
    await firstCite.getByRole('button', { name: 'Open source' }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    // Notes open the editor (title in an input); docs/todos carry it as text.
    await expectDialogTitled(dialog, citedTitle);
  });
}
