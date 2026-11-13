---
paths:
  - "frontend/**"
---

# Frontend rules — Vite + React web client

Loads when working in `frontend/`. Drawer composition pattern, compact-row pattern, e2e test setup.

## Native shell (Capacitor iOS) — keep the surface thin

`frontend/` doubles as the iOS app via a Capacitor 8 shell (`frontend/ios/`, SPM). Rules:

- **Only `lib/nativeConfig.ts` imports `@capacitor/*`.** Everything else asks it
  (`isNativeApp()`, `apiOrigin()`); don't scatter platform checks through components.
- `apiOrigin()` MUST stay `''` on the web — the web app is same-origin by design (Vite
  proxy in dev, Hono static serving in prod). Native gets its origin from the connect
  screen (`components/ConnectScreen.tsx`), persisted in localStorage.
- After changing web code, `npx cap sync ios` re-copies `dist/` into the shell. The build
  loop lives in AGENTS.md → "iOS app (Capacitor shell)".
- New native-only behavior gets unit tests next to `nativeConfig.test.ts` (mock
  `@capacitor/core` with a mutable flag — see that file for the pattern).
- **Engine parity:** the `webkit-mobile` Playwright project reruns a curated slice of
  mobile specs on WebKit (the shell's engine). Widen its `testMatch` list when adding
  mobile workflows that matter on iOS. `make ios-smoke` covers the true native context —
  it pins coordinates to the iPhone 17e layout, so update `scripts/ios-smoke.sh` if the
  connect screen or Home composer moves.
- **idb setup (needed by `make ios-smoke`):** the fb-idb Python client crashes under
  Python 3.14 — install it under 3.12:
  `brew tap facebook/fb && brew trust --formula facebook/fb/idb-companion && brew install facebook/fb/idb-companion` and
  `/opt/homebrew/opt/python@3.12/bin/python3.12 -m pip install --user --break-system-packages fb-idb`
  (client lands at `~/Library/Python/3.12/bin/idb`, where the script looks for it).

## Drawer composition — body vs chrome

Drawers (`components/primitives.tsx` → `Drawer`) wrap a body. When a drawer's body might be embedded inside ANOTHER drawer's body, extract the body into its own component and keep the standalone `*Drawer` as a thin wrapper:

```tsx
export function DocReaderBody({ doc, onClose, onBack, onRoute }) {
  return (
    <>
      {onBack ? <BackButton onClick={onBack} /> : null}
      {/* …rest of reader content… */}
    </>
  );
}

export function DocReaderDrawer({ doc, onClose, onRoute }) {
  return (
    <Drawer title={doc.title} onClose={onClose}>
      <DocReaderBody doc={doc} onClose={onClose} onRoute={onRoute} />
    </Drawer>
  );
}
```

- `onClose` = close the *containing* drawer entirely (used by destination navigation like project chips)
- `onBack` (optional) = return to a parent view within the same drawer (renders a back button)
- `onRoute` (optional) = navigate routes; passed through to nested body

This pattern is in `components/modals/DocReaderDrawer.tsx` (the `*ListDrawer`s that used to embed these bodies were retired in the Home-tabs consolidation — the pattern still applies to any future embedded-body drawer).

## Shared browse panels (`components/panels/`)

`TodosPanel`, `NotesPanel`, `DocumentsPanel` are THE browse surfaces, parameterized by a
scope (`'personal' | 'all' | <project uuid>`). Home's tabs and the project page's tabs both
render them — do not fork a per-surface list again; extend the panel. TodosPanel is the one
todo-list implementation (SectionedTodoList: durable `section` + `manual_order`, drag,
quick-add, Done group). Home folds ask-the-brain into its search box (Enter → `/rag` over
the effective scope, answer card above results) — there is deliberately no separate chat
surface on Home. The standalone Todos page (sidebar → Todos) survives as a thin shell —
heading + scope dropdown — over TodosPanel; the Notes folder browser page remains a
distinct surface.

## Compact row pattern (`.prow`)

`TodoRow`, `NoteRow`, `DocRow` all use a shared `.prow` base class. Layout differs per type via `.prow-todo`, `.prow-note`, `.prow-doc` grid-template-columns overrides.

Constraints (shared, in `styles.css` `.prow .ti`):
- Title clamps at **2 lines** via `-webkit-line-clamp: 2` + `display: -webkit-box`
- Always set `title={textContent}` on the title div so the full title shows on hover
- Click handler → opens detail view (drawer or inline)

When adding a new row component, set the grid-template-columns on a `.prow-<kind>` class and include the title attribute on `.ti`.

## Drawer body scroll — pinned chrome pattern

`.drawer-body` is `display: flex; flex-direction: column` with `overflow-y: auto` as fallback. Doc reader uses `.doc-reader-content` (flex: 1; min-height: 0; overflow-y: auto) so the chrome (chips, metadata, action row) stays pinned while the body content scrolls internally. Without `min-height: 0` on the flex-1 child, it won't shrink and the inner scroll won't engage.

If you ever want a sibling drawer to also pin its chrome, mirror the pattern: wrap the scrollable content in a `flex: 1; min-height: 0; overflow-y: auto` container.

## SAS-signed URLs from the backend

`blob_url` (for inline preview) and `download_url` (for save-to-disk) come pre-signed. The HTML `download` attribute is ignored by browsers for cross-origin URLs, so don't rely on it for Azure-hosted blobs — the backend's `getDownloadSasUrl` adds the `rscd` SAS param to set `Content-Disposition: attachment` server-side, which is what actually triggers the save dialog.

For note-as-doc rows (text only — no `blob_url`), synthesize a same-origin `blob:` URL from the markdown body with `URL.createObjectURL(new Blob([body], { type: 'text/markdown' }))`. Same-origin blob URLs honor the `download` attribute directly. Revoke on unmount.

## E2E tests — Playwright workflow suite

Located in `frontend/tests/e2e/`. Two devices:
- `chromium-desktop` (1440×900) → `tests/e2e/desktop/**`
- `chromium-mobile` (Pixel 7) → `tests/e2e/mobile/**`

`globalSetup` runs `docker compose up` (Postgres + Azurite) and seeds via `scripts/seed-local.ts`. `playwright.config.ts` reuses an existing dev server if one is running on :3001 + :5173, otherwise spawns one. Stub-mode providers (`LLM_PROVIDER=stub`) keep runs fast and deterministic — no upstream API keys needed.

Tests should walk real user click paths (sidebar → tab → row → drawer → action), not assert component shape. Bug fixes get a regression e2e at the surface where the bug appeared.

**Import `test`/`expect` from `tests/e2e/helpers/setup.ts`, never from `@playwright/test`.** The setup module exports a `test` extended with a page fixture that does the goto/app-ready setup and the `e2e:`-prefix sweep. Do NOT register `beforeEach`/`afterEach` from a shared helper module as an import side effect: Playwright caches helper modules per worker, so those hooks only attach to the first spec file a worker loads — every later file runs its first test hook-less against `about:blank` and "flakes" (this was the parked ~26-flaky mystery, root-caused + fixed July 2026). Type-only imports (`type Page`, `type Locator`) still come from `@playwright/test`.

**Parity pattern:** cross-device workflows live in `tests/e2e/shared/*.ts` as `define*Tests()` suites; thin wrappers in `desktop/**` and `mobile/**` invoke them. Navigation differences are absorbed by `helpers/nav.ts` (`gotoView`, `gotoProjectPage`, `openSettings`, `selectTagChip`). Coverage matrix: `docs/testing/e2e-coverage-plan.md`.

Run a single spec:
```bash
cd frontend && npx playwright test desktop/documents/doc-preview.spec.ts
```

Single project (skip the other device profile):
```bash
cd frontend && npx playwright test --project=chromium-desktop
```
