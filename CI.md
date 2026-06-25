# CI

This repo uses the owner's **local-ci** standard: one uniform gate (a Dagger module
in `ci/`) run locally via Lefthook and mirrored by a thin GitHub Actions
workflow. A green local `dagger call ci` means a green GitHub run — same engine
(Dagger v0.21.6, pinned both sides), same result.

## Resolved gates

| Gate | Enabled | Tooling |
|------|---------|---------|
| `lint`            | ➖ no    | No formatter/linter configured in-repo (no eslint/biome/prettier). Add here if one is adopted. |
| `typecheck`       | ✅ yes   | `tsc --noEmit` (backend); the frontend is type-checked by its `tsc -b` build. Runs after `@open-brain/shared` is built. |
| `security`        | ✅ yes   | **gitleaks** (secrets) · **trivy fs** + **npm audit** (dependency CVEs) — **all gating** (see below) |
| `test-unit`       | ✅ yes   | **vitest** — backend v3 (`backend && npm test`) + frontend v4 (`frontend && npm test`); DB/providers mocked |
| `test-functional` | ➖ not yet | Playwright e2e exists (`frontend/tests/e2e/**`) but is **deferred** — added as a Dagger gate in the next pass once its flakiness is fixed |
| `test-integration`| ➖ not yet | Compose-backed (Postgres + Azurite) — added with `test-functional` via Dagger service bindings |
| `build`           | ✅ yes   | **vite 8 build** (`frontend && npm run build` = `tsc -b` + `vite build`; Rolldown bundler) |

> Gates not enabled have no matching code in this repo (lint), or are
> intentionally deferred to the next phase (the e2e gates) — by design.

### Security: all gating ✅

All three checks **fail the build**:

- **gitleaks** — a staged/committed secret. Allowlist of known non-secrets
  (Azurite public dev key, model IDs) in `gitleaks.toml`.
- **trivy fs** — a *fixable* HIGH/CRITICAL dependency CVE (`--ignore-unfixed`, so
  only actionable findings block).
- **npm audit** — a HIGH+ advisory.

Promoted from report-only after the dependency-remediation pass took the tree to
**0 findings** (`npm audit` clean; trivy clean). Transitive CVEs whose parents
hadn't shipped a fix are pinned to patched versions via npm **`overrides`** in the
root `package.json` (axios, fast-uri, esbuild, …) — drop an entry once its parent
upgrades past the advisory.

**Escape valve** for an unfixable / accepted CVE: pin a patched version via npm
`overrides` (preferred), or add a `.trivyignore` entry; bypass a single local
push in a pinch with `LEFTHOOK=0 git push`.

> **Note — stale nested lockfiles.** `backend/package-lock.json` and
> `frontend/package-lock.json` are tracked **cruft**: this is an npm *workspaces*
> repo, so the root `package-lock.json` is authoritative (the Dockerfile,
> Makefile, and CI all run root `npm ci`). The nested locks are frozen at old
> versions and produce trivy false-positives, so they're **mount-excluded** from
> the gate (`.daggerignore`). They're safe to delete from the repo for hygiene
> (nothing in the build/deploy path consults them — the root `build:frontend`
> convenience script's `cd frontend && npm install` is the only thing that would
> regenerate one, and it isn't used by CI/Docker).

## Run it

```bash
# Full gate (what GitHub runs):
dagger call ci

# A single gate:
dagger call typecheck
dagger call test-unit
dagger call build
dagger call security

# Install the git hooks (once; also part of `make bootstrap`):
lefthook install
```

- **On commit** (feature branch): fast native `gitleaks protect --staged` (<2s).
- **On push** (feature branch): full `dagger call ci` — the parity gate.
- **On GitHub**: `push: main` + `workflow_dispatch` run the same `dagger call ci`
  (no per-PR trigger — the local pre-push gate covers PRs; keeps Actions minutes
  from burning. See CLAUDE.md "CI model").

The Makefile targets (`make ci` / `make ci-full`) still exist for the e2e flow
and dev convenience, but **Dagger is the CI source of truth** — the GitHub job
body is only `dagger call ci`.

## Profiling

- Budget: `ci` should finish in **< 20 min** (enforced by `timeout-minutes` in
  `.github/workflows/ci.yml`). Old e2e CI was ~26-37 min; dropping e2e from the
  gate is the headline easing.
- Traces: set the `DAGGER_CLOUD_TOKEN` repo secret to get per-step OpenTelemetry
  timings (free single-user tier). See the slow gate, fix the slow gate.

## Deploy

Deploy runs **only post-merge on `main`** via `deploy.yml` (Docker → ACR →
Azure Container Apps, Azure OIDC). OIDC can't be validated locally, so deploy is
**not** part of `ci` — it's a separate workflow, by design.
