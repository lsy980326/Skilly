import { ViewerError } from "./model.js";

export const listSorts = ["active", "latest", "oldest", "name", "name_desc"] as const;
export type ListSort = typeof listSorts[number];
export function listSort(value: unknown): ListSort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !listSorts.includes(value as ListSort)) throw new ViewerError("invalid_input", "정렬 방식을 다시 선택해 주세요.");
  return value as ListSort;
}
