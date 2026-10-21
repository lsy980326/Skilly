/** Receipt existence is separate from retained input and from the truth of a report. */
export function recordingDelivery(saved: boolean, retained: boolean, state: string) {
  if (saved) return "saved";
  if (!retained) return "not_retained";
  return ["retry_required", "unconfirmed"].includes(state) ? "recovery_pending" : "recovery_blocked";
}

export function recordingCoverage() {
  return {
    received_writes: "receipts_and_retained_requests",
    unreceived_writes: "not_observable",
    execution_events: "not_collected",
    explicit_process_results: "local_runner_only",
    missing_record_count: null,
    completeness: "unknown",
    live_execution: "unknown",
  } as const;
}
