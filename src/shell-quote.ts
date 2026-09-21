/**
 * POSIX shell quoting, in its own unit so both the executor (which embeds a
 * PATH assignment into generated shell scripts) and the exec backends (which
 * fold an argv into one command line for `agent-sandbox exec`) can use it
 * without a circular import.
 */

/**
 * Wrap `value` in single quotes, escaping any single quote inside it. Single
 * quoting is total in POSIX shells: nothing inside expands, so this is safe
 * for arbitrary bytes rather than a metacharacter denylist.
 */
export function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Fold an argv into a single shell command line.
 *
 * execd takes a command *line*, not an argv, and interprets the shell language
 * itself. Every element is quoted — including argv[0] — so that a runtime path
 * containing a space, a glob character or a quote cannot re-split into a
 * different command than the one `buildCommand()` chose.
 */
export function quoteArgvAsCommandLine(argv: string[]): string {
  return argv.map(quoteForPosixShell).join(" ");
}
