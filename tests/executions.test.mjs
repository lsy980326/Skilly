import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { fixture, project, run, checkpoint } from "./helpers.mjs";
import { openLocal } from "../dist/runtime/local/app.js";
import { SqliteViewer } from "../dist/adapters/storage/sqlite/viewer.js";
import { startViewer } from "../dist/transport/viewer/server.js";
import { backupDatabase, restoreDatabase } from "../dist/adapters/storage/transfer/snapshot.js";
import { exportProject, importProject } from "../dist/adapters/storage/transfer/project.js";
import { initialize } from "../dist/adapters/storage/transfer/database.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile), main = fileURLToPath(new URL("../dist/runtime/local/main.js", import.meta.url));
async function setup(t) {
  const f = fixture(t), pid = await project(f.call), rid = await run(f.call, pid, { features: [{ key: "test", name: "테스트 기능" }] });
  f.path = realpathSync(f.path); f.directory = realpathSync(f.directory);
  writeFileSync(join(f.directory, "skilly.project.json"), JSON.stringify({ version: 1, key: "example", name: "example", repository: "default", environment: "development" }));
  const saved = await f.call("memory_checkpoint", checkpoint(pid, rid, { report: { title: "AI가 보고한 결과", summary: "통과했다고 보고했습니다.", checks: [{ name: "검사", result: "passed" }] } }));
  return { ...f, pid, rid, record: saved.record_id };
}
function args(f, command = process.execPath, rest = ["-e", "process.stdout.write('private output');process.stderr.write('private error')"], extra = []) {
  return [main, "exec", "--db", f.path, "--project", f.directory, "--run-id", f.rid, "--record-id", f.record, ...extra, "--", command, ...rest];
}
async function invoke(argv) {
  try { return { ...await exec(process.execPath, argv, { timeout: 15000 }), code: 0 }; }
  catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}

test("actual process facts survive fresh MCP and authenticated HTTP, without promoting or exposing AI content", async t => {
  const f = await setup(t), original = (await f.call("memory_get_evidence", { project_id: f.pid, record_id: f.record })).record;
  const result = await invoke(args(f)); assert.equal(result.code, 0);
  assert.equal(result.stdout.includes("private output"), false);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, "persisted");
  const page = await f.call("memory_list_executions", { project_id: f.pid, run_id: f.rid });
  const row = page.items[0];
  assert.equal(row.exit_code, 0); assert.equal(row.source, "local_runner"); assert.equal(row.claims_verified, false);
  assert.equal(row.stdout_hash, createHash("sha256").update("private output").digest("hex"));
  assert.equal(row.stdout_bytes, 14); assert.equal(row.output_complete, 1);
  assert.equal(JSON.stringify(page).includes("private output"), false);
  assert.equal(JSON.stringify(page).includes(f.directory), false);
  assert.deepEqual((await f.call("memory_get_evidence", { project_id: f.pid, record_id: f.record })).record, original);
  assert.equal((await f.call("memory_get_evidence", { project_id: f.pid, record_id: f.record })).executions.items[0].id, row.id);
  const overview = await f.call("memory_query_overview", { project_id: f.pid, view: "features" });
  assert.equal(overview.items[0].execution_evidence.status, "observations_available");
  assert.equal(overview.items[0].execution_evidence.verified, false);
  const client = new Client({ name: "execution-read", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [main, "serve", "--db", f.path, "--project", f.directory], stderr: "pipe" });
  transport.stderr.on("data", () => {}); t.after(() => client.close()); await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === "memory_list_executions").annotations.readOnlyHint, true);
  const fresh = await client.callTool({ name: "memory_list_executions", arguments: { project_id: f.pid, run_id: f.rid } });
  assert.equal(JSON.parse(fresh.content[0].text).items[0].id, row.id);
  const rejected = await client.callTool({ name: "memory_checkpoint", arguments: { ...checkpoint(f.pid, f.rid), source: "local_runner", exit_code: 0 } });
  assert.equal(rejected.isError, true);
  const viewer = await startViewer({ db: f.path }); t.after(() => viewer.close());
  const url = `${viewer.origin}/api/runs/${f.rid}/executions?project=${f.pid}`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: `Bearer ${new URLSearchParams(new URL(viewer.url).hash.slice(1)).get("token")}` };
  const http = await (await fetch(url, { headers })).json(); assert.equal(http.items[0].id, row.id);
  assert.equal((await fetch(url, { headers: { ...headers, Origin: "http://example.com" } })).status, 403);
});

test("nonzero exits, launch failures, timeouts and bounded hashes remain observations, not test verdicts", async t => {
  const f = await setup(t);
  assert.equal((await invoke(args(f, process.execPath, ["-e", "process.exit(7)"]))).code, 7);
  assert.equal((await invoke(args(f, "/nonexistent/skilly-test-executable", []))).code, 127);
  assert.equal((await invoke(args(f, process.execPath, ["-e", "setInterval(()=>{},1000)"], ["--timeout-ms", "100"]))).code, 124);
  assert.equal((await invoke(args(f, process.execPath, ["-e", "process.stdout.write('x'.repeat(1200000))"]))).code, 0);
  const rows = (await f.call("memory_list_executions", { project_id: f.pid, run_id: f.rid })).items;
  assert.equal(rows.length, 4);
  assert.ok(rows.some(row => row.outcome === "exited" && row.exit_code === 7));
  assert.ok(rows.some(row => row.outcome === "launch_failed" && row.error_code === "ENOENT"));
  assert.ok(rows.some(row => row.outcome === "timed_out"));
  assert.equal(rows[0].stdout_bytes, 1200000); assert.equal(rows[0].stdout_hashed_bytes, 1024 * 1024);
});

