import test from "node:test";
import assert from "node:assert/strict";
import { guardedProbeRequest, inspectInventory, probeOverrides, REQUIRED_TOOLS } from "../scripts/codex-probe-policy.mjs";

test("configured diagnostics preserve host protection settings; explicit mode only selects MCP", () => {
  const mcp = { command: "/runtime/node", args: ["/skilly/main.js", "serve"], cwd: "/project" };
  assert.deepEqual(probeOverrides(true, mcp), []);
  const explicit = probeOverrides(false, mcp);
  assert.equal(explicit.length, 2);
  assert.equal(explicit[0], "-c");
  assert.ok(explicit[1].startsWith("mcp_servers="));
  assert.doesNotMatch(explicit.join(" "), /hooks|plugins|features|approval|trust|sandbox|analytics/);
});

test("a listed server or resolver alone cannot pass the whole recording workflow check", () => {
  const entry = names => ({ data: [{ name: "skilly", tools: Object.fromEntries(names.map(name => [name, {}])) }] });
  assert.equal(inspectInventory({ data: [] }).mcp_connected, false);
  assert.equal(inspectInventory(entry([])).mcp_connected, false);
  const partial = inspectInventory(entry(["memory_resolve_project"]));
  assert.equal(partial.mcp_connected, false);
  assert.ok(partial.missing_tools.includes("memory_checkpoint"));
  assert.equal(inspectInventory(entry(REQUIRED_TOOLS)).mcp_connected, true);
  assert.equal(inspectInventory(entry(REQUIRED_TOOLS.map(tool => `mcp__skilly__${tool}`))).mcp_connected, true);
  assert.equal(inspectInventory(entry(REQUIRED_TOOLS.map(tool => `unrelated_${tool}`))).mcp_connected, false);
  assert.equal(inspectInventory({ data: [{ name: "other", tools: entry(REQUIRED_TOOLS).data[0].tools }] }).mcp_connected, false);
});

test("configured diagnostics select the exact server without borrowing tools from another connection", () => {
  const server = "skilly_project_fixture";
  const tools = Object.fromEntries(REQUIRED_TOOLS.map(name => [name, {}]));
  const inventory = { data: [{ name: "skilly", tools }, { name: server, tools: {} }] };
  assert.equal(inspectInventory(inventory).mcp_connected, true);
  assert.equal(inspectInventory(inventory, server).mcp_connected, false);
  inventory.data[1].tools = Object.fromEntries([...REQUIRED_TOOLS, "memory_recovery_status", "memory_retry_write"].map(name => [`mcp__${server}__${name}`, {}]));
  const selected = inspectInventory(inventory, server);
  assert.equal(selected.mcp_connected, true);
  assert.equal(selected.recovery_tools_available, true);
  assert.equal(inspectInventory(inventory, `${server}_other`).server_listed, false);
  assert.equal(inspectInventory({ data: [], resources: [{ server, tools }] }, server).mcp_connected, false);
});

test("a trust warning or rejected approval stops subsequent protocol calls including writes and new sessions", async () => {
  for (const event of ["trust_warning", "approval_request"]) {
    const state = { trustWarning: false, approvalRequests: 0 };
    const calls = [];
    const request = guardedProbeRequest(async (method, params) => {
      calls.push({ method, params });
      // Simulate the host delivering a protection event during the first reply.
      if (event === "trust_warning") state.trustWarning = true;
      else state.approvalRequests++;
      return {};
    }, () => state.trustWarning || state.approvalRequests > 0);
    await request("mcpServerStatus/list", { threadId: "fixture" });
    for (const method of ["mcpServer/tool/call", "thread/start", "turn/start"]) {
      await assert.rejects(request(method, { tool: "memory_begin_task" }), /Probe stopped/);
    }
    assert.deepEqual(calls.map(call => call.method), ["mcpServerStatus/list"]);
  }
});
