import test from "node:test";
import assert from "node:assert/strict";
import { recordingCoverage, recordingDelivery } from "../dist/core/memory/recording-health.js";

test("delivery distinguishes receipt, retained retry, blocked input and absent input", () => {
  for (const state of ["saved", "conflict", "blocked", "unconfirmed", "retry_required", "rejected"]) {
    assert.equal(recordingDelivery(true, true, state), "saved");
    assert.equal(recordingDelivery(true, false, state), "saved");
    assert.equal(recordingDelivery(false, false, state), "not_retained");
  }
  for (const state of ["unconfirmed", "retry_required"]) assert.equal(recordingDelivery(false, true, state), "recovery_pending");
  for (const state of ["conflict", "blocked", "rejected", "unknown"]) assert.equal(recordingDelivery(false, true, state), "recovery_blocked");
  assert.equal(recordingCoverage().missing_record_count, null);
  assert.equal(recordingCoverage().completeness, "unknown");
  assert.equal(recordingCoverage().unreceived_writes, "not_observable");
  assert.equal(recordingCoverage().execution_events, "not_collected");
});
