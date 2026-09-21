import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyglotExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";
import { ExecdBackend } from "../../src/exec-backend.js";

// A recording stand-in for `agent-sandbox`. It writes its own argv and cwd to
// $FAKE_LOG, then behaves as the test asks via three env vars. This exercises
// the path through #spawn that ExecdBackend drives: output capture, the
// bounded-call backstop timer (armed at timeout + EXECD_TIMEOUT_GRACE_MS),
// the background-call local timer and its detach branch, and interpret()'s
// exit-124-vs-elapsed-time check — all without nono or a live execd. It does
// NOT exercise the byte cap or a non-backgrounded call's process-tree kill
// (killTree): no test here pushes output past the cap or lets a bounded
// call's local timer fire before the process exits on its own.
//
// Probe-aware: since Step 5, `execute()` resolves runtimes by calling
// `backend.detectRuntimes()` first, which sends its own `agent-sandbox exec`
// invocation (a one-line shell script containing `command -v`) ahead of the
// "real" one under test. If that probe were answered with whatever
// FAKE_STDOUT/FAKE_EXIT a test set for the real call, it would parse to an
// empty (or failed) runtime map and `buildCommand()` would throw before the
// real call ever ran. So a probe — detected by `command -v` appearing in its
// command line — is answered with a fixed, healthy runtime map and exit 0,
// unconditionally, regardless of FAKE_STDOUT/FAKE_EXIT/FAKE_STDERR. A
// non-probe call keeps today's behaviour exactly. The probe is still logged
// to FAKE_LOG (so a regression that drops the probe, or that lets it leak
// into the real call, is still observable) — see `calls()`'s doc comment for
// how each suite accounts for it.
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  argv,
  cwd: process.cwd(),
}) + "\\n");
const isProbe = argv.some((a) => a.includes("command -v"));
if (isProbe) {
  process.stdout.write([
    "javascript\\t/usr/bin/node",
    "typescript\\t/usr/bin/node",
    "python\\t/usr/bin/python3",
    "shell\\t/bin/bash",
    "ruby\\t/usr/bin/ruby",
    "go\\t/usr/bin/go",
    "rust\\t/usr/bin/rustc",
    "php\\t/usr/bin/php",
    "perl\\t/usr/bin/perl",
    "r\\t/usr/bin/Rscript",
    "elixir\\t/usr/bin/elixir",
    "csharp\\t/usr/bin/dotnet-script",
    "",
  ].join("\\n"));
  process.exit(0);
}
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
const delay = Number(process.env.FAKE_DELAY_MS || "0");
const code = Number(process.env.FAKE_EXIT || "0");
if (delay > 0) setTimeout(() => process.exit(code), delay);
else process.exit(code);
`;

// Today's plain fake, with no probe special-casing — FAKE_STDOUT/FAKE_EXIT/
// FAKE_STDERR drive every invocation's response unconditionally. Swapped in
// for the `ExecdBackend.detectRuntimes` describe block below, whose tests
// exercise the probe itself and need direct control over what it returns
// (including making it fail) rather than the canned response above.
const PLAIN_FAKE = `#!/usr/bin/env node
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
let scriptPath: string;
let logPath: string;
let originalPath: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "ctx-fake-as-"));
  logPath = join(binDir, "calls.log");
  scriptPath = join(binDir, "agent-sandbox");
  writeFileSync(scriptPath, FAKE, { mode: 0o755 });
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

