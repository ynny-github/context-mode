import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  quoteForPosixShell,
  quoteArgvAsCommandLine,
} from "../src/shell-quote.js";

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
