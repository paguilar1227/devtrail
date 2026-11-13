# Dev-convenience CI targets.
#
# NOTE: the CI *source of truth* is now the Dagger module (`ci/`, see docs/ci.md).
# Lefthook `pre-push` runs `dagger call ci`, and the GitHub workflow body is the
# same `dagger call ci` — so parity is guaranteed by the shared engine, not by
# these targets. These remain because the e2e (`make e2e`) isn't a Dagger gate
# yet (next pass), and because the per-step targets are handy locally.
#
#   make bootstrap   one-time per clone: deps + shared build + git hooks
#   make ci          quick native gate: typecheck + unit + build (mirrors the
#                    non-e2e Dagger gates; `dagger call ci` is the real gate)
#   make ci-full     ci + the Playwright e2e (the e2e isn't in Dagger yet)
#   make e2e         just the full-stack e2e (brings up its own stack)

.PHONY: bootstrap ci ci-full build-shared typecheck test build e2e

# One-time per clone: install workspace deps, build the shared package, and
# install the git hooks (pre-commit: staged gitleaks; pre-push: dagger call ci).
bootstrap:
	npm ci
	$(MAKE) build-shared
	npx lefthook install

# Quick native gate (typecheck + unit + build) for fast local iteration. The
# authoritative pre-push / GitHub gate is `dagger call ci` — this is its
# non-e2e subset run on the host for speed. No e2e (needs docker + browsers).
ci: build-shared typecheck test build

# ci + the Playwright e2e. The e2e is not a Dagger gate yet, so this is how you
# run the full suite (incl. e2e) before merging until it's ported.
ci-full: ci e2e

# @devtrail/shared ships compiled JS; backend tsc + vitest resolve through
# the workspace symlink, so dist/ must exist before anything else runs.
build-shared:
	npm run build --workspace=@devtrail/shared

# Backend type check (frontend is type-checked by its `build` via `tsc -b`).
typecheck:
	cd backend && npx tsc --noEmit

# Backend unit + integration (mocked DB/providers) and frontend unit (vitest).
# Note: cloud CI historically skipped the frontend unit suite — including it
# here closes that gap, and both local + cloud now run it.
test:
	cd backend && npm test
	cd frontend && npm test

# Frontend production build (tsc -b + vite build) — also the frontend typecheck.
build:
	cd frontend && npm run build

# Full-stack workflow e2e. Bring Postgres + Azurite up FIRST (idempotent:
# reuses a running stack, --wait blocks until healthy, never wipes — no
# `down -v`) so the backend the Playwright webServer launches can reach the DB
# immediately. (Playwright's globalSetup also brings the stack up, but in CI it
# raced the webServer — the backend hit Postgres on :5434 before it was up and
# the webServer timed out. Doing it here, before Playwright starts, removes the
# race; locally it's a no-op when the dev stack is already healthy.) webServer
# starts the backend + Vite, or reuses the local dev servers. Stub-mode env
# files are copied in if absent.
e2e:
	@[ -f backend/.env ] || cp backend/.env.example backend/.env
	@[ -f frontend/.env.local ] || cp frontend/.env.example frontend/.env.local
	docker compose up -d --wait
	cd frontend && npm run test:e2e:install
	cd frontend && npm run test:e2e

# Native iOS shell smoke — LOCAL-ONLY (needs macOS + Xcode + simulator + idb;
# cloud CI has no macOS runner on the free tier). Run before merging anything
# that touches the shell, nativeConfig, api.ts, or mobile layout.
ios-smoke:
	bash scripts/ios-smoke.sh
