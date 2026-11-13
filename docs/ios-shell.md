# iOS shell — one codebase, web + native

**Branch:** `feat/ios-app` · **Date:** 2026-07-30 · **Status:** built, simulator-verified end-to-end

DevTrail now runs as a native iOS app. The same `frontend/` codebase — literally the same
Vite `dist/` bundle Hono serves on the web — is wrapped in a **Capacitor 8** WKWebView shell
(`frontend/ios/`, Swift Package Manager, no CocoaPods). Nothing about the web app changed
behaviorally; the native shell adds a thin runtime-config layer.

## Stack decision

| Option | Verdict |
|---|---|
| **Capacitor 8** ✅ | Reuses `frontend/src` byte-for-byte. Web build unchanged, `ios/` is ~scaffold only. Current stable major (8.4.2, Jul 2026), SPM-based, Xcode 26 ready. |
| React Native + react-native-web | Full UI rewrite; "one codebase" would mean porting every component. |
| Flutter | Second codebase entirely (Dart); the April pre-pivot Flutter decision predates the V2 web app and no longer applies. |

## Architecture

- **Web:** requests stay same-origin (`apiOrigin()` → `''`). Prod auth = Easy Auth cookie →
  `/api/auth/token` exchange, exactly as before.
- **Native:** the bundle loads from `capacitor://localhost`, so there is no same origin. A
  first-run **connect screen** collects the server URL + API key, verifies the pair against
  `GET /api/v1/stats`, and persists both in localStorage. `bootAuth()` gates on them via
  `NativeSetupRequired`; logout = full disconnect (clears origin + key).
- **Native-only surface is deliberately thin:** only `frontend/src/lib/nativeConfig.ts`
  imports `@capacitor/*`. Everything else asks it: `isNativeApp()`, `apiOrigin()`,
  `fetchCredentials()`.

## Bugs found by the simulator e2e (both fixed + regression-tested)

1. **CORS × credentials (native-only).** The backend answers CORS with
   `Access-Control-Allow-Origin: *`; browsers reject *credentialed* cross-origin responses
   to a wildcard. Every native API call after connect failed (`credentials: 'include'`)
   while the probe (no credentials) worked — Home rendered empty. Native now sends
   `credentials: 'omit'` (Bearer-key auth needs no cookies); web keeps `'include'`.
   Regression test: `nativeConfig.test.ts`.
2. **pg pool crash (pre-existing, backend).** `pg.Pool` had no `'error'` listener, so one
   dropped idle Postgres connection became an `uncaughtException` and killed the whole
   server — reproduced twice when the 4-week-old docker Postgres crashed/recovered under
   e2e load. Fixed in `backend/src/db/client.ts` (log + continue); proven live by
   restarting Postgres under the running backend. Regression test:
   `backend/tests/unit/db/client.test.ts`.
3. **Safe-area regression trap (CSS).** The mobile `.topbar` rule's `padding` shorthand
   reset the base rule's safe-area `padding-top`, putting the crumb under the iOS status
   bar. Pattern that works everywhere:
   `padding-top: calc(14px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))` —
   Capacitor 8 injects `--safe-area-inset-*`; both vars are 0 on desktop/mobile web.

## Build + run

See `CLAUDE.md → "iOS app (Capacitor shell)"` for the canonical loop
(`npm run build` → `npx cap sync ios` → `xcodebuild` → `simctl install/launch`).
ATS allows plain-http to local hosts only; production servers are https.

## Verification evidence (2026-07-30)

- `make ci` green: typecheck + the frontend unit suite (20 tests covering the native
  layer in `nativeConfig.test.ts`) + 4 backend db-client tests (1 new regression) + build.
- Simulator e2e (iPhone 17e, iOS 26.5), driven headlessly via idb + simctl: install →
  launch → connect screen (typed URL + key, verified against live backend) → reload →
  Home with live seeded data → Projects tab navigation. Config persists across
  relaunches and in-place updates (an uninstall clears app data — first-run
  connect again, which is exactly what `make ios-smoke` exercises). Screenshots
  embedded in the whiteboard
  ([ios-shell-board.html](./ios-shell-board.html)).
- Full Playwright web suite (`make e2e`) run for parity — verdict + failure attribution
  in the whiteboard. Known caveat: local runs share a long-lived dev DB and drift-prone
  specs exist (`project_local_db_pollution_vs_e2e`); cloud CI on merge is authoritative.

## Follow-ups (not in this branch)

- App icon + splash are Capacitor defaults.
- No push notifications, share extension, or offline cache — the shell is a viewer for a
  reachable server.
- Cloud CI does not build the iOS project (needs a macOS runner; local xcodebuild is the
  gate for now).
