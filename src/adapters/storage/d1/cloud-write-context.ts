import type { AccessScope,Principal } from '../../../core/access/model.js';
import type { cloudReceiptOperation } from '../../../core/access/commands.js';
import type { z } from 'zod';
import { resolveCloudEventContext,type CloudEventContextProvider } from '../../../core/access/event-context.js';
import { resolveCloudSkillScope,type CloudSkillContextProvider } from './cloud-skills.js';
import { MemoryError } from '../../../core/memory/model.js';
import type { D1Binding } from './binding.js';
import { d1WriteAuthority } from './authority.js';
import { canonical,hashText,rows } from './query.js';

/** Freeze the server-selected namespace once, before checking a retry's context precondition. */
export async function bindCloudWriteContext(db:D1Binding,storageIdentity:string|undefined,scope:AccessScope,principal:Principal,operation:z.infer<typeof cloudReceiptOperation>,events?:CloudEventContextProvider,skills?:CloudSkillContextProvider){
 if(!storageIdentity)throw new MemoryError('unsupported_capability','The host must bind an explicit storage identity before retaining remote requests.');
 const authority=await d1WriteAuthority(db,scope.project_id),generation=db.writeGeneration??0;
 if(authority['generation']!==generation||!authority['write_allowed'])throw new MemoryError('project_write_blocked','This writer generation is fenced.');
 const identityTables=await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='d1_store_identity'",[],1);
 const storeIdentity=identityTables.length?(await rows(db,'SELECT id FROM d1_store_identity',[],1))[0]?.['id']:null;
 if(identityTables.length&&(typeof storeIdentity!=='string'||!/^[a-f0-9]{32}$/.test(storeIdentity)))throw new MemoryError('invalid_data','Store identity is unavailable.');
 let namespace:AccessScope|Record<string,string>=scope;
 let fixedEvents=events,fixedSkills=skills;
 if(operation.startsWith('skill-')){
  const selected=resolveCloudSkillScope(skills,scope,principal);namespace=selected;
  fixedSkills=()=>({root_hash:selected.root_hash});
 }else if(operation.startsWith('event-')){
  const selected=resolveCloudEventContext(events,scope,principal);
  if(!selected)throw new MemoryError('unsupported_capability','No event context is bound.');
  namespace={...scope,root_hash:selected.root_hash,session_hash:selected.session_hash};
  fixedEvents=()=>selected;
 }
 return {id:await hashText(canonical({storage_identity:storageIdentity,store_identity:storeIdentity,generation,principal,scope:namespace,operation})),events:fixedEvents,skills:fixedSkills};
}
