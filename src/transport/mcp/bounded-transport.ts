import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { MAX_INPUT_BYTES } from "../tools.js";

/** Keep admission until the response is actually handed to the output stream. */
export class BoundedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly pending = new Map<RequestId, number>();
  private bytes = 0;
  private closed = false;
  private readonly encoder = new TextEncoder();
  private outgoing: Promise<void> = Promise.resolve();

  constructor(private readonly inner: Transport) {
    inner.onclose = () => {
      this.closed = true;
      this.pending.clear();
      this.bytes = 0;
      this.onclose?.();
    };
    inner.onerror = error => { this.abort(error); };
    inner.onmessage = message => {
      if (this.closed) return;
      if ("method" in message && "id" in message) {
        const bytes = this.encoder.encode(JSON.stringify(message)).byteLength;
        const argumentBytes = this.encoder.encode(JSON.stringify(message.params?.["arguments"]) ?? "").byteLength;
        if (this.pending.has(message.id) || this.pending.size >= 32 || this.bytes + bytes > 1024 * 1024
          || (message.method === "tools/call" && argumentBytes > MAX_INPUT_BYTES)) {
          // Do not enqueue another error response into an already blocked sink.
          this.abort(new Error("MCP request capacity or input size exceeded."));
          return;
        }
        this.pending.set(message.id, bytes);
        this.bytes += bytes;
      }
      this.onmessage?.(message);
    };
  }

  async start(): Promise<void> { await this.inner.start(); }

  send(message: JSONRPCMessage): Promise<void> {
    const sent = this.outgoing.then(() => this.sendOne(message));
    // Callers receive `sent` (including failures). The queue can still close or
    // advance after a failure without accumulating Writable drain listeners.
    this.outgoing = sent.catch(() => {});
    return sent;
  }

  private async sendOne(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("MCP connection closed.");
    await this.inner.send(message);
    if ("id" in message && !("method" in message) && message.id !== undefined) {
      this.bytes -= this.pending.get(message.id) ?? 0;
      this.pending.delete(message.id);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.inner.close();
  }

  private abort(error: Error): void {
    this.onerror?.(error);
    void this.close().catch(() => { this.onclose?.(); });
  }
}
