import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  quoteForPosixShell,
  quoteArgvAsCommandLine,
} from "../src/shell-quote.js";
import {
  LocalBackend,
  ExecdBackend,
  EXECD_TIMEOUT_GRACE_MS,
  buildRuntimeProbeScript,
  parseRuntimeProbeOutput,
} from "../src/exec-backend.js";
import { buildShellScriptContent } from "../src/executor.js";
import type { ExecResult } from "../src/types.js";

describe("quoteArgvAsCommandLine", () => {
  test("joins a plain argv", () => {
    expect(quoteArgvAsCommandLine(["node", "/tmp/x.js"]))
      .toBe("'node' '/tmp/x.js'");
  });

  test("quotes a path containing a space", () => {
    expect(quoteArgvAsCommandLine(["node", "/tmp/a b/x.js"]))
      .toBe("'node' '/tmp/a b/x.js'");
  });

  test("escapes an embedded single quote", () => {
    expect(quoteForPosixShell("it's")).toBe(`'it'\\''s'`);
  });

  test("neutralises shell metacharacters", () => {
    const line = quoteArgvAsCommandLine(["echo", "$HOME `id` *; rm -rf /"]);
    expect(line).toBe(`'echo' '$HOME \`id\` *; rm -rf /'`);
  });

  test("keeps a newline inside the argument", () => {
    expect(quoteArgvAsCommandLine(["printf", "a\nb"])).toBe("'printf' 'a\nb'");
  });

  test("an empty argument survives as an empty quoted word", () => {
    expect(quoteArgvAsCommandLine(["cmd", ""])).toBe("'cmd' ''");
  });
});

// The round trip catches character classes nobody thought to enumerate:
// quote an argv, hand the line to a real shell, and read back what the
// shell actually split it into.
describe("quoteArgvAsCommandLine round trip through a real shell", () => {
  const cases: string[][] = [
    ["printf", "%s\\n", "plain"],
    ["printf", "%s\\n", "with space"],
    ["printf", "%s\\n", "it's"],
    ["printf", "%s\\n", "$HOME"],
    ["printf", "%s\\n", "`id`"],
    ["printf", "%s\\n", "a*b?c[d]"],
    ["printf", "%s\\n", 'double"quote'],
    ["printf", "%s\\n", "back\\slash"],
    ["printf", "%s\\n", "semi;colon|pipe&amp"],
    ["printf", "%s\\n", "tab\there"],
  ];

  test.skipIf(process.platform === "win32")(
    "each argument reaches the command unchanged",
    () => {
      for (const argv of cases) {
        const line = quoteArgvAsCommandLine(argv);
        const out = execFileSync("/bin/sh", ["-c", line], { encoding: "utf-8" });
        expect(out).toBe(argv[2] + "\n");
      }
    },
  );
});

// buildRuntimeProbeScript() is a plain string, so a unit test on the string
// itself cannot catch a bug in how a real shell interprets it. On this repo's
// own host (no dotnet-script on PATH, which is the normal case), the
// unfixed generator produced a `;`-joined line whose LAST candidate loop
// (csharp/dotnet-script) exits non-zero because nothing satisfies it, and
// that becomes the whole line's exit status — even though every other
// language that could be found, was. That made `execFileAsync` in
// `#probeRuntimes()` reject a perfectly good stdout and discard it, so a real
// `execute()` call under ExecdBackend threw "No JavaScript runtime
// available…" on every normal host. The fix terminates the line with an
// explicit `exit 0` so the probe's own exit status only reflects whether the
// probe could be RUN at all, not which languages it happened to find.
describe("buildRuntimeProbeScript through a real shell", () => {
  test.skipIf(process.platform === "win32")(
    "exits 0 and its output parses into a map with at least a shell entry",
    () => {
      const script = buildRuntimeProbeScript();
      const result = execFileSync("/bin/sh", ["-c", script], {
        encoding: "utf-8",
      });
      // execFileSync throws on a non-zero exit, so simply not throwing here
      // is itself part of what's being asserted — a redundant explicit check
      // makes that intent visible rather than implicit in "didn't throw".
      const map = parseRuntimeProbeOutput(result);
      // `shell` always resolves: every POSIX host running this test has at
      // least `sh`, and EXECD_PROBE_TARGETS lists both `bash` and `sh` as
      // candidates.
      expect(typeof map.shell).toBe("string");
      expect(map.shell).not.toBe("");
    },
  );
});

