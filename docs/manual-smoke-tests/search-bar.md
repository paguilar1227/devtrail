# Manual smoke test — universal search bar

Reference checklist for the search-bar UX work completed in the
2026-05-23 session (clickable result cards + predicate-only filter-only
listings). Run against `localhost:5173` with the local stack up
(Postgres on 5434, backend on 3001, `LLM_PROVIDER=stub`).

Seed data is deterministic — counts and titles below come from
`scripts/seed-local.ts`. If counts drift, the seed changed, not the
search.

Total: 24 tests across 5 sections, ~5 min if all green.

## Setup

```bash
docker compose up -d                # Postgres + Azurite
cd backend && npm run dev           # :3001
cd frontend && npm run dev          # :5173
```

Open `http://localhost:5173`.

---

## A. Click-to-open on search hits

| # | Steps | Expected |
|---|---|---|
| A1 | Type `#chore` in home search. Click the **card body** of "Tax docs checklist" (anywhere except the title) | Note editor modal opens with full body |
| A2 | Click the **title text** of "Renew domain (devtrail.local)" | Todo detail drawer opens with P1/status chips |
| A3 | Type `in:document`. Click any document card | Doc reader drawer opens |
| A4 | Type `#chore`. Click-drag to **select text in an excerpt** ("Charitable receipts"), release mouse on the card | No modal opens — selection stays highlighted, drag-to-copy preserved |
| A5 | Tab to a result card, hit Enter | Modal opens (keyboard accessibility) |

## B. Predicate-only filter-only path (the bug fix)

| # | Steps | Expected |
|---|---|---|
| B1 | Type just `#chore` (no other text) | **Exactly 4 results**, all chips read `lexical`, count chip says "4 results" — matches the `#chore 4` tag chip |
| B2 | Type just `in:todo` | Only todo entity-kind chips appear, results > 0 |
| B3 | Type just `@"Tax docs checklist"` | Exactly 1 result, that title |
| B4 | Type just `project:ClaudePit` | All hits show `ClaudePit` project label, results > 0 |
| B5 | Clear input | Dashboard returns (Personal grid + Pinned strip), no `.home-search-results` block |

## C. Hybrid path still works (no regression)

| # | Steps | Expected |
|---|---|---|
| C1 | Type `pgvector` | Multiple results, mix of `vector` / `entity` / `lexical` provenance chips |
| C2 | Type `tax #chore` | Exactly 1 result: "Tax docs checklist" |
| C3 | Type `macOS` then add ` -#reference` | "macOS keyboard shortcuts I keep forgetting" disappears between the two queries |
| C4 | Type `sample -in:document` | No document entity-kind chips in any hit |

## D. UI plumbing

| # | Steps | Expected |
|---|---|---|
| D1 | Type `tax #chore`. Click the `#chore` predicate chip | Chip disappears, input becomes `tax `, results re-run (broader set, "Tax docs checklist" still present) |
| D2 | Type `#chore`. Look at URL bar | URL has `?q=%23chore` |
| D3 | Open `http://localhost:5173/?q=%23chore&scope=all` directly in a new tab | Search is active on mount, 4 results without typing |
| D4 | Click scope chip "Personal" then "All projects" then a project name | Scope chip activates, results refresh, URL `?scope=` updates |
| D5 | Click sidebar ClaudePit → type in its search row → press Enter | Lands on home with `?q=...&scope=<uuid>`, input pre-filled, results scoped to ClaudePit |
| D6 | Press Cmd+K, type "Search", click "Search…" row | Palette dismisses, home dashboard renders (no query carried) |

## E. Misc sanity

| # | Steps | Expected |
|---|---|---|
| E1 | Type `xq42zzz` (intentional no-match) | "No results." renders, no spinner stuck |
| E2 | Type 1 char `a` | No spinner stuck, returns either dashboard mode or empty results — does NOT dump the corpus |
| E3 | Refresh page mid-search with `?q=#chore` | Search rehydrates, 4 results |
| E4 | Browser back button after navigating from a hit | Returns to search-active home with query intact |

---

## What's automated vs manual

The same 21 cases (parser-level + UI behavior + mode switch) are pinned
in `frontend/tests/e2e/desktop/home/search.spec.ts`. This manual sheet
is a sanity check before deploys — it covers a few extras the e2e
suite doesn't (E1 stuck-spinner, E3 refresh rehydrate, E4 browser back)
and gives a real human eye on the UX.

Run the automated suite with:

```bash
cd frontend && npx playwright test --project=chromium-desktop desktop/home/search.spec.ts
```

When all 24 manual tests are green, prod is safe to deploy via
`scripts/deploy.sh` (the manual az-CLI path — GH Actions is paused).