// Raw, unfiltered log of every `agent-sandbox` invocation — including the
// runtime-detection probe `execute()` now issues before the real call. Kept
// unfiltered (rather than hiding the probe here) because the
// `ExecdBackend.detectRuntimes` suite below calls this same helper to assert
// on the probe itself. In the "through #spawn" suite below, index 0 is
// always the probe — each test there builds a fresh executor, so the cache
// is empty and exactly one probe precedes the real call(s); tests account
// for that leading entry explicitly (see the comments at each call site).
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
    // Index 0 is the runtime-detection probe execute() now issues before
    // the real call (its own agent-sandbox invocation, containing
    // "command -v"). Asserted explicitly here — rather than just skipping
    // ahead to index 1 — so a regression that drops the probe entirely, or
    // that lets a probe answer leak into the real call's slot, still fails
    // this test instead of being silently absorbed by the index shift.
    const [probe, call] = calls();
    expect(probe.argv.some(a => a.includes("command -v"))).toBe(true);
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
      // false mismatch. calls()[0] is the runtime-detection probe (run with
      // no explicit cwd, so it reflects wherever the test process happens to
      // be), not the real call — calls()[1] is the one that ran in cwd.
      expect(realpathSync(calls()[1].cwd)).toBe(realpathSync(projectRoot));
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
      // calls()[0] is the runtime-detection probe; the background call under
      // test is calls()[1].
      const [, call] = calls();
      expect(call.argv).not.toContain("--timeout");
      expect(r.timedOut).toBe(true);
      expect(r.backgrounded).toBe(true);
    } finally {
      bgExecutor.cleanupBackgrounded();
    }
  }, 10_000);

  // `#compileAndRun` (rust) has two spawn sites of its own — compiling, then
  // running the binary — neither of which is `execute()`'s single call into
  // `#runViaBackend`. This is the only place that proves both go through the
  // backend too: the fake never actually compiles anything, so this is host-
  // independent even on a machine with no rustc at all. The `runtimes: {
  // ..., rust: "rustc" }` passed to the constructor below is NOT what makes
  // this host-independent, and is not even consulted: under ExecdBackend,
  // execute() resolves runtimes by calling `backend.detectRuntimes()`
  // instead of using the constructor-injected map (see execute()'s comment
  // on "Detection must happen where execution happens"). What actually makes
  // this host-independent is the probe-aware FAKE above answering every
  // probe with its own fixed, healthy map — including a canned `rust` entry
  // — regardless of what's really installed.
  //
  // The fake's default exit is 0 (`reset()` deletes FAKE_EXIT, and the fake
  // computes `Number(process.env.FAKE_EXIT || "0")`), so the "compile" call
  // reports success without being asked to — which is exactly what's needed
  // here, since `#compileAndRun` only issues the second (run) call when the
  // first (compile) call's exitCode is 0.
  test("rust compiles and runs through agent-sandbox exec, not a direct execFileSync/#spawn", async () => {
    const executor = new PolyglotExecutor({
      runtimes: { ...detectRuntimes(), rust: "rustc" },
      env: {
        CONTEXT_MODE_EXEC_BACKEND: "execd",
        AGENT_SANDBOX_EXECD_SOCKET: "/run/fake-execd.sock",
      },
    });
    const r = await executor.execute({
      language: "rust",
      code: `fn main() { println!("42"); }`,
      timeout: 4000,
    });
    expect(r.exitCode).toBe(0);

    // recorded[0] is the runtime-detection probe execute() issues before
    // #compileAndRun's own two calls (compile, then run) — three total.
    const recorded = calls();
    expect(recorded).toHaveLength(3);
    const [, compileCall, runCall] = recorded;

    // Both calls went through `agent-sandbox exec -- …`, quoted, exactly
    // like every other language — not a bare `rustc`/binary spawn.
    for (const call of [compileCall, runCall]) {
      expect(call.argv[0]).toBe("exec");
      expect(call.argv).toContain("--timeout");
      expect(call.argv[call.argv.indexOf("--timeout") + 1]).toBe("4000ms");
      expect(call.argv[call.argv.length - 2]).toBe("--");
    }

    // First call: `rustc <script.rs> -o <binary>`.
    const compileLine = compileCall.argv[compileCall.argv.length - 1];
    expect(compileLine).toMatch(/^'rustc' '.*\/script\.rs' '-o' '.*\/script'$/);

    // Second call: the compiled binary, invoked alone.
    const runLine = runCall.argv[runCall.argv.length - 1];
    expect(runLine).toMatch(/^'.*\/script'$/);
    expect(runLine).not.toContain("rustc");
  });
});