const RAW: ExecResult = {
  stdout: "out", stderr: "err", exitCode: 7, timedOut: false,
};

describe("LocalBackend", () => {
  const backend = new LocalBackend();

  test("kind is local", () => {
    expect(backend.kind).toBe("local");
  });

  test("prepare passes the argv through untouched", () => {
    const argv = ["node", "/tmp/a b/x.js"];
    expect(backend.prepare(argv, 5000, false)).toEqual({
      argv: ["node", "/tmp/a b/x.js"],
      spawnTimeout: 5000,
    });
  });

  test("prepare preserves an absent timeout as absent", () => {
    expect(backend.prepare(["node"], undefined, false).spawnTimeout)
      .toBeUndefined();
  });

  test("background changes nothing locally", () => {
    expect(backend.prepare(["node"], 5000, true).spawnTimeout).toBe(5000);
  });

  test("interpret passes the result through untouched", () => {
    expect(backend.interpret(RAW, 10_000, 5000)).toEqual(RAW);
  });
});

import { resolveBackendConfig } from "../src/exec-backend.js";

describe("resolveBackendConfig", () => {
  test("unset selects local", () => {
    expect(resolveBackendConfig({})).toEqual({ kind: "local" });
  });

  test('explicit "local" selects local', () => {
    expect(resolveBackendConfig({ CONTEXT_MODE_EXEC_BACKEND: "local" }))
      .toEqual({ kind: "local" });
  });

  test('"execd" with a socket selects execd and carries the path', () => {
    expect(resolveBackendConfig({
      CONTEXT_MODE_EXEC_BACKEND: "execd",
      AGENT_SANDBOX_EXECD_SOCKET: "/run/execd.sock",
    })).toEqual({ kind: "execd", socketPath: "/run/execd.sock" });
  });

  // The two below are the whole of fail-closed. They assert that NO fallback
  // happens — a silent downgrade to local is the exact failure this design
  // exists to prevent, so these must never be relaxed into a warning.
  test('"execd" without a socket throws rather than falling back', () => {
    expect(() => resolveBackendConfig({ CONTEXT_MODE_EXEC_BACKEND: "execd" }))
      .toThrow(/AGENT_SANDBOX_EXECD_SOCKET/);
  });

  test("an unknown value throws rather than falling back", () => {
    expect(() => resolveBackendConfig({ CONTEXT_MODE_EXEC_BACKEND: "brokerr" }))
      .toThrow(/brokerr/);
  });

  test("an empty socket value is treated as absent", () => {
    expect(() => resolveBackendConfig({
      CONTEXT_MODE_EXEC_BACKEND: "execd",
      AGENT_SANDBOX_EXECD_SOCKET: "",
    })).toThrow(/AGENT_SANDBOX_EXECD_SOCKET/);
  });
});

