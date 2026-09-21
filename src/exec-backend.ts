import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectRuntimes, type RuntimeMap } from "./runtime.js";
import type { ExecResult } from "./types.js";
import { quoteArgvAsCommandLine } from "./shell-quote.js";

// Promisified so `ExecdBackend.detectRuntimes()` can probe without blocking
// the event loop. `execFileSync` (the Task 8 original) is synchronous and
// single-threaded Node has no other thread to serve other MCP tool calls
// while it waits — a slow or hung `agent-sandbox exec` would freeze the
// entire process for up to its 30s bound, including tools (ctx_search,
// ctx_index, …) that need execd for nothing at all.
const execFileAsync = promisify(execFile);

/** What `PolyglotExecutor` should actually spawn, and under what timer. */
export interface PreparedCommand {
  /** The argv handed to `#spawn`. */
  argv: string[];
  /**
   * The timer `#spawn` arms. It is not always the caller's timeout: a backend
   * that enforces the deadline on the far side sets its own bound here and
   * leaves this one as a backstop.
   */
  spawnTimeout: number | undefined;
}

/**
 * Where a command becomes a process.
 *
 * Both hooks are pure. `#spawn` stays the single process runner, so the
 * Windows shell handling, the output byte cap, background detach and
 * process-tree kill live in exactly one place regardless of backend. This
 * governs `execute()`'s call to `#spawn`, and — via `#runViaBackend` —
 * `#compileAndRun`'s two spawns as well (rustc itself, then the compiled
 * binary), so a rust run has no path that bypasses the backend either.
 */
export interface ExecBackend {
  readonly kind: "local" | "execd";
  /**
   * Transform the argv `buildCommand()` produced into what will be spawned.
   *
   * `background` is passed because a backend that enforces the deadline on the
   * far side must not enforce one at all for a backgrounded call: the whole
   * point of backgrounding is that the process outlives the timeout.
   */
  prepare(
    argv: string[],
    timeout: number | undefined,
    background: boolean,
  ): PreparedCommand;
  /**
   * Interpret the raw result. `elapsedMs` is measured by the caller around the
   * spawn, which is what lets a backend tell its own timeout signal apart from
   * a script that merely exited with the same code.
   */
  interpret(
    raw: ExecResult,
    elapsedMs: number,
    timeout: number | undefined,
  ): ExecResult;
  /**
   * Detect runtimes where this backend actually executes. Async because a
   * backend that probes over a socket/process boundary (ExecdBackend) must
   * not block the event loop while it waits — see the note on
   * `execFileAsync` above.
   */
  detectRuntimes(): Promise<RuntimeMap>;
}

/** Today's behaviour: spawn the argv as given, in this process's sandbox. */
export class LocalBackend implements ExecBackend {
  readonly kind = "local" as const;

  // Declared with two parameters against a three-parameter interface, which
  // TypeScript accepts: nothing about running a process here changes when the
  // caller wants it backgrounded — #spawn already handles that itself.
  prepare(argv: string[], timeout: number | undefined): PreparedCommand {
    return { argv, spawnTimeout: timeout };
  }

  interpret(raw: ExecResult): ExecResult {
    return raw;
  }

  // Never actually called in the hot path — execute() uses its own
  // constructor-injected snapshot for the local backend and only calls
  // through the interface for a non-local one — but implemented for
  // interface conformance and for anything that queries a LocalBackend
  // directly.
  async detectRuntimes(): Promise<RuntimeMap> {
    return detectRuntimes();
  }
}

/** The environment variable that selects the backend. */
export const BACKEND_ENV_VAR = "CONTEXT_MODE_EXEC_BACKEND";
/** agent-sandbox publishes the execd socket path here; we only read it. */
export const EXECD_SOCKET_ENV_VAR = "AGENT_SANDBOX_EXECD_SOCKET";

export type BackendConfig =
  | { kind: "local" }
  | { kind: "execd"; socketPath: string };

/**
 * Decide the backend from configuration alone. There is deliberately no
 * auto-detection: the presence of the execd socket does not by itself change
 * where commands run, because a backend that turns itself on is a backend
 * nobody audited.
 *
 * Every failure here throws. Falling back to "local" on a typo would silently
 * run agent-authored code with the agent sandbox's own grants, which is the
 * exact hole this backend exists to close.
 */