// INVARIANT: this describe block must stay the LAST one in this file.
//
// Its nested beforeAll/afterAll swap the on-disk agent-sandbox fake from the
// probe-aware FAKE (used by every describe block above) to PLAIN_FAKE for
// the duration of these tests, then swap the probe-aware FAKE back. That
// restore is what keeps the swap safe — but nothing enforces it running.
// vitest runs a file's describe blocks in declaration order and this file
// has nothing declared after this block, so there is currently no test that
// could observe the wrong fake if the restore were skipped (a thrown
// afterAll, a killed process). Adding a describe block below this one would
// silently inherit PLAIN_FAKE — no probe special-casing, so any test there
// that goes through PolyglotExecutor.execute() (like the "through #spawn"
// suite above) would fail the same way Step 5 broke this file before the
// harness was made probe-aware. If a block ever needs to go after this one,
// give it its own local fake swap rather than relying on this one's cleanup.
describe.skipIf(process.platform === "win32")("ExecdBackend.detectRuntimes", () => {
  // These tests exercise the probe itself directly — including making it
  // fail — so they need FAKE_STDOUT/FAKE_EXIT/FAKE_STDERR to drive the
  // probe's response unconditionally, which is exactly PLAIN_FAKE's
  // behaviour (today's fake, with no probe special-casing). Swap it in for
  // the duration of this describe block only; restore the probe-aware FAKE
  // on the way out so it doesn't leak into other test files reusing binDir's
  // PATH entry within the same run.
  let probeAwareFake: string;

  beforeAll(() => {
    probeAwareFake = readFileSync(scriptPath, "utf-8");
    writeFileSync(scriptPath, PLAIN_FAKE, { mode: 0o755 });
  });

  afterAll(() => {
    writeFileSync(scriptPath, probeAwareFake, { mode: 0o755 });
  });

  test("probes every runtime in a single agent-sandbox invocation", async () => {
    reset();
    // The fake replies with a probe result for two languages and nothing else.
    process.env.FAKE_STDOUT = "javascript\t/usr/bin/node\npython\t/usr/bin/python3\n";
    const backend = new ExecdBackend("/run/fake-execd.sock");
    const map = await backend.detectRuntimes();
    expect(map.javascript).toBe("/usr/bin/node");
    expect(map.python).toBe("/usr/bin/python3");
    expect(map.ruby).toBeNull();
    expect(calls().length).toBe(1);
  });

  test("caches, so a second call costs no further round trip", async () => {
    reset();
    process.env.FAKE_STDOUT = "javascript\t/usr/bin/node\n";
    const backend = new ExecdBackend("/run/fake-execd.sock");
    await backend.detectRuntimes();
    await backend.detectRuntimes();
    expect(calls().length).toBe(1);
  });

  // detectRuntimes() is async, so two callers can both observe an empty
  // cache before either has populated it — e.g. two concurrent ctx_execute
  // calls racing their first use of a freshly constructed ExecdBackend.
  // Without sharing the in-flight probe, both would launch their own
  // agent-sandbox invocation, breaking the "one round trip" guarantee under
  // exactly the concurrency this async conversion introduced. Started
  // together (not awaited individually first) so both observe the cache
  // empty, which is what makes this test actually exercise the race rather
  // than two sequential, already-cached calls.
  test("concurrent first calls share a single in-flight probe", async () => {
    reset();
    process.env.FAKE_STDOUT = "javascript\t/usr/bin/node\n";
    const backend = new ExecdBackend("/run/fake-execd.sock");
    const [a, b] = await Promise.all([
      backend.detectRuntimes(),
      backend.detectRuntimes(),
    ]);
    expect(a).toEqual(b);
    expect(calls().length).toBe(1);
  });

  // Reversed from the original design: a failed probe used to yield a map
  // with no runtimes (shell defaulting to "sh") rather than throwing, on the
  // theory that every execution path then fails with execd's own message.
  // That theory didn't hold — buildCommand() speaks first, with a message
  // naming the wrong machine — and the "sh" default let ctx_batch_execute
  // appear to keep working while silently running under the wrong shell. See
  // the design doc's "Error handling" section.
  test("a probe that fails throws a distinct, actionable error carrying execd's stderr", async () => {
    reset();
    process.env.FAKE_EXIT = "1";
    process.env.FAKE_STDERR = "agent-sandbox: exec daemon is not available";
    await expect(
      new ExecdBackend("/run/fake-execd.sock").detectRuntimes(),
    ).rejects.toThrow(/exec daemon is not available/);
  });

  test("a failed probe is not cached, so the next call retries rather than rejecting forever", async () => {
    reset();
    process.env.FAKE_EXIT = "1";
    process.env.FAKE_STDERR = "agent-sandbox: exec daemon is not available";
    const backend = new ExecdBackend("/run/fake-execd.sock");
    await expect(backend.detectRuntimes()).rejects.toThrow();
    expect(calls().length).toBe(1);

    // A second call after the first has failed must launch its own probe
    // rather than reusing a rejected in-flight promise forever.
    process.env.FAKE_EXIT = "0";
    process.env.FAKE_STDOUT = "javascript\t/usr/bin/node\n";
    const map = await backend.detectRuntimes();
    expect(map.javascript).toBe("/usr/bin/node");
    expect(calls().length).toBe(2);
  });
});