describe("ExecdBackend.prepare", () => {
  const backend = new ExecdBackend("/run/execd.sock");

  test("wraps the argv as one quoted command line", () => {
    expect(backend.prepare(["node", "/tmp/x.js"], undefined, false).argv)
      .toEqual(["agent-sandbox", "exec", "--", "'node' '/tmp/x.js'"]);
  });

  test("passes the caller's timeout to execd in milliseconds", () => {
    expect(backend.prepare(["node", "/tmp/x.js"], 3000, false).argv).toEqual([
      "agent-sandbox", "exec", "--timeout", "3000ms", "--", "'node' '/tmp/x.js'",
    ]);
  });

  test("omits --timeout entirely when the caller bounded nothing", () => {
    expect(backend.prepare(["node"], undefined, false).argv)
      .not.toContain("--timeout");
  });

  test("the local timer is the caller's timeout plus the drain grace", () => {
    expect(backend.prepare(["node"], 3000, false).spawnTimeout)
      .toBe(3000 + EXECD_TIMEOUT_GRACE_MS);
  });

  test("no caller timeout means no local timer either", () => {
    expect(backend.prepare(["node"], undefined, false).spawnTimeout)
      .toBeUndefined();
  });

  test("a path with a space cannot re-split the command line", () => {
    expect(
      backend.prepare(["/opt/my runtime/node", "/tmp/x.js"], undefined, false).argv[3],
    ).toBe("'/opt/my runtime/node' '/tmp/x.js'");
  });

  // Backgrounding means "leave it running past the timeout". A server-side
  // --timeout would tear the process down at exactly the moment we wanted to
  // detach from it, so a backgrounded call carries no execd deadline at all.
  test("a backgrounded call sends no --timeout to execd", () => {
    expect(backend.prepare(["node"], 3000, true).argv)
      .not.toContain("--timeout");
  });

  test("a backgrounded call keeps the local timer at the caller's timeout", () => {
    expect(backend.prepare(["node"], 3000, true).spawnTimeout).toBe(3000);
  });
});

describe("ExecdBackend.interpret", () => {
  const backend = new ExecdBackend("/run/execd.sock");
  const withCode = (exitCode: number) => ({
    stdout: "", stderr: "", exitCode, timedOut: false,
  });

  // These two are the discriminator the design turns on: 124 is execd's
  // timeout status, but a script may exit 124 on its own. The exit code alone
  // therefore never decides it — the measured elapsed time does.
  test("exit 124 at or past the deadline is a timeout", () => {
    expect(backend.interpret(withCode(124), 3000, 3000).timedOut).toBe(true);
  });

  test("exit 124 before the deadline is the script's own status", () => {
    expect(backend.interpret(withCode(124), 500, 3000).timedOut).toBe(false);
  });

  test("exit 124 with no deadline set is never a timeout", () => {
    expect(backend.interpret(withCode(124), 999_999, undefined).timedOut)
      .toBe(false);
  });

  test("a non-124 status is passed through even past the deadline", () => {
    expect(backend.interpret(withCode(1), 9999, 3000).timedOut).toBe(false);
  });

  test("a timeout #spawn already detected is preserved", () => {
    const raw = { stdout: "", stderr: "", exitCode: 1, timedOut: true };
    expect(backend.interpret(raw, 9999, 3000).timedOut).toBe(true);
  });

  test("stdout and stderr are never rewritten", () => {
    const raw = {
      stdout: "data",
      stderr: "agent-sandbox: refused: ...",
      exitCode: 126,
      timedOut: false,
    };
    const out = backend.interpret(raw, 10, 3000);
    expect(out.stdout).toBe("data");
    expect(out.stderr).toBe("agent-sandbox: refused: ...");
    expect(out.exitCode).toBe(126);
  });
});

describe("PATH injection", () => {
  test("the PATH line is written when this process's PATH applies", () => {
    expect(buildShellScriptContent("echo hi", "/usr/bin", "linux", true))
      .toBe("export PATH='/usr/bin'\necho hi");
  });

  // Under ExecdBackend the script runs on the far side of the boundary, where
  // the command profile decides the environment. Exporting our PATH there
  // writes a value describing the wrong machine.
  test("the PATH line is omitted when it does not", () => {
    expect(buildShellScriptContent("echo hi", "/usr/bin", "linux", false))
      .toBe("echo hi");
  });

  test("existing three-argument callers keep the injection", () => {
    expect(buildShellScriptContent("echo hi", "/usr/bin", "linux"))
      .toContain("export PATH=");
  });
});

