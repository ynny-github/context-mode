import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  quoteForPosixShell,
  quoteArgvAsCommandLine,
} from "../src/shell-quote.js";
import { LocalBackend, ExecdBackend, EXECD_TIMEOUT_GRACE_MS } from "../src/exec-backend.js";
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
