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

  // `r.timedOut` alone doesn't discriminate execd actually enforcing
  // `--timeout` from execd ignoring it entirely: `#spawn`'s own local timer
  // sets the identical `timedOut: true` if execd never answers and the
  // 2000 + EXECD_TIMEOUT_GRACE_MS (5000) = 7000ms backstop fires instead —
  // `ExecdBackend#interpret()` short-circuits on `if (raw.timedOut) return
  // raw` before it ever gets to look at the exit code. So this also bounds
  // the elapsed time: execd's own deadline is 2000ms, with "up to a couple
  // of seconds" of documented drain lag on top (worst case ~4000ms);
  // 6000ms sits above that with ~2s of margin while staying a full second
  // below the 7000ms backstop, so a result that took 6s+ can only mean the
  // local backstop fired, not execd's `--timeout`.
  test("a timeout is reported as a timeout", async () => {
    const start = Date.now();
    const r = await executor().execute({
      language: "shell", code: "sleep 30", timeout: 2000,
    });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(6000);
  });

  // Not `executor().runtimes` — that getter returns the LOCAL map this
  // process's own constructor computed (`this.#runtimes` in
  // src/executor.ts, seeded from `detectRuntimes()` at construction time).
  // It never touches the backend at all, so asserting on it here would pass
  // or fail independent of whether execd, the socket, or the probe round
  // trip work. `execute()` only calls `backend.detectRuntimes()` when the
  // picked backend is non-local (see the `runtimes = backend.kind ===
  // "local" ? this.#runtimes : await backend.detectRuntimes()` branch in
  // executor.ts), so every case in this file already sends a probe first.
  //
  // The javascript/python cases above are the strongest evidence that the
  // probe worked: `buildCommand()` throws "No JavaScript/Python runtime
  // available" when its RuntimeMap entry is null, and a wholly failed probe
  // (ExecdBackend#probeRuntimes's catch branch) reports every language as
  // null except `shell`, which defaults to the bareword "sh" — so those two
  // cases would fail closed (a thrown error, not a passing assertion) if
  // detection silently came back empty. `shell` can't reuse that "throws on
  // null" property since it never throws, so this case checks something
  // else about the same round trip instead: that the probe script the
  // backend sends (`buildRuntimeProbeScript()`) is well-formed enough for
  // the far-side shell to actually execute `command -v` and produce
  // parseable output — a probe that came back garbled or truncated would
  // most likely still resolve `runtimes.shell` to *something* (real or
  // fallback), but this exercises the specific `command -v` line, not just
  // "some shell ran".
  //
  // What this does NOT exercise: `>`, `&&`, and `/dev/null` here never pass
  // through argv quoting. `buildCommand()`'s shell case returns
  // `[runtimes.shell, filePath]` — only the shell binary and the script's
  // *path* — and `ExecdBackend#prepare()` quotes exactly that two-element
  // array. The metacharacters live in the script FILE's content, which the
  // remote shell parses when it reads the file, not in anything
  // `quoteArgvAsCommandLine` ever sees. So the residual value here over the
  // plain "shell runs through execd" case above is narrower than it might
  // look: it's "the remote shell parses ordinary control operators in a
  // file it's given," not "quoting survives shell metacharacters."
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
