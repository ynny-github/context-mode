import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyglotExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";

// A recording stand-in for `agent-sandbox`. It writes its own argv and cwd to
// $FAKE_LOG, then behaves as the test asks via three env vars. This exercises
// the whole path through #spawn — output capture, the byte cap, the timer,
// process-tree kill — without nono or a live execd.
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
  test("invokes agent-sandbox exec with the quoted command line", async () => {
    reset();
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
    // The last argument is one shell line, every word single-quoted.
    expect(call.argv[call.argv.length - 1]).toMatch(/^'.*'$/);
  });

  test("runs the client in the project directory", async () => {
    reset();
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
    reset();
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
    reset();
    process.env.FAKE_EXIT = "124";
    process.env.FAKE_DELAY_MS = "400";
    const r = await makeExecutor().execute({
      language: "javascript", code: "", timeout: 300,
    });
    expect(r.timedOut).toBe(true);
  });

  test("exit 124 before the deadline is the script's own status", async () => {
    reset();
    process.env.FAKE_EXIT = "124";
    const r = await makeExecutor().execute({
      language: "javascript", code: "", timeout: 30_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(124);
  });
});
