# Single source of truth for the CI pipeline.
#
# Both the local pre-push hook (lefthook) and the cloud workflow
# (.github/workflows/ci.yml) call these targets, so "green locally" runs the
# exact same steps as "green in CI". Iterate behind `make ci`; cloud CI only
# runs at merge / post-merge (see CLAUDE.md "CI model").
#
#   make bootstrap   one-time per clone: deps + shared build + git hooks
#   make ci          fast gate (pre-push runs this): typecheck + unit + build
#   make ci-full     everything CI runs, incl. the Playwright e2e
#   make e2e         just the full-stack e2e (brings up its own stack)

.PHONY: bootstrap ci ci-full build-shared typecheck test build e2e

# One-time per clone: install workspace deps, build the shared package, and
# install the git hooks so `pre-push` runs `make ci`.
bootstrap:
	npm ci
	$(MAKE) build-shared
	npx lefthook install

# Fast gate — what `pre-push` runs. Type-check + unit/integration + build.
# No e2e (it needs the docker stack + browsers); run `make ci-full` before
# merging, and cloud CI runs ci-full post-merge as the safety net.
ci: build-shared typecheck test build

# Full pipeline — mirrors cloud CI exactly, including the Playwright e2e.
ci-full: ci e2e

# @open-brain/shared ships compiled JS; backend tsc + vitest resolve through
# the workspace symlink, so dist/ must exist before anything else runs.
build-shared:
	npm run build --workspace=@open-brain/shared

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