export function resolveBackendConfig(env: NodeJS.ProcessEnv): BackendConfig {
  const selected = env[BACKEND_ENV_VAR];
  if (selected === undefined || selected === "" || selected === "local") {
    return { kind: "local" };
  }
  if (selected === "execd") {
    const socketPath = env[EXECD_SOCKET_ENV_VAR];
    if (!socketPath) {
      throw new Error(
        `${BACKEND_ENV_VAR}=execd, but ${EXECD_SOCKET_ENV_VAR} is not set. ` +
        `The execd socket is published by an \`agent-sandbox claude\` session ` +
        `and inherited by the MCP server it spawns. Refusing to fall back to ` +
        `local execution, which would run commands outside the command profile.`,
      );
    }
    return { kind: "execd", socketPath };
  }
  throw new Error(
    `${BACKEND_ENV_VAR}=${JSON.stringify(selected)} is not a known backend. ` +
    `Use "local" or "execd". Refusing to fall back to local execution.`,
  );
}

/**
 * How much longer than execd's own deadline the local backstop waits.
 *
 * `agent-sandbox exec --timeout` documents that teardown starts at the
 * deadline but the exit can lag it "by up to a couple of seconds while output
 * drains". Five seconds clears that without leaving a genuinely hung request
 * looking alive for long.
 */
export const EXECD_TIMEOUT_GRACE_MS = 5000;

/** execd's timeout status, following GNU timeout(1). */
export const EXECD_EXIT_TIMEOUT = 124;

/**
 * The commands each language is satisfied by, in preference order: the first
 * name that resolves wins, and the resolved absolute path becomes the
 * runtime — the same rule `buildCommand()` in src/runtime.ts applies.
 *
 * This is deliberately *not* a full mirror of local detection
 * (`detectRuntimes()` in src/runtime.ts). Several things local detection does
 * are left out or done differently here, not by oversight:
 *
 * - `$SHELL`: local detection lets the user's `$SHELL` override the shell
 *   candidate. That variable describes the *agent sandbox's* environment —
 *   using it to pick the shell on the far side of the execd boundary would be
 *   wrong for exactly the reason PATH injection was wrong in Task 6: it's a
 *   fact about the wrong machine.
 * - `py`: local detection's Windows Python launcher fallback. execd targets a
 *   nono/Linux command sandbox, where `py` doesn't exist and couldn't mean
 *   anything.
 * - Python is checked with a bare `command -v` here; local detection uses
 *   `runnableExists`, which additionally runs `<cmd> --version` to filter out
 *   non-functional stubs (e.g. the Windows Store's Python alias). The probe
 *   has no way to run a second command per candidate without giving up the
 *   one-round-trip property, so it accepts `command -v`'s weaker guarantee.
 * - Bun is checked with a bare `command -v bun` here; local detection's
 *   `bunExists()`/`bunCommand()` additionally probes `bun --version` to
 *   confirm it's >= 1.0 and falls back to well-known install paths when
 *   `bun` isn't on PATH at all. The probe does neither.
 * - Local detection's resolved values are mostly *bare command names*
 *   (`"python3"`, `"bash"`, `"rustc"`, …) — whatever the caller's own PATH
 *   resolves them to at spawn time. The probe's values are the *absolute
 *   paths* `command -v` printed on the far side, because that's what a
 *   `RuntimeMap` entry from this backend has to mean: a path meaningful in
 *   execd's environment, not this process's.
 */
const EXECD_PROBE_TARGETS: Array<[keyof RuntimeMap, string[]]> = [
  ["javascript", ["bun", "node"]],
  ["typescript", ["bun", "tsx", "ts-node"]],
  ["python", ["python3", "python"]],
  ["shell", ["bash", "sh"]],
  ["ruby", ["ruby"]],
  ["go", ["go"]],
  ["rust", ["rustc"]],
  ["php", ["php"]],
  ["perl", ["perl"]],
  ["r", ["Rscript", "r"]],
  ["elixir", ["elixir"]],
  ["csharp", ["dotnet-script"]],
];

/**
 * One shell line that resolves every candidate and prints `<language>\t<path>`
 * for the first hit per language. One round trip for the whole map: probing
 * language by language would be twelve `agent-sandbox exec` invocations, each
 * paying a connection and a nono command launch.
 *
 * Exported for testing: this is a plain string, so nothing in this file
 * proves it actually behaves as intended in a real shell (exit status,
 * output shape) — see the round-trip test in tests/exec-backend.test.ts,
 * which runs it through `/bin/sh` the same way the argv-quoting round trip
 * does.
 */
