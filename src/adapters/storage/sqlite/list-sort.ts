import { listSort, type ListSort } from "../../../core/viewer/sorting.js";

/** Expressions come from callers' static SQL, never from the request. */
export function listOrder(sort: ListSort | undefined, fields: { name: string; date: string; active: string; tie: string; fallback: string }): string {
  if (listSort(sort) === undefined) return fields.fallback;
  if (sort === "name" || sort === "name_desc") return `${fields.name} COLLATE NOCASE ${sort === "name" ? "ASC" : "DESC"}, ${fields.tie}`;
  return `${sort === "active" ? `(${fields.active}) DESC, ` : ""}(${fields.date}) IS NULL ASC, ${fields.date} ${sort === "oldest" ? "ASC" : "DESC"}, ${fields.tie}`;
}
