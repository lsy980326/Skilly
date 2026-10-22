import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MemoryError } from "../../core/memory/model.js";
import { nodeTestArguments, testCollector } from "./test-collector.js";

// Explicit opt-in: selecting reporters changes the invocation, never the configuration file.
export function prepareVitest(command: string, args: string[], root: string) {
  let prefix: string[], rest: string[];
  try {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules/vitest/package.json"), "utf8"));
    if (!/^3\./.test(pkg.version)) throw new Error();
    if (nodeTestArguments(command, ["--test"], root)) {
      if (!args[0] || realpathSync(resolve(root, args[0])) !== realpathSync(join(root, "node_modules/vitest/vitest.mjs")) || args[1] !== "run") throw new Error();
      prefix = args.slice(0, 2); rest = args.slice(2);
    } else if (/^(npm|npm-cli\.js)$/.test(command.split("/").at(-1) ?? "")) {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (pkg.scripts?.test !== "vitest run") throw new Error();
      const length = args[0] === "test" ? 1 : args[0] === "run" && args[1] === "test" ? 2 : 0;
      if (!length || (args.length > length && args[length] !== "--")) throw new Error();
      prefix = [...args.slice(0, length), "--"]; rest = args.slice(length + 1);
    } else throw new Error();
    if (!rest.some(arg => /^--reporter(?:s)?(?:=|$)/.test(arg))) throw new Error();
    if (rest.some(arg => /^(--watch|--ui|--api|--inspect|--standalone|--outputFile|--merge-reports|-w)(=|$)/.test(arg))) throw new Error();
  } catch { throw new MemoryError("unsupported_test_command", "Vitest collection requires installed Vitest 3, a direct node vitest.mjs run or npm test script exactly 'vitest run'. Supply the original reporter list explicitly (for example --reporter=default); configuration reporters are never guessed. Watch/server/output-file modes are unsupported. No command was run."); }
  const directory = mkdtempSync(join(tmpdir(), "skilly-vitest-")), path = join(directory, "result.json");
  return {
    args: [...prefix, ...rest, "--reporter=" + new URL("./vitest-reporter.js", import.meta.url).pathname],
    env: { ...process.env, SKILLY_TEST_RESULT_FILE: path },
    finish(complete: boolean) {
      const collector = testCollector(true);
      if (!complete) return collector.finish(false);
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 16384) return { status: "not_collected" as const, reason: "limit_exceeded" as const };
        const buffer = Buffer.alloc(16385); let length = 0;
        while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
        collector.add(buffer.subarray(0, length));
        const details = collector.finish(true);
        return details.status === "collected" && details.framework !== "vitest" ? { status: "not_collected" as const, reason: "invalid_report" as const } : details;
      } catch { return { status: "not_collected" as const, reason: "missing_summary" as const }; }
      finally { if (fd !== undefined) closeSync(fd); }
    },
    close() {
      // Only this invocation's private artifacts; never recursively remove a directory.
      try { unlinkSync(path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      rmdirSync(directory);
    },
  };
}
