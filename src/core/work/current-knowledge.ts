import { z } from "zod";
import { workKey } from "./schema.js";
import type { JsonObject } from "../memory/model.js";

const scope = z.string().trim().min(1).max(100).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
const offset = z.int().min(0).max(1000000).default(0);
export const currentKnowledgeQuery = z.strictObject({
  project_id: z.uuid(), repository: scope.optional(), environment: scope.optional(), component: workKey.optional(),
  limit: z.int().min(1).max(6).default(4), decisions_offset: offset, plans_offset: offset, features_offset: offset,
});
export type CurrentKnowledgeQuery = z.infer<typeof currentKnowledgeQuery>;
export interface CurrentKnowledgeReader { query(input: CurrentKnowledgeQuery): JsonObject; }

/** Bounded D1/remote projection; local readers retain their existing larger cursor domain. */
export const cloudKnowledgeQuery=z.strictObject({component:workKey.optional(),limit:z.int().min(1).max(6).default(4),
 decisions_offset:z.int().min(0).max(100000).default(0),plans_offset:z.int().min(0).max(100000).default(0),features_offset:z.int().min(0).max(100000).default(0)});
