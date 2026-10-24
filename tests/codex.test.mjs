import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openLocal } from "../dist/runtime/local/app.js";
import { loadProjectBinding } from "../dist/adapters/project/binding.js";
import { setupCodex } from "../scripts/setup-codex.mjs";

const main = fileURLToPath(new URL("../dist/runtime/local/main.js", import.meta.url));
const binding = { version: 1, key: "example", name: "Example", repository: "web", environment: "development" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "skilly-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "skilly.project.json"), JSON.stringify(binding));
  return { root, db: join(root, "memory.sqlite") };
}
const rejected = code => error => error.code === code;

test("bound identity persists across directories and isolates project, repository, runs and evidence", async t => {
  const f = fixture(t);
  const app = openLocal(f.db, binding);
  const unbound = openLocal(f.db);
  t.after(async () => { await app.close(); await unbound.close(); });
  const call = (name, input) => app.dispatcher.call(name, input);
  assert.equal("memory_register_project" in app.dispatcher.tools, false);
  assert.equal("memory_list_projects" in app.dispatcher.tools, false);
  await assert.rejects(call("memory_query_context", { project_id: "6d8724ba-6e74-4f19-b322-afb5f5a3477f" }), rejected("project_unresolved"));
  assert.deepEqual((await unbound.dispatcher.call("memory_list_projects", {})).projects, []);
  const identity = await call("memory_resolve_project", {});
  assert.deepEqual(await call("memory_resolve_project", {}), identity);
  const pid = identity.project.id;
  const start = { project_id: pid, goal: "댓글 수정", mode: "change", idempotency_key: "begin" };
  const run = (await call("memory_begin_task", start)).run;
  assert.equal(run.repository, "web");
  const other = (await unbound.dispatcher.call("memory_register_project", { key: "other", name: "Other", idempotency_key: "other" })).project;
  await assert.rejects(call("memory_begin_task", { ...start, project_id: other.id }), rejected("scope_mismatch"));
  await assert.rejects(call("memory_query_context", { project_id: pid, environment: "production" }), rejected("scope_mismatch"));
  const foreignRun = (await unbound.dispatcher.call("memory_begin_task", { ...start, repository: "api", idempotency_key: "api" })).run;
  const record = await unbound.dispatcher.call("memory_checkpoint", {
    project_id: pid, run_id: foreignRun.id, topic: "api", kind: "note", body: "api only", idempotency_key: "api-note",
  });
  for (const tool of ["memory_get_status", "memory_checkpoint", "memory_finish_task"]) {
    const input = tool === "memory_checkpoint" ? { topic: "test", kind: "note", body: "no", idempotency_key: "no" }
      : tool === "memory_finish_task" ? { summary: "no", outcome: "completed", idempotency_key: "no" } : {};
    await assert.rejects(call(tool, { ...input, project_id: pid, run_id: foreignRun.id }), rejected("scope_mismatch"));
  }
  await assert.rejects(call("memory_get_evidence", { project_id: pid, record_id: record.record_id }), rejected("scope_mismatch"));
  assert.deepEqual((await call("memory_query_context", { project_id: pid })).records, []);
  const relocated = openLocal(f.db, { ...binding });
  try { assert.equal((await relocated.dispatcher.call("memory_resolve_project", {})).project.id, pid); }
  finally { await relocated.close(); }
});

test("configured MCP completes work and a new session retrieves only unverified reports", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); });
  const connect = async () => {
    const client = new Client({ name: "codex-workflow-contract", version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [main, "serve", "--db", f.db, "--project", f.root], stderr: "pipe",
      cwd: tmpdir(), // Identity must come from the configured root, not caller cwd.
    });
    transport.stderr?.resume();
    await client.connect(transport);
    return client;
  };
  const call = async (client, name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    return JSON.parse(reply.content[0].text);
  };
  const first = await connect();
  const tools = (await first.listTools()).tools;
  assert.equal(tools.length, 25);
  assert.equal(tools.find(tool => tool.name === "memory_query_current_knowledge").annotations.readOnlyHint, true);
  // The workflow must reach a real MCP client before any individual tool call.
  assert.ok(first.getInstructions()?.includes("local SQLite"));
  assert.ok(first.getInstructions()?.includes("unverified"));
  for (const tool of tools) {
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  const pid = (await call(first, "memory_resolve_project", {})).project.id;
  const task = { project_id: pid, goal: "댓글 기능", mode: "change", idempotency_key: "start" };
  const run = (await call(first, "memory_begin_task", task)).run.id;
  const note = { project_id: pid, run_id: run, topic: "comments", kind: "change", body: "댓글 상태 수정. 테스트는 아직 실행하지 않음.", idempotency_key: "note" };
  const saved = await call(first, "memory_checkpoint", note);
  assert.equal(saved.provenance, "agent_report");
  const finish = { project_id: pid, run_id: run, summary: "한 일: 댓글 수정. 관측한 검증: 없음. 다음: 테스트 실행.", outcome: "completed", idempotency_key: "finish" };
  const finished = await call(first, "memory_finish_task", finish);
  assert.deepEqual(await call(first, "memory_finish_task", finish), finished);
  const bad = await first.callTool({ name: "memory_checkpoint", arguments: { ...note, verified: true } });
  assert.equal(bad.isError, true);
  await first.close();
  const next = await connect();
  assert.equal((await call(next, "memory_resolve_project", {})).project.id, pid);
  const context = await call(next, "memory_query_context", { project_id: pid, topic: "task-summary" });
  assert.equal(context.records.length, 1);
  assert.match(context.records[0].excerpt, /다음: 테스트 실행/);
  assert.deepEqual(context.current_knowledge, []);
  assert.equal(context.records[0].knowledge_status, "unknown");
  const evidence = await call(next, "memory_get_evidence", { project_id: pid, record_id: saved.record_id });
  assert.equal(evidence.verified, false);
  const nextRun = (await call(next, "memory_begin_task", { ...task, idempotency_key: "next-session" })).run;
  assert.notEqual(nextRun.id, run);
});

