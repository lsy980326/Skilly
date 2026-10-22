import { parseArgs } from "node:util";
import { recordLifecycle } from "../../adapters/storage/sqlite/lifecycle.js";

export async function codexHook(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" }, project: { type: "string" } } });
  if (!values.db || !values.project) throw new Error("Explicit project and DB paths are required.");
  if (process.env["SKILLY_RECORDING"] === "off") { process.stdout.write("{}\n"); return; }
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 128 * 1024) throw new Error("Hook input exceeds 128 KiB; event not retained.");
    chunks.push(bytes);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const saved = recordLifecycle(values.db, values.project, input);
  // A reminder uses the configured MCP, never a CLI fallback or direct record write.
  const event = input !== null && typeof input === "object" && "hook_event_name" in input ? input.hook_event_name : undefined;
  const reminder = "Skilly lifecycle observation saved; this is not a work-record receipt. Follow use-skilly through the configured MCP: resolve and recall, confirm a saved task start before editing, checkpoint meaningful changes, inspect recovery after reconnecting and finish your own task. Honor recording opt-out. Never invent missing records or close another session's run.";
  const link = ` Current observation_id=${saved.observation_id}. If memory_link_task_events is exposed and your own task start is saved, link this current session explicitly before further work. Never use an ID from another chat or infer ownership from time. Linking covers future events only.`;
  process.stdout.write(JSON.stringify(event === "SessionStart" || event === "PostToolUse"
    ? { hookSpecificOutput: { hookEventName: event, additionalContext: reminder + link } }
    : { systemMessage: `Skilly event ${saved.observation_id} saved. ${reminder}` }) + "\n");
}
