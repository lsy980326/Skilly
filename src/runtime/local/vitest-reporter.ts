import { writeFileSync } from "node:fs";
import { testDetailsSchema } from "../../core/execution/test-details.js";

interface TestCase { fullName: string; options: { mode?: string }; result(): { state: string }; }
interface TestModule { children: { allTests(): Iterable<TestCase>; allSuites(): Iterable<unknown> }; ok(): boolean; }

// Vitest 3's public reporter lifecycle. Never serialize task errors or assertions.
export default class SkillyVitestReporter {
  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    const path = process.env["SKILLY_TEST_RESULT_FILE"];
    if (!path) throw new Error("Run this reporter through Skilly exec --test-format vitest.");
    const counts = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
    const failures: string[] = [];
    let truncated = false, invalid = false;
    for (const module of modules) {
      for (const _suite of module.children.allSuites()) counts.suites++;
      for (const test of module.children.allTests()) {
        counts.tests++;
        const state = test.result().state;
        if (state === "passed") counts.passed++;
        else if (state === "failed") {
          counts.failed++;
          const name = test.fullName.replace(/[\x00-\x1f\x7f]/g, " ");
          if (failures.length < 20) failures.push(name.slice(0, 200)); else truncated = true;
          if (name.length > 200) truncated = true;
        } else if (state === "skipped") { if (test.options.mode === "todo") counts.todo++; else counts.skipped++; }
        else invalid = true;
      }
    }
    const details = testDetailsSchema.parse(reason === "interrupted" ? { status: "not_collected", reason: "interrupted" }
      : invalid ? { status: "not_collected", reason: "invalid_report" }
      : { status: "collected", framework: "vitest", counts, failures, failures_truncated: truncated,
        suite_success: reason === "passed" && errors.length === 0 && modules.every(module => module.ok()) });
    writeFileSync(path, JSON.stringify(details), { flag: "wx", mode: 0o600 });
  }
}
