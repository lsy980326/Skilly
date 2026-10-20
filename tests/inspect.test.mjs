import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { inspectMemory, formatInspection } from "../scripts/inspect-memory.mjs";
import { fixture, project, run, checkpoint } from "./helpers.mjs";

function binding(root, extra = {}) {
  writeFileSync(join(root, "skilly.project.json"), JSON.stringify({
    version: 1, key: "example", name: "example", repository: "default",
    environment: "development", ...extra,
  }));
}

test("human inspection renders untrusted terminal controls and folds record lines without changing data", () => {
  const hostile = "\u001b]52;c;fake\u0007\u009b2J\u007f\n위조 상태\r\n다음\t줄";
  const report = {
    status: "ok", scope: { key: hostile, repository: hostile, environment: hostile },
    runs: [{
      id: hostile, state: hostile, mode: hostile, goal: hostile, updated_at: hostile,
      record_counts: { [hostile]: 1 },
      recent_records: [{ id: hostile, kind: hostile, topic: hostile, excerpt: hostile }],
    }],
  };
  const original = JSON.stringify(report);
  const text = formatInspection(report);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  assert.doesNotMatch(text, /\n(?:위조 상태|다음)/u);
  assert.match(text, /\\u001b\]52;c;fake\\u0007\\u009b2J\\u007f 위조 상태 다음 줄/u);
  assert.equal(JSON.stringify(report), original);
});

test("inspection reads saved stages and incomplete work without altering the database", async t => {
  const f = fixture(t);
  binding(f.directory);
  const pid = await project(f.call);
  const rid = await run(f.call, pid);
  const saved = await f.call("memory_checkpoint", checkpoint(pid, rid, { body: "가".repeat(300) }));
  const finished = await f.call("memory_finish_task", {
    project_id: pid, run_id: rid, summary: "검증 미실행", outcome: "completed", idempotency_key: "finish",
  });
  const active = await run(f.call, pid, { idempotency_key: "active" });
  await f.app.close();
  const before = readFileSync(f.path);
  const report = inspectMemory({ project: f.directory, db: f.path, run: rid });
  assert.equal(report.runs[0].state, "completed");
  assert.deepEqual(report.runs[0].record_counts, { change: 1, summary: 1 });
  assert.deepEqual(report.runs[0].recent_records.map(record => record.id), [finished.record_id, saved.record_id]);
  assert.equal(report.runs[0].recent_records[1].excerpt.length, 240);
  assert.equal(report.runs[0].recent_records[1].excerpt_truncated, true);
  assert.ok(report.runs[0].recent_records.every(record => record.verified === false));
  assert.equal(inspectMemory({ project: f.directory, db: f.path, run: active }).runs[0].state, "active");
  assert.equal(report.claims_verified, false);
  assert.match(formatInspection(report), /검증하지 않습니다/);
  assert.deepEqual(readFileSync(f.path), before);
});

test("inspection and its CLI enforce project and repository scope", async t => {
  const f = fixture(t);
  binding(f.directory);
  const pid = await project(f.call);
  const other = await project(f.call, "other");
  const visible = await run(f.call, pid);
  const foreign = await run(f.call, other);
  const otherRepository = await run(f.call, pid, { repository: "api", idempotency_key: "api" });
  const options = { project: f.directory, db: f.path };
  assert.deepEqual(inspectMemory(options).runs.map(task => task.id), [visible]);
  for (const id of [foreign, otherRepository]) assert.throws(() => inspectMemory({ ...options, run: id }), /Run not found/);
  const cli = spawnSync(process.execPath, ["scripts/inspect-memory.mjs", "--project", f.directory, "--db", f.path, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).runs.map(task => task.id), [visible]);
  binding(f.directory, { key: "unregistered", name: "unregistered" });
  assert.equal(inspectMemory(options).status, "project_not_registered");
  assert.equal((await f.call("memory_list_projects", {})).projects.length, 2);
});

test("inspection rejects missing, foreign, linked and unsupported targets without initializing them", async t => {
  const f = fixture(t);
  binding(f.directory);
  const options = { project: f.directory, db: f.path };
  const missing = join(f.directory, "missing", "memory.sqlite");
  assert.throws(() => inspectMemory({ ...options, db: missing }));
  assert.equal(existsSync(join(f.directory, "missing")), false);
  const foreign = join(f.directory, "foreign.sqlite");
  new DatabaseSync(foreign).close();
  const before = readFileSync(foreign);
  assert.throws(() => inspectMemory({ ...options, db: foreign }), /Skilly schema/);
  assert.deepEqual(readFileSync(foreign), before);
  const link = join(f.directory, "linked.sqlite");
  symlinkSync(f.path, link);
  assert.throws(() => inspectMemory({ ...options, db: link }), /symlink/);
  for (const limit of [0, 21, 1.5, NaN]) assert.throws(() => inspectMemory({ ...options, limit }), /limit/);
  assert.throws(() => inspectMemory({ ...options, run: "' OR 1=1" }), /UUID/);
  assert.throws(() => inspectMemory({ ...options, db: "memory.sqlite" }), /absolute/);
});
