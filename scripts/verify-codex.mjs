import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";

// A manual integration check, intentionally separate from npm test.
// No model turn is sent. macOS enforces network denial for Codex and its children.
const { values } = parseArgs({ options: {
  project: { type: "string" }, db: { type: "string" }, codex: { type: "string" },
  configured: { type: "boolean" },
} });
for (const field of ["project", "db", "codex"]) {
  if (!values[field] || !isAbsolute(values[field])) throw new Error(`--${field} must be absolute.`);
}
if (process.platform !== "darwin") throw new Error("This check requires macOS sandbox-exec network denial.");
const policy = "(version 1)(allow default)(deny network*)";
const executable = values.codex;
const root = values.project;
const main = fileURLToPath(new URL("../dist/runtime/local/main.js", import.meta.url));
const mcp = { command: process.execPath, args: [main, "serve", "--project", root, "--db", values.db], cwd: root };
const version = spawnSync("/usr/bin/sandbox-exec", ["-p", policy, executable, "--version"], { encoding: "utf8", timeout: 10_000 });
assert.equal(version.status, 0, "Codex version check failed.");
const configured = spawnSync("/usr/bin/sandbox-exec", ["-p", policy, executable, "-C", root, "mcp", "get", "skilly", "--json"],
  { encoding: "utf8", timeout: 10_000 });
// Do not print any user configuration. Only compare the expected Skilly fields.
let configMatches = false;
if (configured.status === 0) {
  const config = JSON.parse(configured.stdout);
  configMatches = config.transport?.command === mcp.command
    && JSON.stringify(config.transport?.args) === JSON.stringify(mcp.args)
    && config.transport?.cwd === root;
}
const inline = `{ skilly = { command = ${JSON.stringify(mcp.command)}, args = ${JSON.stringify(mcp.args)}, cwd = ${JSON.stringify(root)} } }`;
const options = [
  ...values.configured ? [] : ["-c", `mcp_servers=${inline}`],
  "-c", "plugins={}",
  "-c", "features.hooks=false", "-c", "features.apps=false",
  "-c", "analytics.enabled=false",
];
const reports = [];
let projectTrustWarning = false;
let projectId;
let recordId;
const probe = randomUUID();
for (let session = 0; session < 2; session++) {
  const child = spawn("/usr/bin/sandbox-exec", ["-p", policy, executable, ...options, "-C", root, "app-server", "--stdio"],
    { cwd: root, stdio: "pipe" });
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  let sequence = 0;
  let buffer = "";
  const pending = new Map();
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const exited = new Promise(resolve => child.once("exit", code => { fail(new Error(`Codex exited (${code}).`)); resolve(); }));
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { fail(new Error("Codex response limit exceeded.")); child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { fail(new Error("Invalid Codex protocol response.")); child.kill(); return; }
      if (message.method === "configWarning") {
        const warning = `${message.params?.summary ?? ""} ${message.params?.details ?? ""}`;
        if (/project/i.test(warning) && /trust/i.test(warning)) projectTrustWarning = true;
      }
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry?.reject(new Error(`Codex protocol error ${message.error.code}.`));
        else entry?.resolve(message.result);
      } else if (message.id !== undefined) {
        // Never approve interactive requests from a diagnostic script.
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported by read-only diagnostic host." } })}\n`);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 20_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request("initialize", {
      clientInfo: { name: "skilly_local_connection_check", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const skills = await request("skills/list", { cwds: [root], forceReload: true });
    const skill = skills.data?.flatMap(entry => entry.skills).find(entry =>
      entry.name === "use-skilly" && entry.path === join(root, ".agents/skills/use-skilly/SKILL.md"));
    assert.ok(skill, "Codex did not discover the installed use-skilly skill.");
    const thread = await request("thread/start", { cwd: root, ephemeral: true });
    const threadId = thread.thread.id;
    const inventory = await request("mcpServerStatus/list", { threadId });
    // Some Codex distributions inject built-in servers. Never invoke them.
    const skilly = inventory.data.find(server => server.name === "skilly");
    if (!skilly && values.configured) {
      reports.push({ session: session + 1, skill_discovered: true, mcp_connected: false, tools: 0, other_servers_invoked: 0 });
      break;
    }
    assert.ok(skilly, "Skilly server is missing from Codex inventory.");
    const toolNames = Object.keys(skilly.tools);
    assert.ok(toolNames.some(name => name.endsWith("memory_resolve_project")), "Skilly tools not connected.");
    const call = async (tool, args) => {
      const result = await request("mcpServer/tool/call", { threadId, server: "skilly", tool, arguments: args });
      assert.notEqual(result.isError, true, `${tool} failed.`);
      const text = result.content.find(item => item.type === "text")?.text;
      assert.equal(typeof text, "string");
      return JSON.parse(text);
    };
    // Installed-config mode makes no report-writing tool calls: its effective
    // target may differ from --db. MCP startup can still open/initialize that DB.
    if (!values.configured) {
      const identity = await call("memory_resolve_project", {});
      if (session === 0) {
        projectId = identity.project.id;
        const run = await call("memory_begin_task", {
          project_id: projectId, goal: "Codex 연결 점검용 합성 작업", mode: "diagnose", idempotency_key: `${probe}:begin`,
        });
        const saved = await call("memory_checkpoint", {
          project_id: projectId, run_id: run.run.id, topic: "codex-connection-probe", kind: "note",
          body: "연결 점검용 합성 기록. 실제 개발 작업이나 테스트 결과를 검증한 근거가 아님.",
          idempotency_key: `${probe}:checkpoint`,
        });
        recordId = saved.record_id;
        await call("memory_finish_task", {
          project_id: projectId, run_id: run.run.id, outcome: "completed",
          summary: "연결 점검용 합성 작업 종료. 다음 프로세스에서 이 기록의 재조회만 확인할 것.",
          idempotency_key: `${probe}:finish`,
        });
      } else {
        assert.equal(identity.project.id, projectId);
        const queried = await call("memory_query_context", { project_id: projectId, topic: "codex-connection-probe" });
        assert.ok(queried.records.some(record => record.id === recordId));
        assert.deepEqual(queried.current_knowledge, []);
        const evidence = await call("memory_get_evidence", { project_id: projectId, record_id: recordId });
        assert.equal(evidence.verified, false);
      }
    }
    reports.push({
      session: session + 1, skill_discovered: true, mcp_connected: true, tools: toolNames.length,
      other_servers_invoked: 0,
    });
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
    const forced = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    clearTimeout(forced);
  }
}
const connected = reports.length === 2 && reports.every(report => report.mcp_connected);
if (!connected) process.exitCode = 1;
process.stdout.write(`${JSON.stringify({
  codex: version.stdout.trim(), effective_mcp_config_matches: configMatches,
  connection_configuration: values.configured
    ? "installed configuration; no MCP override or trust setting change"
    : "explicit CLI override; no trust setting changed",
  network: "denied by macOS sandbox", model_turns: 0,
  project_config_trust_warning: projectTrustWarning,
  sessions: reports, requery_verified: connected && !values.configured, stored_claims_verified: false,
  implicit_skill_execution_verified: false, desktop_current_session_verified: false,
}, null, 2)}\n`);
