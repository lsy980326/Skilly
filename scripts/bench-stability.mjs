// Synthetic local workload only: never accepts a live DB or project path.
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir, platform, arch, cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHistogram, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openLocal } from "../dist/runtime/local/app.js";
import { manageViewer } from "../dist/runtime/local/viewer-manager.js";

const { values } = parseArgs({ options: {
  seconds: { type: "string", default: "600" }, clients: { type: "string", default: "4" },
  "idle-seconds": { type: "string", default: "30" }, "seed-records": { type: "string", default: "10000" },
  "interval-ms": { type: "string", default: "250" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("npm run bench:stability -- [--seconds 600] [--clients 4] [--idle-seconds 30] [--seed-records 10000] [--interval-ms 250]\nCreates and retains a synthetic temporary DB. Prints metrics to stdout; never accepts an existing DB. macOS/Linux ps required.");
  process.exit(0);
}
function integer(key, min, max) {
  const value = Number(values[key]);
  if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid --${key}: ${min}–${max}`);
  return value;
}
const seconds = integer("seconds", 1, 86400), clientCount = integer("clients", 1, 8);
const idleSeconds = integer("idle-seconds", 1, 300), seedRecords = integer("seed-records", 0, 100000);
const intervalMs = integer("interval-ms", 50, 60000);
if (!["darwin", "linux"].includes(platform())) throw new Error("This benchmark requires macOS/Linux ps.");
const directory = mkdtempSync(join(tmpdir(), "skilly-stability-")), dbPath = join(directory, "synthetic.sqlite");
const main = fileURLToPath(new URL("../dist/runtime/local/main.js", import.meta.url));
const connections = [], projects = [], expected = new Set(), latest = new Map(), timings = new Map();
const retries = {}, windows = [], roles = [];
let viewer, seed, result, interrupted, stopped = false;
const sleeper = new AbortController();
const onSignal = signal => { interrupted = signal; stopped = true; sleeper.abort(); };
const onInterrupt = () => onSignal("SIGINT"), onTerminate = () => onSignal("SIGTERM");
process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
async function pause(ms) {
  try { await delay(ms, undefined, { signal: sleeper.signal }); }
  catch (error) { if (error.code !== "ABORT_ERR") throw error; }
}
const body = "합성 안정성 테스트 기록 ".padEnd(2048, "x");
const scope = { repository: "benchmark", environment: "test" };
const links = { components: [{ key: "test", name: "테스트 구성요소" }], features: [{ key: "stability", name: "테스트 전용 안정성 작업" }] };
const report = { title: "테스트 기록을 저장했습니다", summary: "동시 작업 안정성 측정을 위한 합성 기록입니다. 실제 개발 작업이 아닙니다." };
function remember(result, projectId) {
  assert.equal(result.status, "persisted");
  if (result.record_id) { expected.add(result.record_id); latest.set(projectId, result.record_id); }
  return result;
}
function timed(name, milliseconds) {
  if (!timings.has(name)) timings.set(name, createHistogram());
  timings.get(name).record(Math.max(1, Math.round(milliseconds * 1000)));
}
async function connect() {
  const client = new Client({ name: "skilly-stability-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [main, "serve", "--db", dbPath], stderr: "pipe" });
  // Do not buffer stderr or expose local credentials. Protocol/tool errors fail the run.
  transport.stderr?.on("data", () => {});
  connections.push(client);
  await client.connect(transport);
  return { client, pid: transport.pid };
}
async function call(client, name, args) {
  const start = performance.now();
  for (let attempt = 0; ; attempt++) {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
    const result = JSON.parse(response.content[0].text);
    if (!response.isError) { timed(name, performance.now() - start); return result; }
    const code = result.error?.code ?? "unknown";
    retries[code] = (retries[code] ?? 0) + 1;
    // Same tool, input and idempotency key; never recreate an unconfirmed write.
    if (!result.error?.retryable || attempt >= 4) throw new Error(`${name}: ${code}`);
    await delay(25 * 2 ** attempt);
  }
}
function sample() {
  return roles.map(({ role, pid }) => {
    const raw = execFileSync("ps", ["-o", "time=", "-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const [cpu, rss] = raw.split(/\s+/);
    const cpuSeconds = cpu.split(":").map(Number).reduce((total, value) => total * 60 + value, 0);
    assert.ok(Number.isFinite(cpuSeconds) && Number(rss) > 0, "Invalid ps sample");
    return { role, pid, cpuSeconds, rss_mib: Number(rss) / 1024 };
  });
}
function phase(name, start, end, elapsed, samples = [start, end]) {
  return { phase: name, seconds: elapsed, processes: start.map((first, index) => ({
    role: first.role, pid: first.pid,
    cpu_percent_one_core: (end[index].cpuSeconds - first.cpuSeconds) / elapsed * 100,
    rss_start_mib: first.rss_mib, rss_end_mib: end[index].rss_mib,
    rss_max_sampled_mib: Math.max(first.rss_mib, end[index].rss_mib, ...samples.map(rows => rows[index].rss_mib)),
  })) };
}
async function idle(name) {
  const start = sample(), at = performance.now();
  await pause(idleSeconds * 1000);
  const end = sample();
  const result = phase(name, start, end, (performance.now() - at) / 1000);
  console.log(JSON.stringify(result));
  return result;
}
try {
  console.log(JSON.stringify({ phase: "setup", directory, seconds, clients: clientCount, seed_records: seedRecords, interval_ms: intervalMs }));
  seed = openLocal(dbPath);
  for (let index = 0; index < 20; index++) {
    if (interrupted) throw new Error(`Benchmark interrupted by ${interrupted}`);
    const p = (await seed.dispatcher.call("memory_register_project", { key: `test-${index}`, name: `합성 테스트 ${index}`, idempotency_key: `project-${index}` })).project;
    projects.push(p.id);
    const run = (await seed.dispatcher.call("memory_begin_task", { project_id: p.id, ...scope, ...links, goal: "합성 데이터 준비", mode: "change", idempotency_key: "seed-begin" })).run;
    for (let n = index; n < seedRecords; n += 20) remember(await seed.dispatcher.call("memory_checkpoint", {
      project_id: p.id, run_id: run.id, body, report, topic: "stability", kind: "note", idempotency_key: `seed-${n}`,
    }), p.id);
    remember(await seed.dispatcher.call("memory_finish_task", { project_id: p.id, run_id: run.id, summary: "합성 데이터 준비 완료", outcome: "completed", idempotency_key: "seed-finish" }), p.id);
    await pause(0);
  }
  await seed.close();
  const workers = [];
  for (let index = 0; index < clientCount; index++) {
    const connection = await connect(); workers.push(connection);
    roles.push({ role: `mcp-${index}`, pid: connection.pid });
    await call(connection.client, "memory_query_context", { project_id: projects[0], ...scope, query: "합성" });
  }
  viewer = await manageViewer("start", dbPath, 0);
  roles.push({ role: "viewer", pid: viewer.pid });
  const auth = { Authorization: `Bearer ${new URLSearchParams(new URL(viewer.url).hash.slice(1)).get("token")}` };
  async function http(path) {
    const at = performance.now();
    const response = await fetch(`${viewer.origin}${path}`, { headers: auth, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, path);
    const value = await response.json(); timed("http_viewer", performance.now() - at); return value;
  }
  await http("/api/projects");
  const idleBefore = await idle("idle_before");
  timings.clear();
  const started = performance.now(), deadline = started + seconds * 1000;
  const baseline = sample(), samples = [baseline];
  let windowStart = baseline, windowAt = started, cycleCount = 0;
  const writesBefore = expected.size;
  async function writer({ client }, index) {
    let sequence = 0;
    while (!stopped && performance.now() < deadline) {
      const at = performance.now(), projectId = projects[sequence % 2 === 0 ? 0 : index + 1];
      const key = `worker-${index}-${sequence++}`;
      const run = remember(await call(client, "memory_begin_task", { project_id: projectId, ...scope, ...links, goal: "합성 동시 작업", title: "테스트 작업", mode: "change", actor: `Test ${index}`, idempotency_key: `${key}-begin` }), projectId).run;
      const saved = remember(await call(client, "memory_checkpoint", { project_id: projectId, run_id: run.id, topic: "stability", kind: "change", body: `${key} ${body}`, report, report_origin: "contemporaneous", idempotency_key: `${key}-change` }), projectId);
      const evidence = await call(client, "memory_get_evidence", { project_id: projectId, record_id: saved.record_id });
      assert.equal(evidence.record.body, `${key} ${body}`);
      await call(client, "memory_query_context", { project_id: projectId, ...scope, query: sequence % 2 ? "합성" : "찾을수없는검색어" });
      await call(client, "memory_query_overview", { project_id: projectId, ...scope, view: sequence % 2 ? "features" : "tasks" });
      remember(await call(client, "memory_finish_task", { project_id: projectId, run_id: run.id, summary: "합성 동시 작업 종료", report, outcome: "completed", idempotency_key: `${key}-finish` }), projectId);
      cycleCount++;
      await pause(Math.max(0, intervalMs - (performance.now() - at)));
    }
  }
  const activities = workers.map((connection, index) => writer(connection, index));
  activities.push((async () => {
    let index = 0;
    while (!stopped && performance.now() < deadline) {
      const project = projects[index++ % (clientCount + 1)];
      await http(`/api/runs?project=${project}`);
      await http(`/api/overview?project=${project}&view=features`);
      await http(`/api/recovery?project=${project}`);
      await pause(500);
    }
  })());
  activities.push((async () => {
    while (!stopped && performance.now() < deadline) {
      await pause(Math.min(5000, Math.max(0, deadline - performance.now())));
      if (stopped) break;
      const rows = sample(); samples.push(rows);
      if (performance.now() - windowAt >= 30000) {
        const result = phase("load_window", windowStart, rows, (performance.now() - windowAt) / 1000);
        windows.push(result); console.log(JSON.stringify({ ...result, cycles: cycleCount }));
        windowStart = rows; windowAt = performance.now();
      }
    }
  })());
  // Settle all in-flight operations before closing connections, even on failure.
  await Promise.all(activities.map(promise => promise.catch(error => { stopped = true; throw error; }))).catch(async error => {
    await Promise.allSettled(activities); throw error;
  });
  if (interrupted) throw new Error(`Benchmark interrupted by ${interrupted}`);
  const active = phase("active", baseline, sample(), (performance.now() - started) / 1000, samples);
  const latency = Object.fromEntries([...timings].map(([name, h]) => [name, { count: h.count, p50_ms: h.percentile(50) / 1000, p95_ms: h.percentile(95) / 1000, max_ms: h.max / 1000 }]));
  const idleAfter = await idle("idle_after");
  if (interrupted) throw new Error(`Benchmark interrupted by ${interrupted}`);
  // A genuinely new MCP process retrieves persisted originals after load stopped.
  const fresh = await connect();
  for (const [projectId, recordId] of latest) {
    const evidence = await call(fresh.client, "memory_get_evidence", { project_id: projectId, record_id: recordId });
    assert.equal(evidence.record.id, recordId);
    const recalled = await call(fresh.client, "memory_query_context", { project_id: projectId, ...scope, query: "합성" });
    assert.equal(recalled.status, "matched", "Fresh MCP search must find the synthetic records");
    assert.ok(recalled.records.length > 0);
  }
  const check = new DatabaseSync(dbPath, { readOnly: true });
  let persisted;
  try {
    assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
    const actual = new Set(check.prepare("SELECT id FROM records").all().map(row => row.id));
    assert.deepEqual(actual, expected, "Every acknowledged record must exist exactly once, with no extras");
    assert.equal(check.prepare("SELECT count(*) AS n FROM runs WHERE state != 'completed'").get().n, 0);
    persisted = actual.size;
  } finally { check.close(); }
  const journal = new DatabaseSync(`${dbPath}.recovery.sqlite`, { readOnly: true });
  try { assert.equal(journal.prepare("SELECT count(*) AS n FROM requests WHERE input_json IS NOT NULL").get().n, 0); }
  finally { journal.close(); }
  result = { phase: "result", status: "passed", machine: { runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    active, idle_before: idleBefore, idle_after: idleAfter, latency, retries, cycles: cycleCount,
    acknowledged_load_records: expected.size - writesBefore, persisted_records: persisted, missing_records: 0,
    integrity: "ok", pending_requests: 0, fresh_mcp_retrieved_projects: latest.size,
    performance_budget_enforced: false,
    db_bytes: statSync(dbPath).size, directory,
    limitations: "Bounded synthetic workload, not hours/days soak or real Codex UI. ps CPU is cumulative per process (one core=100%); RSS is sampled, not proof of leak absence. Driver and other apps excluded. Temporary DB retained. No live DB or settings used.",
  };
} catch (error) {
  result = { phase: "result", status: interrupted ? "interrupted" : "failed", error: error.message, directory };
  process.exitCode = interrupted ? 130 : 1;
} finally {
  stopped = true;
  const cleanup = await Promise.allSettled(connections.map(client => client.close()));
  try {
    await seed?.close();
    if (cleanup.some(item => item.status === "rejected")) throw new Error("A test MCP client did not close cleanly");
  } catch (error) { cleanup.push({ status: "rejected", reason: error }); }
  try {
    if (viewer) {
      assert.equal((await manageViewer("stop", dbPath, 0)).status, "stopped", "Test viewer stop failed");
      const deadline = performance.now() + 3000;
      while ((await manageViewer("status", dbPath, 0)).status !== "stopped") {
        assert.ok(performance.now() < deadline, "Test viewer did not finish stopping");
        await delay(20);
      }
    }
  } catch (error) { cleanup.push({ status: "rejected", reason: error }); }
  const failures = cleanup.filter(item => item.status === "rejected").map(item => String(item.reason));
  if (failures.length) { result.status = "failed"; result.cleanup_errors = failures; process.exitCode = 1; }
  else result.cleanup = "test_connections_closed";
  if (interrupted && result.status === "passed") { result.status = "interrupted"; process.exitCode = 130; }
  process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
  console.log(JSON.stringify(result));
}