// Recursively lists every `.ts` file under `dir`, relative-to-cwd paths, so
// both containment tests below actually match what their titles claim
// ("any MCP tool schema") instead of a hardcoded subset that misses schemas
// living in src/adapters/openclaw/mcp-tools.ts, src/adapters/pi/mcp-bridge.ts
// and src/adapters/opencode/plugin.ts.
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("backendOverride containment", () => {
  // The exemption is deliberate but it is still a hole: ctx_fetch_and_index
  // performs agent-supplied network egress with the agent sandbox's grants.
  // One call site is the whole of it, and growth must be noticed here rather
  // than in a review six months from now.
  //
  // Globs src/**/*.ts (rather than a hand-picked list of files) so the test
  // actually matches its own claim of "exactly one production call site" —
  // containment does hold repo-wide today, so this should stay green.
  test("exactly one production call site sets backendOverride", () => {
    const sources = listTsFiles("src").map(p => readFileSync(p, "utf-8"));
    const uses = sources.join("\n").split("\n")
      .filter(l => l.includes("backendOverride:"));
    expect(uses.length).toBe(1);
    expect(uses[0]).toContain('"local"');
  });

  test("backendOverride is not advertised in any MCP tool schema", () => {
    // An agent able to name its own backend could choose "local" and step
    // around the sandbox, so this must never reach a tool's input schema.
    //
    // Tool schemas in this codebase are NOT all built the same way: server.ts
    // uses Zod (`z.object({ ... })`, fields like `z.string()`/`z.enum([...])`),
    // but src/adapters/openclaw/mcp-tools.ts hand-rolls its own JSON-Schema-
    // like `OpenClawToolParameters` object instead — so a check for the Zod
    // shape alone (`backendOverride: z.enum(...)`) would pass even if someone
    // added `backendOverride: { type: "string" }` to that file's `properties`.
    // So this checks every source line that mentions the property and
    // requires each one to be one of a short, explicit allowlist — never an
    // unrecognised shape, which is what a new schema field would be.
    //
    // Schemas live in more than src/server.ts — src/adapters/openclaw/
    // mcp-tools.ts, src/adapters/pi/mcp-bridge.ts and src/adapters/opencode/
    // plugin.ts all declare or forward tool schemas of their own — so this
    // globs every .ts file under src/ to actually match the title's claim of
    // "any", rather than a hand-picked subset that could miss one.
    const files = listTsFiles("src");
    const mentions = files.flatMap((path) => {
      const content = readFileSync(path, "utf-8");
      return content.split("\n")
        .filter(l => l.includes("backendOverride"))
        .map(line => ({ path, line }));
    });
    expect(mentions.length).toBeGreaterThan(0); // sanity: the property exists at all

    for (const { path, line } of mentions) {
      const trimmed = line.trim();
      const isComment = trimmed.startsWith("//") || trimmed.startsWith("*");
      // The one place backendOverride is actually set: a plain string
      // literal, not a validator call.
      const isSanctionedCallSite = /backendOverride:\s*"local"\s*,?\s*$/.test(trimmed);
      // The seam's own type declaration in ExecuteOptions
      // (src/executor.ts) — `backendOverride?: "local";`. Note the `?`
      // right after the name: this is deliberately a DIFFERENT pattern from
      // isSanctionedCallSite above (which requires "backendOverride:" with
      // no "?"), so a schema field written as `backendOverride?: z.enum(...)`
      // would not slip through by matching this instead.
      const isTypeDeclaration = /^backendOverride\?:\s*"local";?\s*$/.test(trimmed);
      // The seam's own internal read of the field — `opts.backendOverride`
      // in execute(). A property READ can't be a schema declaration; the
      // `(?!\s*:)` keeps this from also matching a hypothetical
      // `.backendOverride: ...` schema-field shorthand.
      const isInternalRead = /\.backendOverride\b(?!\s*:)/.test(trimmed);
      expect(
        isComment || isSanctionedCallSite || isTypeDeclaration || isInternalRead,
        `unexpected backendOverride mention in ${path}: ${line}`,
      ).toBe(true);
    }

    // Explicit belt-and-suspenders for the Zod-schema files specifically: no
    // validator (or any function call) is ever attached to the key — that
    // would mean it became a schema field.
    const schemaFieldPattern = /backendOverride\s*:\s*z\.\w+\(/;
    const hasSchemaField = files.some((path) =>
      readFileSync(path, "utf-8").split("\n").some(l => schemaFieldPattern.test(l)),
    );
    expect(hasSchemaField).toBe(false);
  });
});
