import { realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { testDetailsSchema, type TestDetails } from "../../core/execution/test-details.js";

export function nodeTestArguments(command: string, args: string[], root = process.cwd()): string[] | undefined {
  let executable: string | undefined;
  for (const candidate of command.includes("/") ? [command] : (process.env["PATH"] ?? "").split(delimiter).map(dir => join(dir, command))) {
    try { executable = realpathSync(resolve(root, candidate)); break; } catch { /* Match actual PATH lookup without executing candidates. */ }
  }
  if (executable !== realpathSync(process.execPath) || args[0] !== "--test"
    || /--(?:test-(?:reporter|watch|rerun|only)|watch)\b/.test(process.env["NODE_OPTIONS"] ?? "")
    || args.some(arg => /^--test-(reporter|watch|rerun|only)/.test(arg)) || args.includes("--watch")) return undefined;
  return ["--test-reporter=" + new URL("./node-test-reporter.js", import.meta.url).href, ...args];
}

export function testCollector(supported: boolean) {
  const chunks: Buffer[] = [];
  let bytes = 0, overflow = false;
  return {
    add(chunk: Buffer) { bytes += chunk.length; if (bytes <= 16384) chunks.push(chunk); else overflow = true; },
    finish(complete: boolean): TestDetails {
      if (!supported) return { status: "not_collected", reason: "unsupported_command" };
      if (!complete) return { status: "not_collected", reason: "interrupted" };
      if (overflow) return { status: "not_collected", reason: "limit_exceeded" };
      if (!bytes) return { status: "not_collected", reason: "missing_summary" };
      try { return testDetailsSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { return { status: "not_collected", reason: "invalid_report" }; }
    },
  };
}
