import { describe, test, expect } from "vitest";
import { PolyglotExecutor } from "../../src/executor.js";

// Requires a live `agent-sandbox claude` session: execd publishes its socket
// path into the environment, and the MCP server inherits it. Absent that,
// there is nothing to talk to and every case here is meaningless. This is
// the only test file in the suite that talks to a *real* execd — every other
// execd-shaped test exercises `ExecdBackend` against the recording
// stand-in in tests/executor/execd-backend.test.ts. Do not add fakes here;
// that would defeat the one thing this file is for.
const socket = process.env.AGENT_SANDBOX_EXECD_SOCKET;

function executor() {
  return new PolyglotExecutor({
    env: {
      CONTEXT_MODE_EXEC_BACKEND: "execd",
      AGENT_SANDBOX_EXECD_SOCKET: socket!,
    },
  });
}

describe.skipIf(!socket)("execd end to end", () => {
  test("shell runs through execd", async () => {
    const r = await executor().execute({
      language: "shell", code: "echo hello-from-execd", timeout: 30_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello-from-execd");
  });

  test("javascript runs through execd", async () => {
    const r = await executor().execute({
      language: "javascript", code: "console.log(6 * 7)", timeout: 30_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("42");
  });

  test("python runs through execd", async () => {
    const r = await executor().execute({
      language: "python", code: "print(6 * 7)", timeout: 30_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("42");
  });

  test("the working directory is the project root, not a temp dir", async () => {
    const r = await executor().execute({
      language: "shell", code: "pwd", timeout: 30_000,
    });
    expect(r.stdout.trim()).not.toContain(".ctx-mode-");
  });

  test("a timeout is reported as a timeout", async () => {
    const r = await executor().execute({
      language: "shell", code: "sleep 30", timeout: 2000,
    });
    expect(r.timedOut).toBe(true);
  });

  // Not `executor().runtimes` — that getter returns the LOCAL map this
  // process's own constructor computed (`this.#runtimes` in
  // src/executor.ts, seeded from `detectRuntimes()` at construction time).
  // It never touches the backend at all, so asserting on it here would pass
  // or fail independent of whether execd, the socket, or the probe round
  // trip work. `execute()` only calls `backend.detectRuntimes()` when the
  // picked backend is non-local (see the `runtimes = backend.kind ===
  // "local" ? this.#runtimes : await backend.detectRuntimes()` branch in
  // executor.ts) — so the shell/javascript/python cases above already
  // exercise the probe, but only as a side effect of needing SOME runtime.
  // This case exercises it directly: `command -v sh` only succeeds if the
  // probe script actually ran on the far side of the execd boundary and
  // resolved `sh`, so a probe that silently returned an empty RuntimeMap
  // (the failure path in ExecdBackend#probeRuntimes) would surface here as
  // a thrown "No shell runtime available"-style error before `sh` was even
  // reached, rather than a passing assertion.
  test("the probe itself resolves a runtime across the boundary", async () => {
    const r = await executor().execute({
      language: "shell", code: "command -v sh >/dev/null && echo found",
      timeout: 30_000,
    });
    expect(r.stdout.trim()).toBe("found");
  });
});

// ─────────────────────────────────────────────────────────
// Outstanding, in-session-only work (do NOT attempt outside a session):
//
// 1. Run this file from inside an `agent-sandbox claude` session:
//      npx vitest run tests/executor/execd-e2e.test.ts
//    Expected: PASS, nothing skipped. A skipped run here is not a pass.
//
// 2. Measure the one inference the design doc still carries unverified —
//    that a command invoked from a floor shell still takes its own policy
//    edge (i.e. `bash -c '...'` doesn't escape mediation once it's inside
//    an execd-run shell). From inside the same session:
//      agent-sandbox exec -- 'bash -c "git status --porcelain | head -1"'
//    Expected: it runs, and `git` is mediated rather than refused. A 126
//    refusal means the "no language gets special treatment" assumption is
//    wrong for this profile — stop and re-open the design rather than
//    working around it here. Record the outcome in the spec's "To verify
//    before implementing" section, replacing the inference with what was
//    measured.
// ─────────────────────────────────────────────────────────
