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
  skilly exec --db /absolute/memory.sqlite --project /absolute/project --run-id <UUID> [--record-id <UUID>] [--timeout-ms 60000] -- executable args
  skilly backup --db /absolute/memory.sqlite --output /absolute/new-backup-directory
  skilly restore --input /absolute/backup-directory --output /absolute/new-restored-directory
  skilly export --db /absolute/memory.sqlite --project-id <UUID> --output /absolute/new-export-directory
  skilly import --input /absolute/export-directory --output /absolute/new-db-directory [--db /absolute/base.sqlite]
  skilly skill-export --db /absolute/memory.sqlite --project-id <UUID> --skill <key> [--version <version>] --output /absolute/new-package.json
  skilly skill-install --input /absolute/package.json --project /absolute/project --tool codex|cursor [--folder <name>]
  skilly skill-verify --input /absolute/package.json --project /absolute/project --tool codex|cursor [--folder <name>]
  skilly --help

Default DB: ~/.skilly/memory.sqlite
--project binds this connection to skilly.project.json in that directory.
serve uses MCP over stdin/stdout. call reads one JSON object from stdin.
This CLI/MCP uses no network server, AI model, file watcher or automatic execution collector.
The optional local viewer is a separate command: npm run view -- --db /absolute/path/memory.sqlite
Maintenance never overwrites an existing output directory. Import with --db adds to a NEW COPY of that DB.
Incomplete outputs are retained without a completion marker; never use them. No transfer switches the live connection.
`;

async function main(): Promise<void> {
  if (process.argv[2] === "exec") {
    const { executeCommand } = await import("./execute.js");
    process.exitCode = await executeCommand(process.argv.slice(3));
    return;
  }
  const { values, positionals } = parseArgs({
    options: { db: { type: "string" }, project: { type: "string" }, help: { type: "boolean", short: "h" },
      input: { type: "string" }, output: { type: "string" }, "project-id": { type: "string" },
      skill: { type: "string" }, version: { type: "string" }, tool: { type: "string" }, folder: { type: "string" } },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) { process.stdout.write(usage); return; }
  const [command, tool] = positionals;
  if (command && ["skill-export", "skill-install", "skill-verify"].includes(command)) {
    if (positionals.length !== 1) throw new MemoryError("invalid_command", "Use one skill package command.");
    const { skillPackageCommand } = await import("./skill-package.js");
    process.stdout.write(`${JSON.stringify(skillPackageCommand(command, values))}\n`);
    return;
  }
  if (values.skill || values.version || values.tool || values.folder) throw new MemoryError("invalid_input", "Skill options require a skill package command.");
  if (command && ["backup", "restore", "export", "import"].includes(command)) {
    if (positionals.length !== 1) throw new MemoryError("invalid_command", "Maintenance takes one command only.");
    const { maintenance } = await import("./maintenance.js");
    const result = await maintenance(command, values);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (values.input || values.output || values["project-id"]) throw new MemoryError("invalid_input", "Maintenance options require a maintenance command.");
  if ((command !== "serve" && command !== "call")
    || (command === "serve" && positionals.length !== 1)
    || (command === "call" && (positionals.length !== 2 || !tool))) {
    throw new MemoryError("invalid_command", "Use serve or call <tool-name>. See --help.");
  }
  // Validate CLI input before creating any database.
  const input = command === "call" ? await readInput() : undefined;
  const binding = values.project ? loadProjectBinding(values.project) : undefined;
  const app = openLocal(values.db ?? join(homedir(), ".skilly", "memory.sqlite"), binding, values.project);
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
