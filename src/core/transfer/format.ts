import { z } from "zod";
import { testDetailsRowSchema } from "../execution/test-details.js";
import { executionRowSchema } from "../execution/model.js";

export const MAX_DATA_BYTES = 64 * 1024 * 1024;
export const MAX_LINE_BYTES = 256 * 1024;
export const MAX_ROWS = 100_000;
const text = z.string(), integer = z.number().int().safe();
const id = z.string().uuid();
const nullable = text.nullable();
export const rowSchemas = {
  projects: z.strictObject({ id, project_key: text, name: text, revision: integer.nonnegative(), created_at: text }),
  runs: z.strictObject({ id, project_id: id, goal: text, mode: z.enum(["answer", "diagnose", "review", "change"]), environment: text,
    repository: text, state: z.enum(["active", "completed", "interrupted"]), created_at: text, updated_at: text }),
  records: z.strictObject({ id, project_id: id, run_id: id, topic: text, kind: z.enum(["note", "decision", "change", "issue", "summary"]),
    body: text, environment: text, repository: text, source_fingerprint: nullable, observed_at: text, recorded_at: text,
    supersedes: id.nullable(), superseded_by: id.nullable(), report_origin: z.enum(["unspecified", "contemporaneous", "retrospective"]) }),
  run_actors: z.strictObject({ run_id: id, actor: text }),
  components: z.strictObject({ project_id: id, key: text, name: text }),
  features: z.strictObject({ project_id: id, key: text, name: text, description: text }),
  run_components: z.strictObject({ project_id: id, run_id: id, component_key: text }),
  run_features: z.strictObject({ project_id: id, run_id: id, feature_key: text }),
  run_details: z.strictObject({ project_id: id, run_id: id, title: nullable, branch: nullable }),
  record_reports: z.strictObject({ project_id: id, record_id: id, report_json: text }),
  executions: executionRowSchema,
  execution_test_details: testDetailsRowSchema,
  receipts: z.strictObject({ scope: text, idempotency_key: text, payload_hash: text, result_json: text }),
  skill_versions: z.strictObject({ project_id: id, skill_key: text, version: text, source: text, name: text, description: text,
    body: text, files_json: text, content_hash: text, install_instructions: text, created_at: text }),
  skill_installations: z.strictObject({ id, project_id: id, skill_key: text, version: text, repository: text, environment: text,
    project_root: text, tool: z.enum(["codex", "cursor"]), folder: text, assigned_at: text }),
  skill_observations: z.strictObject({ id, project_id: id, installation_id: id, version: text, expected_hash: text, observed_at: text,
    state: z.enum(["matches", "modified", "missing", "unavailable"]), files_json: text }),
  requests: z.strictObject({ id: text, project_id: id, repository: text, environment: text, tool: text, request_key: text,
    payload_hash: text, input_json: nullable, received_at: text, last_error: nullable, preserve_input: z.union([z.literal(0), z.literal(1)]) }),
};
export type Table = keyof typeof rowSchemas;
export const tables = Object.keys(rowSchemas) as Table[];
const file = z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: integer.nonnegative() });
export const manifestSchema = z.strictObject({
  format: z.literal("skilly-local-transfer"), version: z.literal(1), kind: z.enum(["backup", "project"]), schema_version: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7)]),
  created_at: text, recovery_snapshot_at: text.nullable(), main_snapshot_at: text,
  project_id: id.nullable(), files: z.strictObject({ main: file, recovery: file.nullable() }),
  rows: integer.nonnegative().max(MAX_ROWS).nullable(),
});
export type Manifest = z.infer<typeof manifestSchema>;
