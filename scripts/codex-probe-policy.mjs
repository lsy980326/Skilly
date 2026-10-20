// Keep the diagnostic host's authority separate from the connection being tested.
// Installed-config probes must not disable hooks, plugins, apps or approvals.
export function probeOverrides(configured, mcp) {
  if (configured) return [];
  const inline = `{ skilly = { command = ${JSON.stringify(mcp.command)}, args = ${JSON.stringify(mcp.args)}, cwd = ${JSON.stringify(mcp.cwd)} } }`;
  return ["-c", `mcp_servers=${inline}`];
}

export const REQUIRED_TOOLS = [
  "memory_resolve_project", "memory_query_context", "memory_begin_task",
  "memory_checkpoint", "memory_finish_task", "memory_get_evidence", "memory_get_status",
];
const RECOVERY_TOOLS = ["memory_recovery_status", "memory_retry_write"];

export function inspectInventory(inventory) {
  const server = inventory.data?.find(entry => entry.name === "skilly");
  const names = Object.keys(server?.tools ?? {});
  // Codex may qualify names. Accept only an exact name or a namespace boundary.
  const missing = REQUIRED_TOOLS.filter(tool => !names.some(name => name === tool || name.endsWith(`__${tool}`)));
  return {
    server_listed: Boolean(server), mcp_connected: Boolean(server) && missing.length === 0,
    tools: names.length, missing_tools: missing,
    recovery_tools_available: RECOVERY_TOOLS.every(tool => names.some(name => name === tool || name.endsWith(`__${tool}`))),
  };
}

export function guardedProbeRequest(request, blocked) {
  return async (method, params) => {
    if (blocked()) throw new Error("Probe stopped after a trust warning or an interactive request; no further protocol calls are permitted.");
    return request(method, params);
  };
}
