import type { RunState } from "../memory/model.js";

export type Activity = "recent" | "unfinished" | "completed" | "interrupted";
export const RECENT_ACTIVITY_MS = 5 * 60_000;

/** A recent report is evidence of a write, never a heartbeat from a running agent. */
export function activityFor(state: RunState, updatedAt: string, now = Date.now()): Activity {
  if (state !== "active") return state;
  const age = now - Date.parse(updatedAt);
  return age >= 0 && age <= RECENT_ACTIVITY_MS ? "recent" : "unfinished";
}

export class ViewerError extends Error {
  constructor(public readonly code: "invalid_input" | "not_found" | "unavailable", message: string) {
    super(message);
  }
}
