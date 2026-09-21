import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PolyglotExecutor, OS_TMPDIR } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";

const runtimes = detectRuntimes();

// `command -v rustc` (what detectRuntimes() checks) only proves a binary
// resolves — on this host that's a mise shim with no toolchain installed
// behind it, so `rustc --version` fails. The two tests below need different
// guards because of that gap:
//   - the compile-SUCCESS leak test needs a working toolchain, so it is
//     guarded on `rustc --version` actually exiting 0.
//   - the compile-FAILURE leak test only needs `rustc` to resolve at all —
//     a broken shim still exercises the code path that used to leak on
//     compile failure, which is the real defect being fixed here.
function hasWorkingRustc(): boolean {
  try {
    execFileSync("rustc", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const hasRust = !!runtimes.rust;
const hasWorkingRust = hasWorkingRustc();

/**
 * `.ctx-mode-*` dirs that still contain `script.rs` — identifying a leak by
 * CONTENT, not by presence. `tests/executor/win-sandbox-782-788.test.ts`
 * snapshots the temp root before/after and diffs raw entry names, which
 * races any sibling test file concurrently creating `.ctx-mode-*` dirs under
 * vitest's parallel workers (a sibling's dir can show up in the "after"
 * snapshot before it cleans itself up) — that test is already known-flaky
 * for exactly this reason.
 *
 * Rust is the only language whose generated script file is named
 * `script.rs`, and no other concurrently-scheduled test runs rust, so a
 * sibling test's dir can never match this filter even if it's still present
 * at snapshot time — it never contains `script.rs`. A before/after diff of
 * THIS set is still needed on top of that, though: the two tests below run
 * against a real filesystem that can carry leaked `script.rs` dirs left over
 * from earlier (pre-fix) runs of this very suite, and those must not be
 * blamed on the run currently under test.
 */
function rustScriptTmpDirs(): string[] {
  return readdirSync(OS_TMPDIR)
    .filter((n) => n.startsWith(".ctx-mode-"))
    .filter((n) => existsSync(join(OS_TMPDIR, n, "script.rs")));
}

describe("rust temp directory lifetime", () => {
  // The rust branch returned above cleanupTmpDir, so a SUCCESSFUL run used to
  // leave its source and its compiled binary behind. /tmp is shared with the
  // command sandbox, so those accumulate somewhere the far side can see.
  test.skipIf(!hasWorkingRust)(
    "a successful rust run leaves no temp directory behind",
    async () => {
      const before = new Set(rustScriptTmpDirs());
      const executor = new PolyglotExecutor({ runtimes });
      const result = await executor.execute({
        language: "rust",
        code: `fn main() { println!("42"); }`,
        timeout: 90_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("42");
      const leaked = rustScriptTmpDirs().filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    },
  );

  // `execFileSync` swallowed rustc's throw into a synthesized ExecResult, so
  // execute()'s catch never fired either — this path leaked too, and it's
  // the one that actually runs on a host with only a broken rustc shim.
  test.skipIf(!hasRust)(
    "a failing compile leaves no temp directory behind",
    async () => {
      const before = new Set(rustScriptTmpDirs());
      const executor = new PolyglotExecutor({ runtimes });
      const result = await executor.execute({
        language: "rust",
        code: `fn main() { this is not rust }`,
        timeout: 90_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
      const leaked = rustScriptTmpDirs().filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    },
  );
});
