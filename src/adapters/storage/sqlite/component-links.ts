import type { SQLOutputValue } from "node:sqlite";

export function componentProjection(rows: Record<string, SQLOutputValue>[], source: string) {
  return { components: rows.slice(0, 12).map(row => ({ key: String(row["key"]), name: String(row["name"]) })),
    components_truncated: rows.length > 12, component_source: source };
}

/** The relation and key are static SQL supplied by callers. Only the selected key is bound. */
export function componentWhere(component: string | undefined, relation: string, key: string) {
  return component === undefined ? { sql: "1", params: [] as string[] }
    : component === "unclassified" ? { sql: `NOT EXISTS (${relation})`, params: [] as string[] }
    : { sql: `EXISTS (${relation} AND ${key}=?)`, params: [component] };
}
