---
paths:
  - "frontend/**"
---

# Frontend rules — Vite + React web client

Loads when working in `frontend/`. Drawer composition pattern, compact-row pattern, e2e test setup.

## Drawer composition — body vs chrome

Drawers (`components/primitives.tsx` → `Drawer`) wrap a body. When a drawer's body might be embedded inside ANOTHER drawer's body (e.g. `DocReaderBody` inside `DocListDrawer`'s detail view), extract the body into its own component and keep the standalone `*Drawer` as a thin wrapper:

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

This pattern is in `components/modals/DocReaderDrawer.tsx`. NoteListDrawer / TodoListDrawer don't follow it yet — they bounce to a new modal when a row is clicked, which loses list state. Worth propagating.

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

Run a single spec:
```bash
cd frontend && npx playwright test desktop/documents/doc-preview.spec.ts
```

Single project (skip the other device profile):
```bash
cd frontend && npx playwright test --project=chromium-desktop
```
