import { writeSync } from "node:fs";
import { tap } from "node:test/reporters";
import type { TestEvent } from "node:test/reporters";

// Consume test-runner events, never stdout text, error messages, stacks or assertions.
export default async function* reporter(source: AsyncIterable<TestEvent>) {
  async function* observe() {
    const failures: string[] = [];
    let truncated = false;
    for await (const event of source) {
      if (event.type === "test:fail" && !event.data.todo && !event.data.skip) {
        if (failures.length < 20) {
          const name = event.data.name.replace(/[\x00-\x1f\x7f]/g, " ");
          failures.push(name.slice(0, 200));
          if (name.length > 200) truncated = true;
        } else truncated = true;
      }
      // Per-file summaries are not the final aggregate summary.
      if (event.type === "test:summary" && event.data.file === undefined) {
        const { tests, passed, cancelled, skipped, todo, suites } = event.data.counts;
        const details = { status: "collected", framework: "node_test", counts: {
          tests, passed, failed: tests - passed - cancelled - skipped - todo, cancelled, skipped, todo, suites },
          suite_success: event.data.success, failures, failures_truncated: truncated };
        writeSync(3, JSON.stringify(details) + "\n");
      }
      yield event;
    }
  }
  yield* tap(observe());
}
