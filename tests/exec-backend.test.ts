import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  quoteForPosixShell,
  quoteArgvAsCommandLine,
} from "../src/shell-quote.js";
import { LocalBackend } from "../src/exec-backend.js";
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
