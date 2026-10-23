import { ViewerError } from "./model.js";

export type InstallationComponent = { root: string; project_key: string; repository: string; environment: string; key: string; name: string };
export function componentSelection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) throw new ViewerError("invalid_input", "구성요소를 다시 선택해 주세요.");
  return value;
}