test("missing, oversized, symlinked or invalid project binding fails before database creation", t => {
  const f = fixture(t);
  for (const value of [{ ...binding, verified: true }, { ...binding, key: "../bad" }, { ...binding, version: 2 }]) {
    writeFileSync(join(f.root, "skilly.project.json"), JSON.stringify(value));
    assert.throws(() => loadProjectBinding(f.root), rejected("invalid_binding"));
  }
  writeFileSync(join(f.root, "skilly.project.json"), " ".repeat(4097));
  assert.throws(() => loadProjectBinding(f.root), rejected("invalid_binding"));
  const missing = join(f.root, "missing");
  mkdirSync(missing);
  const result = spawnSync(process.execPath, [main, "serve", "--project", missing, "--db", f.db], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(existsSync(f.db), false);
  symlinkSync(join(f.root, "skilly.project.json"), join(missing, "skilly.project.json"));
  assert.throws(() => loadProjectBinding(missing));
  assert.throws(() => loadProjectBinding("."), rejected("invalid_path"));
  if (process.platform !== "win32") {
    const fifo = join(f.root, "fifo");
    mkdirSync(fifo);
    const created = spawnSync("mkfifo", [join(fifo, "skilly.project.json")]);
    assert.equal(created.status, 0);
    const rejectedFifo = spawnSync(process.execPath, [main, "serve", "--project", fifo, "--db", f.db],
      { encoding: "utf8", timeout: 2000 });
    assert.equal(rejectedFifo.status, 1, "A non-regular binding must fail without blocking on open.");
    assert.equal(existsSync(f.db), false);
  }
});

test("setup produces project-only MCP and skill without overwriting existing config or skill", t => {
  const f = fixture(t);
  const result = setupCodex({ project: f.root, db: f.db });
  assert.equal(result.connection_verified, false);
  assert.equal(existsSync(f.db), false);
  const config = readFileSync(join(f.root, ".codex/config.toml"), "utf8");
  assert.match(config, /\[mcp_servers.skilly\]/);
  assert.match(config, /--project/);
  assert.match(config, /--db/);
  assert.doesNotMatch(config, /hooks|http|trust_level/);
  assert.ok(readFileSync(join(f.root, ".agents/skills/use-skilly/SKILL.md"), "utf8").startsWith(
    readFileSync(new URL("../integrations/skills/use-skilly/SKILL.md", import.meta.url), "utf8")));
  assert.throws(() => setupCodex({ project: f.root, db: f.db }), /Destination exists/);
  assert.equal(readFileSync(join(f.root, ".codex/config.toml"), "utf8"), config);
  const second = join(f.root, "another");
  mkdirSync(join(second, ".agents/skills/use-skilly"), { recursive: true });
  writeFileSync(join(second, "skilly.project.json"), JSON.stringify(binding));
  writeFileSync(join(second, ".agents/skills/use-skilly/SKILL.md"), "user skill");
  assert.throws(() => setupCodex({ project: second, db: f.db }), /Destination exists/);
  assert.equal(existsSync(join(second, ".codex/config.toml")), false);
  const third = join(f.root, "symlink");
  mkdirSync(third);
  writeFileSync(join(third, "skilly.project.json"), JSON.stringify(binding));
  symlinkSync(join(f.root, ".codex"), join(third, ".codex"));
  assert.throws(() => setupCodex({ project: third, db: f.db }), /Destination exists/);
});
