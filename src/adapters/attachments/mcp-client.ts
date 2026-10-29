import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { attachmentName, attachmentLinkRow, ATTACHMENT_LIMITS } from "../../core/attachments/model.js";
import { prepareAttachment } from "../../core/attachments/mcp.js";

const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export async function callAttachment(client:Client,name:string,input:Record<string,unknown>):Promise<unknown> {
  const result=z.object({content:z.array(z.object({type:z.literal("text"),text:z.string()})),isError:z.boolean().optional()})
    .parse(await client.callTool({name,arguments:input})),first=result.content[0];
  if(!first||first.type!=="text")throw new Error("Missing attachment receipt; storage is not confirmed.");
  if(result.isError)throw new Error(first.text);
  return JSON.parse(first.text);
}
const receipt=z.object({status:z.literal("persisted"),attachment:attachmentLinkRow,claims_verified:z.literal(false)});

/** Host-side helper for an explicitly selected file; never walks directories or prints file bytes. */
export async function uploadSelectedAttachment(client:Client,path:string,input:{project_id:string;run_id:string;record_id?:string;selection:{kind:"user_selected";reference:string}}) {
  const target=prepareAttachment.omit({name:true,bytes:true,sha256:true}).parse(input);
  if(!isAbsolute(path))throw new Error("Select an absolute public file path.");
  const name=attachmentName.parse(basename(path));
  const source=lstatSync(path);
  if(!source.isFile()||source.isSymbolicLink())throw new Error("Select the original regular file, not a symlink.");
  const resolved=realpathSync(path);
  if([path,resolved].some(p=>p.split(/[\\/]/).some(part=>part.startsWith("."))))throw new Error("Private/hidden file paths are not attachment sources.");
  const fd=openSync(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes:Buffer;
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.dev!==source.dev||stat.ino!==source.ino||stat.size>ATTACHMENT_LIMITS.file_bytes)throw new Error("Select the same regular original no larger than 4 MiB.");
    const buffer=Buffer.alloc(ATTACHMENT_LIMITS.file_bytes+1);let length=0;
    while(length<buffer.length){const count=readSync(fd,buffer,length,buffer.length-length,null);if(!count)break;length+=count;}
    if(length>ATTACHMENT_LIMITS.file_bytes)throw new Error("Original grew beyond the attachment limit; nothing uploaded.");
    bytes=buffer.subarray(0,length);
  } finally {closeSync(fd);}
  const manifest=prepareAttachment.parse({...target,name,bytes:bytes.length,sha256:hash(bytes)});
  const checkedReceipt=(value:unknown)=>{
    const result=receipt.parse(value),link=result.attachment;
    if(link.project_id!==manifest.project_id||link.run_id!==manifest.run_id||link.record_id!==(manifest.record_id??null)||link.name!==manifest.name||link.sha256!==manifest.sha256)
      throw new Error("Attachment receipt differs from the selected target/original.");
    return result;
  };
  const prepared=await callAttachment(client,"memory_prepare_attachment",manifest);
  const duplicate=receipt.safeParse(prepared);if(duplicate.success)return checkedReceipt(duplicate.data);
  const upload=z.object({status:z.literal("receiving"),upload_id:z.uuid(),parts:z.int().min(1).max(64),chunk_bytes:z.literal(65536)}).parse(prepared);
  if(upload.parts!==Math.max(1,Math.ceil(bytes.length/upload.chunk_bytes)))throw new Error("Invalid original part count.");
  const scope={project_id:input.project_id,run_id:input.run_id,upload_id:upload.upload_id};
  for(let part=0;part<upload.parts;part++)await callAttachment(client,"memory_put_attachment_part",{...scope,part,
    data_base64:bytes.subarray(part*upload.chunk_bytes,(part+1)*upload.chunk_bytes).toString("base64")});
  return checkedReceipt(await callAttachment(client,"memory_commit_attachment",scope));
}

/** Returns bytes to the caller; never creates/overwrites a source or download file. */
export async function readStoredAttachment(client:Client,input:{project_id:string;run_id:string;attachment_id:string}) {
  const schema=z.object({attachment:attachmentLinkRow,bytes:z.int().min(0).max(ATTACHMENT_LIMITS.file_bytes),
    part:z.int().min(0).max(63),parts:z.int().min(1).max(64),data_base64:z.string().max(87384),claims_verified:z.literal(false)});
  const first=schema.parse(await callAttachment(client,"memory_read_attachment_part",{...input,part:0}));
  if(first.attachment.id!==input.attachment_id||first.attachment.project_id!==input.project_id||first.attachment.run_id!==input.run_id
    ||first.parts!==Math.max(1,Math.ceil(first.bytes/ATTACHMENT_LIMITS.chunk_bytes)))throw new Error("Original scope/size differs.");
  const buffers:Buffer[]=[];
  for(let part=0;part<first.parts;part++){
    const item=part===0?first:schema.parse(await callAttachment(client,"memory_read_attachment_part",{...input,part}));
    if(item.part!==part||item.parts!==first.parts||item.bytes!==first.bytes||JSON.stringify(item.attachment)!==JSON.stringify(first.attachment))throw new Error("Original changed while reading.");
    const bytes=Buffer.from(item.data_base64,"base64");
    if(bytes.toString("base64")!==item.data_base64||bytes.length>ATTACHMENT_LIMITS.chunk_bytes)throw new Error("Invalid original encoding.");
    buffers.push(bytes);
  }
  const bytes=Buffer.concat(buffers);
  if(bytes.length!==first.bytes||hash(bytes)!==first.attachment.sha256)throw new Error("Original integrity mismatch; do not use these bytes.");
  return {attachment:first.attachment,bytes,claims_verified:false};
}
