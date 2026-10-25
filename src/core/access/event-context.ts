import { z } from 'zod';
import { eventRowSchemas } from '../transfer/events.js';
import type { AccessScope,Principal } from './model.js';

const fields=eventRowSchemas.events.shape;
/** Selected by the host for an authenticated principal, never by MCP arguments or headers. */
export const cloudEventContextSchema=z.strictObject({root_hash:fields.root_hash,session_hash:fields.session_hash,
 observation_id:fields.id.nullable().optional()});
export type CloudEventContext=z.infer<typeof cloudEventContextSchema>;
export type CloudEventContextProvider=(scope:AccessScope,principal:Principal)=>CloudEventContext|undefined;
export function resolveCloudEventContext(provider:CloudEventContextProvider|undefined,scope:AccessScope,principal:Principal){
 const value=provider?.(structuredClone(scope),structuredClone(principal));
 return value===undefined?undefined:cloudEventContextSchema.parse(structuredClone(value));
}
export const cloudEventLinkFields={run_id:z.uuid(),observation_id:fields.id,idempotency_key:z.string().trim().min(1).max(200)};
