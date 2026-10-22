import { createHash } from "node:crypto";
import { DocumentImporter, markdownParts, type MarkdownLibrary } from "../../core/documents/importer.js";
import { MemoryError } from "../../core/memory/model.js";

/** Validate submitted text only; never open its declared source path. */
export function submittedMarkdownSource(sourceRoot: string, path: string, text: string) {
  const pieces = path.split("/");
  if (!path || path.length > 300 || !/\.(md|markdown)$/i.test(path) || pieces.some(piece => !piece || piece.startsWith(".") || /[\\\x00-\x1f\x7f]/.test(piece)
    || /^(node_modules|credentials?|auth|tokens?|secrets?|id_rsa|id_ed25519)(\.(md|markdown))?$/i.test(piece)
    || /(^|[-_.])(credentials?|secrets?|private[-_]key)([-_.]|$)/i.test(piece))) {
    throw new MemoryError("invalid_path", "Provide a selected public Markdown label relative to this project; private, hidden and parent paths are forbidden.");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > 48 * 1024) throw new MemoryError("document_limit", "Select Markdown up to 48 KiB.");
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || new TextDecoder("utf-8", {ignoreBOM:true}).decode(Buffer.from(text)) !== text) {
    throw new MemoryError("invalid_document", "Provide nonempty UTF-8 Markdown without binary or broken surrogate characters.");
  }
  return { path, sha256: createHash("sha256").update(text).digest("hex"), bytes, source_root: sourceRoot, access: "host_supplied_text" as const };
}
export function previewMarkdown(sourceRoot: string, path: string, text: string) {
  return { source: submittedMarkdownSource(sourceRoot, path, text), parts: markdownParts(text).length, claims_verified: false, source_path_verified: false,
    persistence: "not_written", next_step: "Import this reviewed text/path with its sha256 as expected_hash. Skilly did not inspect the filesystem." };
}

export class SubmittedMarkdownLibrary implements MarkdownLibrary {
  constructor(private readonly sourceRoot: string, private readonly importer: DocumentImporter) {}
  preview(path: string, text: string) { return previewMarkdown(this.sourceRoot, path, text); }
  async import(projectId: string, runId: string, path: string, text: string, expectedHash: string) {
    const source = submittedMarkdownSource(this.sourceRoot, path, text);
    if (source.sha256 !== expectedHash) throw new MemoryError("source_changed", "Submitted text changed since preview. No document records were written.");
    return this.importer.import(projectId, runId, source, text);
  }
}