test("invalid scope, closed runs and wrong record associations never execute the child", async t => {
  const f = await setup(t), marker = join(f.directory, "must-not-exist"), code = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`;
  const other = await run(f.call, f.pid, { idempotency_key: "other" });
  assert.notEqual((await invoke(args({ ...f, rid: other }, process.execPath, ["-e", code]))).code, 0);
  await f.call("memory_finish_task", { project_id: f.pid, run_id: f.rid, summary: "완료", outcome: "completed", idempotency_key: "finish" });
  assert.notEqual((await invoke(args(f, process.execPath, ["-e", code]))).code, 0);
  assert.equal(existsSync(marker), false);
  const second = await project(f.call, "second"), foreignRun = await run(f.call, second);
  await assert.rejects(f.call("memory_list_executions", { project_id: f.pid, run_id: foreignRun }), { code: "not_found" });
});

test("a finished command with failed result storage remains unconfirmed and is never replayed", async t => {
  const f = await setup(t), marker = join(f.directory, "once");
  const code = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(f.path)});db.exec("CREATE TRIGGER deny_finish BEFORE UPDATE ON executions BEGIN SELECT RAISE(ABORT,'test failure');END");db.close()`;
  const result = await invoke(args(f, process.execPath, ["-e", code]));
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /execution_save_failed/);
  const rows = (await f.call("memory_list_executions", { project_id: f.pid, run_id: f.rid })).items;
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, "unconfirmed");
  assert.equal(rows[0].ended_at, null); assert.equal(rows[0].exit_code, null);
  assert.equal(readFileSync(marker, "utf8"), "x");
});

test("execution reads paginate without modifying records or disclosing a foreign task", async t => {
  const f = await setup(t);
  const ids = new Set();
  for (let n = 0; n < 23; n++) ids.add(f.app.executions.start({ project_id: f.pid, run_id: f.rid, executable: "fixture", command_hash: "a".repeat(64) }));
  const first = await f.call("memory_list_executions", { project_id: f.pid, run_id: f.rid });
  const second = await f.call("memory_list_executions", { project_id: f.pid, run_id: f.rid, offset: first.next_offset });
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 3); assert.equal(second.next_offset, null);
  assert.deepEqual(new Set([...first.items, ...second.items].map(row => row.id)), ids);
  assert.ok(first.items.every(row => row.outcome === "unconfirmed"));
});

test("interrupting an explicit execution stores interruption without closing its AI task", async t => {
  const f = await setup(t);
  const marker = join(f.directory, "child-ready");
  const child = spawn(process.execPath, args(f, process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`]), { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGTERM"), 5000); t.after(() => clearTimeout(timer));
  const exit = new Promise(resolve => child.once("exit", code => resolve(code)));
  const deadline = Date.now() + 4000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(marker), true); child.kill("SIGTERM");
  assert.equal(await exit, 130); assert.equal(JSON.parse(output).outcome, "interrupted");
  assert.equal((await f.call("memory_get_status", { project_id: f.pid, run_id: f.rid })).run.state, "active");
});

test("timeout kills a silent SIGTERM-ignoring descendant even after its direct parent closes", { timeout: 15000 }, async t => {
  const f = await setup(t), marker = join(f.directory, "descendant-pid");
  const descendant = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const result = await invoke(args(f, process.execPath, ["-e", parent], ["--timeout-ms", "800"]));
  assert.equal(result.code, 124);
  const pid = Number(readFileSync(marker, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  const deadline = Date.now() + 2000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
    catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
  }
  assert.equal(alive, false, "Owned descendant must not survive timeout cleanup");
});

test("schema v5 originals are preserved and execution facts round-trip in backup and project transfer", async t => {
  const f = await setup(t);
  await invoke(args(f));
  const before = (await f.call("memory_list_executions", { project_id: f.pid, run_id: f.rid })).items;
  const backup = join(f.directory, "backup"), restored = join(f.directory, "restored"), bundle = join(f.directory, "bundle"), imported = join(f.directory, "imported");
  await backupDatabase(f.path, backup); const restore = await restoreDatabase(backup, restored);
  exportProject(f.path, f.pid, bundle); const added = await importProject(bundle, imported);
  for (const path of [restore.db, added.db]) {
    const v = new SqliteViewer(path); assert.deepEqual(v.executions(f.pid, f.rid).items, before); v.close();
  }
  const oldPath = join(f.directory, "legacy.sqlite"), old = new DatabaseSync(oldPath);
  initialize(old, false, 5);
  const id = randomUUID(); old.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run(id, "legacy", "legacy", 0, new Date().toISOString());
  const original = old.prepare("SELECT * FROM projects").all(); old.close();
  const bytes = readFileSync(oldPath); const read = new SqliteViewer(oldPath); read.projects(); read.close(); assert.deepEqual(readFileSync(oldPath), bytes);
  const upgraded = openLocal(oldPath); await upgraded.close();
  const check = new DatabaseSync(oldPath, { readOnly: true });
  assert.deepEqual(check.prepare("SELECT * FROM projects").all(), original); assert.equal(check.prepare("PRAGMA user_version").get().user_version, 14); check.close();
});
