import { z } from "zod";
import { workKey } from "./schema.js";
export const featureQuerySchema=z.strictObject({query:z.string().trim().max(200).default(""),component:workKey.optional(),feature:workKey.optional(),
 offset:z.int().min(0).max(100000).default(0),limit:z.int().min(1).max(6).default(4)});
