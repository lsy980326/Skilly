import type { JsonObject } from "../memory/model.js";

export type Component = { key: string; name: string };
export type Feature = { key: string; name: string; description?: string | undefined; aliases?: string[] | undefined; code_paths?: string[] | undefined };
export type FeatureState = "planned" | "in_progress" | "implemented" | "blocked" | "retired";
export type StructuredReport = {
  title: string;
  summary: string;
  import_source?: { path: string; sha256: string; bytes: number; source_root: string; access: "host_supplied_text"; part: number; parts: number } | undefined;
  changes?: string[] | undefined;
  checks?: { name: string; result: "passed" | "failed" | "not_run"; detail?: string | undefined }[] | undefined;
  limitations?: string[] | undefined;
  next_steps?: string[] | undefined;
  feature_updates?: { key: string; state: FeatureState; summary: string }[] | undefined;
};
export type WorkLinks = { components?: Component[] | undefined; features?: Feature[] | undefined };
export type WorkIdentity = { title?: string; branch?: string; components: Component[]; features: Feature[];
  components_total?: number; features_total?: number; links_truncated?: boolean };
export type WorkMutation = WorkLinks & {
  run_id?: string;
  title?: string;
  branch?: string;
  record_id?: string;
  report?: StructuredReport;
};
export type OverviewQuery = {
  project_id: string;
  view: "components" | "features" | "tasks";
  repository?: string | undefined;
  environment?: string | undefined;
  component?: string | undefined;
  feature?: string | undefined;
  query?: string | undefined;
  state?: string | undefined;
  offset: number;
  limit: number;
};
export interface WorkReader {
  identity(projectId: string, runId: string): WorkIdentity;
  report(projectId: string, recordId: string): StructuredReport | undefined;
  overview(input: OverviewQuery): JsonObject;
}