export function buildRuntimeProbeScript(): string {
  const body = EXECD_PROBE_TARGETS.map(([language, candidates]) => {
    const inner = candidates
      .map(c => `p=$(command -v ${c} 2>/dev/null) && ` +
                `{ printf '${language}\\t%s\\n' "$p"; break; }`)
      .join("; ");
    return `for _ in 1; do ${inner}; done`;
  }).join("; ");
  // Each per-language `for` loop's own exit status is meaningless noise, but
  // in a `;`-joined line the LAST command's status becomes the whole line's
  // status — and the last target here is csharp/dotnet-script, absent on
  // essentially every host. Without this, a completely normal probe run
  // (every language that could be found, was) exits non-zero just because
  // the final loop found nothing, and `execFileAsync` rejects a perfectly
  // good result. Terminate with `exit 0` explicitly so only a real inability
  // to run the probe at all (agent-sandbox missing, execd unreachable, a
  // genuine script error) produces a non-zero exit.
  return `${body}; exit 0`;
}

/**
 * Baseline map `parseRuntimeProbeOutput` starts from before overlaying what
 * the probe actually found: every language absent except `shell`, which
 * defaults to `"sh"` — POSIX guarantees a `sh`, mirroring LocalBackend's own
 * bash-or-sh fallback. This is what an empty (or partially empty) probe
 * *result* looks like, i.e. a probe that ran but found nothing for some
 * languages. It is NOT what a failed probe reports — a probe that could not
 * be run at all (execd unreachable, agent-sandbox missing) now throws
 * instead of returning this map; see `ExecdBackend#probeRuntimes`. Returning
 * this on failure was the original design and was reversed: `shell: "sh"`
 * let a failure masquerade as a working backend silently running under the
 * wrong shell.
 */
function emptyRuntimeMap(): RuntimeMap {
  return {
    javascript: null, typescript: null, python: null, shell: "sh",
    ruby: null, go: null, rust: null, php: null, perl: null, r: null,
    elixir: null, csharp: null,
  };
}

/** Parse `<language>\t<path>` lines into a RuntimeMap. */
export function parseRuntimeProbeOutput(stdout: string): RuntimeMap {
  const map = emptyRuntimeMap();
  for (const line of stdout.split("\n")) {
    // Trim both parts — a stray `\r` (CRLF probe output) would otherwise end
    // up embedded in the resolved path and silently break that runtime.
    const [language, path] = line.split("\t").map(s => s.trim());
    if (!language || !path) continue;
    // hasOwnProperty rather than `in`: RuntimeMap has no prototype chain
    // worth walking, but this is the defensible idiom regardless.
    if (Object.prototype.hasOwnProperty.call(map, language)) {
      (map as unknown as Record<string, unknown>)[language] = path;
    }
  }
  return map;
}

/**
 * Runs each command through `agent-sandbox exec`, so it executes under the
 * operator's nono command profile instead of this process's own sandbox.
 *
 * Nothing here decides whether a command is permitted. That is entirely the
 * command profile's, and a refusal arrives as execd's exit status and its own
 * stderr, both passed through untouched.
 */
export class ExecdBackend implements ExecBackend {
  readonly kind = "execd" as const;

  /**
   * Held for diagnostics and to make the dependency explicit. The socket is
   * not dialled here — `agent-sandbox exec` reads the same variable from the
   * environment it inherits.
   */
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  prepare(
    argv: string[],
    timeout: number | undefined,
    background: boolean,
  ): PreparedCommand {
    const line = quoteArgvAsCommandLine(argv);

    // A backgrounded call must carry NO server-side deadline. `background`
    // means "stop waiting at T but leave the process running"; --timeout T
    // would have execd tear the process tree down at T instead, killing the
    // very process the caller asked to keep. Teardown still works without it:
    // cleanupBackgrounded() kills the client later, the connection drops, and
    // execd treats that as a cancellation.
    const bounded = timeout !== undefined && !background;
    const wrapped = bounded
      ? ["agent-sandbox", "exec", "--timeout", `${timeout}ms`, "--", line]
      : ["agent-sandbox", "exec", "--", line];

    return {
      argv: wrapped,
      // Bounded: execd owns the real deadline, ours is the backstop for an
      // execd that never answers. Backgrounded: ours is the only timer, and
      // it must fire on time, so no grace is added. Absent caller timeout
      // stays absent on both sides.
      spawnTimeout: timeout === undefined
        ? undefined
        : background
          ? timeout
          : timeout + EXECD_TIMEOUT_GRACE_MS,
    };
  }

