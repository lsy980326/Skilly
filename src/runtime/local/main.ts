#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryError } from "../../core/memory/model.js";
import { errorResult, MAX_FRAME_BYTES, MAX_INPUT_BYTES } from "../../transport/tools.js";
import { createMcpServer } from "../../transport/mcp/server.js";
import { BoundedTransport } from "../../transport/mcp/bounded-transport.js";
import { openLocal } from "./app.js";
import { loadProjectBinding } from "../../adapters/project/binding.js";

const usage = `Skilly 0.1.0 — local project memory (Node.js 24+)
  skilly serve [--db /absolute/path/memory.sqlite] [--project /absolute/project]
  skilly call <tool-name> [--db /absolute/path/memory.sqlite] [--project /absolute/project] < input.json
  skilly --help

Default DB: ~/.skilly/memory.sqlite
--project binds this connection to skilly.project.json in that directory.
serve uses MCP over stdin/stdout. call reads one JSON object from stdin.
No network server, AI model, file watcher or automatic execution collector.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { db: { type: "string" }, project: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) { process.stdout.write(usage); return; }
  const [command, tool] = positionals;
  if ((command !== "serve" && command !== "call")
    || (command === "serve" && positionals.length !== 1)
    || (command === "call" && (positionals.length !== 2 || !tool))) {
    throw new MemoryError("invalid_command", "Use serve or call <tool-name>. See --help.");
  }
  // Validate CLI input before creating any database.
  const input = command === "call" ? await readInput() : undefined;
  const binding = values.project ? loadProjectBinding(values.project) : undefined;
  const app = openLocal(values.db ?? join(homedir(), ".skilly", "memory.sqlite"), binding);
  if (command === "call" && tool) {
    try { process.stdout.write(`${JSON.stringify(await app.dispatcher.call(tool, input))}\n`); }
    finally { await app.close(); }
    return;
  }
  const server = createMcpServer(app.dispatcher);
  const transport = new BoundedTransport(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_FRAME_BYTES }));
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= (async () => {
      await app.dispatcher.drain();
      await server.close();
      process.stdin.destroy();
      process.stdout.destroy();
      await app.close();
    })();
    return closing;
  };
  const requestShutdown = () => { void shutdown().catch(() => { process.exitCode = 1; }); };
  server.server.onclose = requestShutdown;
  server.server.onerror = () => { process.stderr.write("Skilly: MCP protocol error.\n"); };
  process.stdin.once("end", requestShutdown);
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.stdout.once("error", requestShutdown);
  try { await server.connect(transport); }
  catch (error) { await shutdown(); throw error; }
}

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.byteLength;
    if (length > MAX_INPUT_BYTES) throw new MemoryError("payload_too_large", "Input exceeds 128 KiB.");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new MemoryError("invalid_json", "Provide one valid JSON object on stdin."); }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
  process.exitCode = 1;
});
