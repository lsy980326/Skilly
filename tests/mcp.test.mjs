import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoundedTransport } from "../dist/transport/mcp/bounded-transport.js";
import { createMcpServer } from "../dist/transport/mcp/server.js";
import { fixture, project, run, checkpoint } from "./helpers.mjs";

const main = fileURLToPath(new URL("../dist/runtime/local/main.js", import.meta.url));

test("real MCP client discovers tools and saves/searches data across server restarts", { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "skilly-mcp-"));
  const path = join(directory, "memory.sqlite");
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const connect = async () => {
    const client = new Client({ name: "skilly-test", version: "1.0.0" });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [main, "serve", "--db", path], stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
    return client;
  };
  const client = await connect();
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 11);
  assert.equal(tools.find(tool => tool.name === "memory_checkpoint").annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === "memory_query_context").annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "memory_begin_task").inputSchema.properties.actor.type, "string");
  const call = async (client, name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const project = (await call(client, "memory_register_project", { key: "mcp", name: "MCP", idempotency_key: "register" })).project;
  const run = (await call(client, "memory_begin_task", { project_id: project.id, goal: "기능 수정", mode: "change", actor: "Codex", idempotency_key: "begin" })).run;
  assert.equal(run.actor, "Codex");
  await call(client, "memory_checkpoint", { project_id: project.id, run_id: run.id, topic: "comments", kind: "change", body: "댓글 해결 상태 수정", idempotency_key: "record" });
  const bad = await client.callTool({ name: "memory_checkpoint", arguments: { project_id: project.id, verified: true } });
  assert.equal(bad.isError, true);
  await client.close();
  const next = await connect();
  const result = await call(next, "memory_query_context", { project_id: project.id, query: "해결" });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].knowledge_status, "unknown");
  const status = await call(next, "memory_get_status", { project_id: project.id, run_id: run.id });
  assert.equal(status.run.actor, "Codex");
});

test("stdio EOF and oversized unfinished frames terminate without an idle daemon", { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "skilly-stdio-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = async (data, end) => {
    const child = spawn(process.execPath, [main, "serve", "--db", join(directory, "memory.sqlite")], { stdio: "pipe" });
    child.stderr.resume();
    child.stdout.resume();
    child.stdin.on("error", () => {});
    const exit = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    try {
      if (data) child.stdin.write(data);
      if (end) child.stdin.end();
      const result = await exit;
      assert.equal(result.signal, null, "Server did not stop promptly.");
    } finally { clearTimeout(timer); child.stdin.destroy(); }
  };
  await run("", true);
  await run("x".repeat(200 * 1024), false);
});

test("slow output retains admission until send completes and cannot accumulate unlimited responses", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const record = await f.call("memory_checkpoint", checkpoint(p, r, { body: "x".repeat(16_000) }));
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  const transport = new BoundedTransport(new StdioServerTransport(input, output));
  const server = createMcpServer(f.app.dispatcher);
  let closed = false;
  server.server.onclose = () => { closed = true; };
  server.server.onerror = () => {};
  await server.connect(transport);
  try {
    for (let id = 0; id < 200; id++) {
      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "memory_get_evidence", arguments: { project_id: p, record_id: record.record_id } },
      })}\n`);
      await new Promise(resolve => setImmediate(resolve));
      if (closed) break;
    }
    assert.equal(closed, true, "Connection must close at the pending response limit.");
    assert.ok(output.writableLength < 32 * 18_000, `Unexpected output buffering: ${output.writableLength}`);
  } finally {
    await server.close();
    input.destroy();
    output.destroy();
  }
});

test("raw argument limit runs before whitespace trimming or other schema transforms", async t => {
  const f = fixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const transport = new BoundedTransport(new StdioServerTransport(input, output, { maxBufferSize: 160 * 1024 }));
  const server = createMcpServer(f.app.dispatcher);
  let closed = false;
  server.server.onclose = () => { closed = true; };
  server.server.onerror = () => {};
  await server.connect(transport);
  try {
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "memory_register_project", arguments: { key: "large", name: `${" ".repeat(130 * 1024)}x`, idempotency_key: "register" } },
    })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, true);
    assert.deepEqual((await f.call("memory_list_projects", {})).projects, []);
  } finally { await server.close(); input.destroy(); output.destroy(); }
});
