import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, type ToolDispatcher } from "../tools.js";

export function createMcpServer(dispatcher: ToolDispatcher): McpServer {
  const server = new McpServer({ name: "skilly", version: "0.1.0" }, { maxToolInputElements: 128 });
  for (const [name, definition] of Object.entries(dispatcher.tools)) {
    server.registerTool(name, {
      description: definition.description,
      inputSchema: definition.schema,
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }, async (input: unknown): Promise<CallToolResult> => {
      try {
        const result = await dispatcher.call(name, input);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(errorResult(error)) }] };
      }
    });
  }
  return server;
}
