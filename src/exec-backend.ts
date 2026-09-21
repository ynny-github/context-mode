import { execFileSync } from "node:child_process";
import { detectRuntimes, type RuntimeMap } from "./runtime.js";
import type { ExecResult } from "./types.js";
import { quoteArgvAsCommandLine } from "./shell-quote.js";

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
  /** Detect runtimes where this backend actually executes. */
  detectRuntimes(): RuntimeMap;
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

  detectRuntimes(): RuntimeMap {
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
 * The commands each language is satisfied by, in preference order. Mirrors
 * `buildCommand()`'s expectations in src/runtime.ts: the first name that
 * resolves wins, and the resolved absolute path becomes the runtime.
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
  ["r", ["Rscript"]],
  ["elixir", ["elixir"]],
  ["csharp", ["dotnet-script"]],
];

/**
 * One shell line that resolves every candidate and prints `<language>\t<path>`
 * for the first hit per language. One round trip for the whole map: probing
 * language by language would be twelve `agent-sandbox exec` invocations, each
 * paying a connection and a nono command launch.
 */
function buildRuntimeProbeScript(): string {
  return EXECD_PROBE_TARGETS.map(([language, candidates]) => {
    const body = candidates
      .map(c => `p=$(command -v ${c} 2>/dev/null) && ` +
                `{ printf '${language}\\t%s\\n' "$p"; break; }`)
      .join("; ");
    return `for _ in 1; do ${body}; done`;
  }).join("; ");
}

/** Every language absent — what a failed probe reports. */
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
    const [language, path] = line.split("\t");
    if (!language || !path) continue;
    if (language in map) (map as unknown as Record<string, unknown>)[language] = path;
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

  detectRuntimes(): RuntimeMap {
    if (this.#runtimeCache) return this.#runtimeCache;
    let stdout = "";
    try {
      stdout = execFileSync(
        "agent-sandbox",
        ["exec", "--", buildRuntimeProbeScript()],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
      );
    } catch {
      // An unreachable execd, a refused probe, a missing binary: report no
      // runtimes rather than throwing. Every execution path fails with execd's
      // own message anyway, which says more than anything invented here.
      stdout = "";
    }
    this.#runtimeCache = parseRuntimeProbeOutput(stdout);
    return this.#runtimeCache;
  }
}
