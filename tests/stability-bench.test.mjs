import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/bench-stability.mjs", import.meta.url));

test("stability benchmark rejects existing DB paths and unbounded options before setup", async () => {
  for (const args of [["--db", "/tmp/existing.sqlite"], ["--clients", "0"], ["--seconds", "Infinity"], ["--interval-ms", "0"]]) {
    await assert.rejects(exec(process.execPath, [script, ...args]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout.includes('"phase":"setup"'), false);
      return true;
    });
  }
});

test("isolated multi-process workload checks saved IDs, fresh MCP reads and resource metrics", { timeout: 30000 }, async () => {
  const { stdout } = await exec(process.execPath, [script, "--seconds", "2", "--idle-seconds", "1", "--seed-records", "20", "--clients", "2"], { timeout: 25000, maxBuffer: 1024 * 1024 });
  const result = stdout.trim().split("\n").map(line => JSON.parse(line)).find(row => row.phase === "result");
  assert.equal(result.status, "passed");
  assert.ok(result.cycles >= 2);
  assert.equal(result.acknowledged_load_records, result.cycles * 2);
  assert.equal(result.persisted_records, 20 + 20 + result.cycles * 2);
  assert.equal(result.missing_records, 0);
  assert.equal(result.pending_requests, 0);
  assert.equal(result.integrity, "ok");
  assert.equal(result.cleanup, "test_connections_closed");
  assert.equal(result.fresh_mcp_retrieved_projects, 20);
  assert.equal(result.active.processes.length, 3);
  for (const process of result.active.processes) {
    assert.ok(process.cpu_percent_one_core >= 0);
    assert.ok(process.rss_max_sampled_mib >= process.rss_start_mib);
  }
  for (const method of ["memory_checkpoint", "memory_query_context", "memory_query_overview", "http_viewer"]) {
    assert.ok(result.latency[method].count > 0);
    assert.ok(result.latency[method].p95_ms > 0);
  }
});

test("interrupting a long benchmark closes only its test connections and never reports passed", { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, [script, "--seconds", "600", "--idle-seconds", "1", "--seed-records", "0", "--clients", "1"], { stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  let output = "", signalled = false;
  child.stderr.resume();
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on("data", chunk => {
    output += chunk.toString();
    if (!signalled && output.includes('"phase":"idle_before"')) {
      signalled = true; child.kill("SIGTERM");
    }
  });
  const exit = await completed;
  assert.equal(signalled, true);
  assert.equal(exit.code, 130);
  const result = output.trim().split("\n").map(line => JSON.parse(line)).find(row => row.phase === "result");
  assert.equal(result.status, "interrupted");
  assert.equal(result.cleanup, "test_connections_closed");
});
