import type { ExecutionRow } from "./model.js";
import type { SourceObservation } from "./currentness.js";
import type { TestDetails } from "./test-details.js";

export type ExecutionStart = { project_id:string; run_id:string; record_id?:string; executable:string; command_hash:string; source_observation?:SourceObservation };
export type ExecutionResult = Pick<ExecutionRow,"outcome"|"exit_code"|"signal"|"error_code"|"duration_ms"|"stdout_bytes"|"stderr_bytes"|"stdout_hash"|"stderr_hash"|"stdout_hashed_bytes"|"stderr_hashed_bytes"|"output_complete">;
/** Internal host sink only. Neither command permission nor authenticated attestation. */
export interface ExecutionSink {
  start(input:ExecutionStart):string|Promise<string>;
  finish(id:string,result:ExecutionResult,details?:TestDetails,after?:SourceObservation):void|Promise<void>;
}
