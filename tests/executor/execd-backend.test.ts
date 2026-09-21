import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyglotExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";

// A recording stand-in for `agent-sandbox`. It writes its own argv and cwd to
// $FAKE_LOG, then behaves as the test asks via three env vars. This exercises
// the path through #spawn that ExecdBackend drives: output capture, the
// bounded-call backstop timer (armed at timeout + EXECD_TIMEOUT_GRACE_MS),
// the background-call local timer and its detach branch, and interpret()'s
// exit-124-vs-elapsed-time check — all without nono or a live execd. It does
// NOT exercise the byte cap or a non-backgrounded call's process-tree kill
// (killTree): no test here pushes output past the cap or lets a bounded
// call's local timer fire before the process exits on its own.
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}) + "\\n");
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
const delay = Number(process.env.FAKE_DELAY_MS || "0");
const code = Number(process.env.FAKE_EXIT || "0");
if (delay > 0) setTimeout(() => process.exit(code), delay);
else process.exit(code);
`;

let binDir: string;
let logPath: string;
let originalPath: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "ctx-fake-as-"));
  logPath = join(binDir, "calls.log");
  const script = join(binDir, "agent-sandbox");
  writeFileSync(script, FAKE, { mode: 0o755 });
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.FAKE_LOG = logPath;
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.FAKE_LOG;
  rmSync(binDir, { recursive: true, force: true });
});

function calls(): Array<{ argv: string[]; cwd: string }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8").trim().split("\n")
    .filter(Boolean).map(l => JSON.parse(l));
}

function reset() {
  writeFileSync(logPath, "");
  delete process.env.FAKE_STDOUT;
  delete process.env.FAKE_STDERR;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_DELAY_MS;
}

function makeExecutor() {
  return new PolyglotExecutor({
    runtimes: detectRuntimes(),
    env: {
      CONTEXT_MODE_EXEC_BACKEND: "execd",
      AGENT_SANDBOX_EXECD_SOCKET: "/run/fake-execd.sock",
    },
  });
}

describe.skipIf(process.platform === "win32")("ExecdBackend through #spawn", () => {
  beforeEach(() => {
    reset();
  });

  test("invokes agent-sandbox exec with the quoted command line", async () => {
    process.env.FAKE_STDOUT = "hello\n";
    await makeExecutor().execute({
      language: "javascript",
      code: "console.log('ignored — the fake never runs it')",
      timeout: 4000,
    });
    const [call] = calls();
    expect(call.argv[0]).toBe("exec");
    expect(call.argv).toContain("--timeout");
    expect(call.argv[call.argv.indexOf("--timeout") + 1]).toBe("4000ms");
    expect(call.argv[call.argv.length - 2]).toBe("--");
    // Confirms the wrapper shape only (one single-quoted blob as the
    // final arg) — it would pass for 'node /tmp/x.js' just as it does for
    // 'node' '/tmp/x.js'. Exact per-word quoting is pinned separately in
    // tests/exec-backend.test.ts.
    expect(call.argv[call.argv.length - 1]).toMatch(/^'.*'$/);
  });

  test("runs the client in the project directory", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ctx-proj-"));
    try {
      await new PolyglotExecutor({
        runtimes: detectRuntimes(),
        projectRoot,
        env: {
          CONTEXT_MODE_EXEC_BACKEND: "execd",
          AGENT_SANDBOX_EXECD_SOCKET: "/run/fake-execd.sock",
        },
      }).execute({ language: "javascript", code: "", timeout: 4000 });
      // realpath both sides so a symlinked temp root (macOS /var ->
      // /private/var, or any other host-specific symlinking) doesn't cause a
      // false mismatch.
      expect(realpathSync(calls()[0].cwd)).toBe(realpathSync(projectRoot));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("stdout, stderr and exit status pass through untouched", async () => {
    process.env.FAKE_STDOUT = "out-data";
    process.env.FAKE_STDERR = "agent-sandbox: refused: policy says no";
    process.env.FAKE_EXIT = "126";
    const r = await makeExecutor().execute({
      language: "javascript", code: "", timeout: 4000,
    });
    expect(r.stdout).toBe("out-data");
    expect(r.stderr).toBe("agent-sandbox: refused: policy says no");
    expect(r.exitCode).toBe(126);
    expect(r.timedOut).toBe(false);
  });

  // The pair the design turns on. Same exit code, opposite verdicts,
  // decided by measured elapsed time rather than by the code.
  test("exit 124 past the deadline reports a timeout", async () => {
    process.env.FAKE_EXIT = "124";
    process.env.FAKE_DELAY_MS = "400";
    const r = await makeExecutor().execute({
      language: "javascript", code: "", timeout: 300,
    });
    expect(r.timedOut).toBe(true);
  });

  test("exit 124 before the deadline is the script's own status", async () => {
    process.env.FAKE_EXIT = "124";
    const r = await makeExecutor().execute({
      language: "javascript", code: "", timeout: 30_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(124);
  });

  // Task 4 wires ExecdBackend.prepare() to arm #spawn's LOCAL timer at
  // timeout + EXECD_TIMEOUT_GRACE_MS (5s) for a bounded call, so it acts as a
  // backstop for a hung execd rather than a second, shorter deadline racing
  // execd's own --timeout. Neither of the two tests above discriminates this:
  // both let the fake exit long before either candidate value elapses. Here
  // the fake's own exit (2000ms) sits strictly between the raw caller
  // timeout (300ms) and the grace-inflated one (5300ms). Correct wiring: the
  // local timer is still armed at 5300ms, so the fake's own exit wins the
  // race and this is not a timeout. Broken wiring (raw timeout fed into
  // #spawn instead of prepared.spawnTimeout): the local timer fires at
  // 300ms and kills the fake first, flipping timedOut true.
  test("the local backstop timer includes execd's grace, not the raw caller timeout", async () => {
    process.env.FAKE_EXIT = "0";
    process.env.FAKE_DELAY_MS = "2000";
    const r = await makeExecutor().execute({
      language: "javascript", code: "", timeout: 300,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  }, 10_000);

  // Confirmed against #spawn in src/executor.ts: when `background` is true,
  // the local timer's callback sets timedOut = true, adds the child's pid to
  // #backgroundedPids, unrefs it, replaces its stdout/stderr listeners with
  // no-op drains (without closing the pipes, which would SIGPIPE the child),
  // and resolves immediately with `{ ..., exitCode: 0, timedOut: true,
  // backgrounded: true }` — it does not wait for the child to exit.
  // ExecdBackend.interpret() short-circuits on raw.timedOut and returns that
  // result unchanged, so this is exactly what execute() reports. A healthy
  // backgrounded call is therefore always reported timedOut once its local
  // timer fires; that is the detach signal, not a failure — callers are
  // expected to check `backgrounded` alongside it.
  test("a backgrounded call sends no --timeout to execd and detaches at the local deadline", async () => {
    process.env.FAKE_DELAY_MS = "3000";
    const bgExecutor = makeExecutor();
    try {
      const r = await bgExecutor.execute({
        language: "javascript", code: "", timeout: 300, background: true,
      });
      const [call] = calls();
      expect(call.argv).not.toContain("--timeout");
      expect(r.timedOut).toBe(true);
      expect(r.backgrounded).toBe(true);
    } finally {
      bgExecutor.cleanupBackgrounded();
    }
  }, 10_000);
});
