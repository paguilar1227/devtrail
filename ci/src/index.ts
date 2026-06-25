/**
 * Open Brain v2 — CI gate.
 *
 * One Dagger module that runs identically on a laptop and on GitHub. Each gate
 * wraps the command the repo already runs (see the Makefile); `ci` composes
 * them. Lefthook runs `dagger call ci` on pre-push; the GitHub workflow's `ci`
 * job is the same `dagger call ci` — so a green local run means a green GitHub
 * run. The Playwright e2e (compose-backed) is intentionally NOT here yet — it's
 * the next phase (flakiness work + service bindings).
 */
import { dag, Container, Directory, object, func, argument } from "@dagger.io/dagger"

// Pinned images (never :latest) — hermetic steps = local == GitHub.
const NODE = "node:20-bookworm-slim" // repo targets Node 20 (.nvmrc / CLAUDE.md)
const GITLEAKS = "zricethezav/gitleaks:v8.30.1"
const TRIVY = "aquasec/trivy:0.58.1"

// Keep the mounted context small (mirrors .daggerignore). Local env files are
// excluded so a locally-created backend/.env (a gitignored dev artifact) can't
// trip the gitleaks gate — Dagger doesn't honor .gitignore. .env.example IS
// committed and stays in the mount (scanned + path-allowlisted in gitleaks.toml).
const IGNORE = [
  ".git",
  ".env",
  ".env.local",
  "**/.env",
  "**/.env.local",
  "node_modules",
  "**/node_modules",
  // Stale nested workspace lockfiles — npm workspaces uses the ROOT lock (the
  // Dockerfile/Makefile/CI all run root `npm ci`), so these are never consulted
  // by the build/deploy. Frozen at old versions, they only yield trivy
  // false-positives; the gate scans the authoritative root lock.
  "backend/package-lock.json",
  "frontend/package-lock.json",
  "dist",
  "**/dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".playwright-mcp",
  "ci/sdk",
  "**/*.png",
  "**/*.mp4",
  "**/*.webm",
]

@object()
export class Ci {
  /**
   * Node container with all workspace deps installed and @open-brain/shared
   * built — the backend tsc + both vitest suites + the frontend build all
   * resolve through the workspace symlink, so dist/ must exist first.
   */
  base(source: Directory): Container {
    return dag
      .container()
      .from(NODE)
      .withMountedCache("/root/.npm", dag.cacheVolume("ob-npm-cache"))
      .withDirectory("/app", source)
      .withWorkdir("/app")
      .withExec(["npm", "ci"])
      .withExec(["npm", "run", "build", "--workspace=@open-brain/shared"])
  }

  /** Backend type-check (the frontend is type-checked by its build via tsc -b). */
  @func()
  async typecheck(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    return this.base(source).withExec(["sh", "-c", "cd backend && npx tsc --noEmit"]).stdout()
  }

  /** Backend + frontend unit/integration tests (vitest; DB/providers mocked). */
  @func()
  async testUnit(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    return this.base(source)
      .withExec(["sh", "-c", "cd backend && npm test"])
      .withExec(["sh", "-c", "cd frontend && npm test"])
      .stdout()
  }

  /** Frontend production build (tsc -b + vite build) — also the FE type-check. */
  @func()
  async build(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    return this.base(source).withExec(["sh", "-c", "cd frontend && npm run build"]).stdout()
  }

  /**
   * All three checks GATE (fail the build):
   *  - gitleaks    — no secrets in the working tree.
   *  - trivy fs    — no *fixable* HIGH/CRITICAL dependency CVEs (--ignore-unfixed
   *                  so only actionable findings block; scans the authoritative
   *                  root lock — stale nested workspace locks are mount-excluded).
   *  - npm audit   — no HIGH+ advisories.
   * Promoted from report-only once the tree hit 0 findings (Phase C of the
   * dependency remediation; see CI.md). Escape valve for an unfixable/accepted
   * CVE: pin a patched version via npm `overrides` (preferred — see root
   * package.json) or add a .trivyignore entry; bypass a local push in a pinch
   * with `LEFTHOOK=0 git push`.
   */
  @func()
  async security(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    // GATE: no secrets in the working tree. `dir` scans the tree (the mount
    // excludes .git); allowlist lives in gitleaks.toml. useEntrypoint runs the
    // image's `gitleaks` entrypoint. Throws (fails the gate) on any leak.
    const leaks = await dag
      .container()
      .from(GITLEAKS)
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["dir", ".", "--config", "gitleaks.toml", "--no-banner", "--redact"], {
        useEntrypoint: true,
      })
      .stdout()

    // GATE: --exit-code 1 fails on a fixable HIGH/CRITICAL CVE. --ignore-unfixed
    // so only actionable findings block (can't fix what has no patch yet).
    const trivy = await dag
      .container()
      .from(TRIVY)
      .withMountedCache("/root/.cache/trivy", dag.cacheVolume("ob-trivy-cache"))
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(
        ["fs", "--severity", "HIGH,CRITICAL", "--scanners", "vuln", "--ignore-unfixed", "--exit-code", "1", "."],
        { useEntrypoint: true },
      )
      .stdout()

    // GATE: no `|| true` — a HIGH+ advisory exits non-zero and fails the gate.
    const audit = await this.base(source)
      .withExec(["sh", "-c", "npm audit --audit-level=high"])
      .stdout()

    return [
      "── gitleaks (secrets — gating) ──",
      leaks || "(clean)",
      "── trivy fs (dependency CVEs — gating, fixable HIGH/CRITICAL) ──",
      trivy || "(clean)",
      "── npm audit (gating, HIGH+) ──",
      audit,
    ].join("\n\n")
  }

  /**
   * The full merge gate — every check that must pass. This is the single
   * entrypoint the GitHub workflow and the Lefthook pre-push both call.
   */
  @func()
  async ci(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    const out: string[] = []
    out.push(await this.typecheck(source))
    out.push(await this.testUnit(source))
    out.push(await this.build(source))
    out.push(await this.security(source))
    return out.join("\n\n")
  }
}
