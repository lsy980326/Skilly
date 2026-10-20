import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, platform, release, arch, cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openLocal } from "../dist/runtime/local/app.js";

const directory = mkdtempSync(join(tmpdir(), "skilly-bench-"));
const path = join(directory, "benchmark.sqlite");
const app = openLocal(path);
const client = new Client({ name: "skilly-benchmark", version: "1.0.0" });
const main = fileURLToPath(new URL("../dist/runtime/local/main.js", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [main, "serve", "--db", path], stderr: "pipe" });
transport.stderr?.on("data", () => {});
const body = "benchmark 댓글 해결 상태 기록 ".padEnd(2026, "x");
const projectIds = [];
const started = performance.now();

try {
  for (let project = 0; project < 20; project++) {
    const p = (await app.dispatcher.call("memory_register_project", {
      key: `bench-${String(project).padStart(2, "0")}`, name: `Benchmark ${project}`, idempotency_key: `register:${project}`,
    })).project;
    projectIds.push(p.id);
    const r = (await app.dispatcher.call("memory_begin_task", {
      project_id: p.id, goal: "benchmark fixture", mode: "change", idempotency_key: "begin",
    })).run;
    for (let record = 0; record < 500; record++) {
      await app.dispatcher.call("memory_checkpoint", {
        project_id: p.id, run_id: r.id, topic: "comments", kind: "note",
        body, idempotency_key: `seed:${record}`,
      });
    }
    if ((project + 1) % 5 === 0) console.log(`Seeded ${(project + 1) * 500} synthetic records.`);
  }
  await app.close();
  await client.connect(transport);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  const projectId = projectIds[0];
  for (let index = 0; index < 10; index++) await call("memory_query_context", { project_id: projectId, query: "해결" });
  const queries = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    await call("memory_query_context", { project_id: projectId, query: "해결" });
    queries.push(performance.now() - start);
  }
  const run = (await call("memory_begin_task", { project_id: projectId, goal: "benchmark writes", mode: "change", idempotency_key: "bench-run" })).run;
  const writes = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    await call("memory_checkpoint", {
      project_id: projectId, run_id: run.id, topic: "benchmark", kind: "note",
      body: "x".repeat(8 * 1024), idempotency_key: `timed:${index}`,
    });
    writes.push(performance.now() - start);
  }
  console.log("Measuring idle CPU for 60 seconds; only the benchmark timer is active.");
  const before = sampleProcess(transport.pid);
  const idleStart = performance.now();
  await new Promise(resolve => setTimeout(resolve, 60_000));
  const after = sampleProcess(transport.pid);
  const idleSeconds = (performance.now() - idleStart) / 1000;
  console.log(JSON.stringify({
    runtime: process.version, machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
    fixture: { projects: 20, seeded_records: 10_000, body_bytes: Buffer.byteLength(body), measured_writes: 100 },
    query_p95_ms: percentile(queries, 0.95), write_p95_ms: percentile(writes, 0.95),
    idle_seconds: idleSeconds, idle_cpu_percent_one_core: (after.cpuSeconds - before.cpuSeconds) / idleSeconds * 100,
    stable_rss_mib: after.rssKiB / 1024, db_bytes: statSync(path).size,
    elapsed_seconds: (performance.now() - started) / 1000,
    limitations: "Local synthetic smoke benchmark; no long-run leak, multi-client RSS or external build/test overhead measurement.",
  }, null, 2));
} finally {
  await client.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}

function percentile(values, percentile) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * percentile) - 1];
}

function sampleProcess(pid) {
  if (!pid) throw new Error("Benchmark child has no PID.");
  const [cpu, rss] = execFileSync("ps", ["-o", "time=", "-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
  const parts = cpu.split(":").map(Number);
  const cpuSeconds = parts.reduce((total, value) => total * 60 + value, 0);
  return { cpuSeconds, rssKiB: Number(rss) };
}