  interpret(
    raw: ExecResult,
    elapsedMs: number,
    timeout: number | undefined,
  ): ExecResult {
    if (raw.timedOut) return raw;
    // 124 is execd's timeout status, but a script can exit 124 by itself, so
    // the status alone is not evidence. Pairing it with our own measured
    // elapsed time makes this a check rather than a guess.
    //
    // Everything else is passed through verbatim. 2, 126, 127 and 128+signum
    // are all values a real command can return, and execd's error frame is
    // collapsed to exit 1 by `agent-sandbox exec` — so there is no sound way
    // to tell a policy refusal from a script's own failure here. execd's
    // stderr already says which it was; rewriting it would only obscure that.
    if (
      timeout !== undefined &&
      raw.exitCode === EXECD_EXIT_TIMEOUT &&
      elapsedMs >= timeout
    ) {
      return { ...raw, timedOut: true };
    }
    return raw;
  }

  #runtimeCache: RuntimeMap | undefined;
  /**
   * The in-flight probe, if one is running. `detectRuntimes()` is async, so
   * two callers can both see an empty `#runtimeCache` before either has had
   * a chance to populate it — e.g. two concurrent `ctx_execute` calls racing
   * their first use of a freshly constructed `ExecdBackend`. Sharing this
   * promise means the second caller awaits the first caller's probe instead
   * of launching a redundant one: the round-trip budget this class exists to
   * hold is "one", not "one per concurrent caller".
   */
  #runtimeProbe: Promise<RuntimeMap> | undefined;

  async detectRuntimes(): Promise<RuntimeMap> {
    if (this.#runtimeCache) return this.#runtimeCache;
    if (!this.#runtimeProbe) {
      this.#runtimeProbe = this.#probeRuntimes()
        .then((map) => {
          this.#runtimeCache = map;
          return map;
        })
        .catch((err) => {
          // Only a *successful* probe is worth caching (see the field doc
          // above) — and that means this in-flight slot must not linger
          // either. Left set, every later caller would await this same
          // already-rejected promise forever, which disables every
          // non-shell language until the process restarts even though the
          // failure (an execd hiccup, a momentarily unreachable socket) may
          // have been entirely transient. Clearing it here means the next
          // call starts a fresh probe; callers already awaiting THIS probe
          // still correctly see it fail — only concurrent-first-call
          // sharing for a probe already in flight is preserved, not sharing
          // of a failure across separate calls.
          this.#runtimeProbe = undefined;
          throw err;
        });
    }
    return this.#runtimeProbe;
  }

  async #probeRuntimes(): Promise<RuntimeMap> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "agent-sandbox",
        ["exec", "--", buildRuntimeProbeScript()],
        { encoding: "utf-8", timeout: 30_000 },
      ));
    } catch (err) {
      // The probe script itself always exits 0 (see buildRuntimeProbeScript),
      // so landing here means agent-sandbox/execd failed to run it at all —
      // an unreachable socket, a refused command, agent-sandbox missing from
      // PATH (ENOENT). Node's execFile rejection still carries whatever the
      // child wrote before failing; use it rather than discarding it, since
      // stderr is normally where execd's own reason for the refusal lives.
      const execErr = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      const detail =
        execErr.stderr?.trim() || execErr.stdout?.trim() || execErr.message;
      // Thrown, not reported as "every language absent": buildCommand() in
      // src/runtime.ts would otherwise be the first thing to speak, with a
      // message naming a runtime and prescribing "Install Node.js or Bun on
      // PATH" — correct for LocalBackend, but naming the wrong machine here
      // and prescribing a fix that cannot work on this side of the execd
      // boundary. execd's own message would never surface at all. Naming
      // execd as the failing component here, with execd's own stderr
      // attached, is what actually delivers "the message tells the agent
      // retrying will not help" (see the design doc's Error handling
      // section) instead of a misleading local invention.
      throw new Error(
        `Failed to detect runtimes through execd: ${detail}. This means ` +
        `execd itself could not run the detection probe (not that a ` +
        `specific language is unavailable) — check that the agent-sandbox ` +
        `session is still up and AGENT_SANDBOX_EXECD_SOCKET points at a ` +
        `live socket.`,
      );
    }
    return parseRuntimeProbeOutput(stdout);
  }
}
