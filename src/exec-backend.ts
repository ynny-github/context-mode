import { detectRuntimes, type RuntimeMap } from "./runtime.js";
import type { ExecResult } from "./types.js";

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
 * governs `execute()`'s call to `#spawn`; `#compileAndRun`'s own `#spawn`
 * call (for the compiled Rust binary) does not yet go through a backend —
 * routing it through this seam is later work.
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
