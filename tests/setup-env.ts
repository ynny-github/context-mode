// Global vitest setup (wired via vitest.config.ts `test.setupFiles`) — runs
// once per worker process before any test file in that worker.
//
// `CONTEXT_MODE_EXEC_BACKEND` selects PolyglotExecutor's execution backend
// (src/exec-backend.ts). Every `new PolyglotExecutor(...)` that doesn't pass
// its own `env` reads it straight from `process.env` — about 140 executor
// tests across this suite, plus the construction sites in src/cli.ts and
// src/server.ts. If a developer has this exported in their shell (e.g. while
// working on the execd backend itself, or copy-pasted from this repo's own
// docs), every one of those tests would silently pick it up and either fail
// against a nonexistent `agent-sandbox` binary or need a live execd session —
// a wall of confusing, unrelated-looking failures with no hint of the actual
// cause. Pin it unset here so the suite's default behaviour never depends on
// what happens to be exported outside it.
//
// Tests that specifically want the execd backend pass `env` explicitly to
// their own PolyglotExecutor construction (see
// tests/executor/execd-backend.test.ts and tests/executor/execd-e2e.test.ts)
// rather than relying on process.env, so they are unaffected by this.
delete process.env.CONTEXT_MODE_EXEC_BACKEND;
