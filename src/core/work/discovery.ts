export function normalizeAlias(value: string): string { return value.normalize("NFKC").toLowerCase(); }

/** Repository-relative metadata, never a path to open or an instruction to scan. */
export function normalizeCodePath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || /^[~/]/.test(path) || /[:\u0000-\u001f\u007f]/.test(path)) return null;
  const parts = path.split("/").filter(part => part !== "." && part !== "");
  if (!parts.length || parts.some(part => part === ".." || /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.skilly)$/i.test(part) || /\.(?:pem|key)$/i.test(part))) return null;
  return parts.join("/");
}

export function pathMatches(path: string, query: string): boolean {
  const normalized = normalizeCodePath(query);
  if (!normalized) return false;
  const p = path.toLowerCase(), q = normalized.toLowerCase();
  return (`/${p}/`).includes(`/${q}/`) || q.startsWith(`${p}/`);
}
