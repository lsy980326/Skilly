import type { IncomingMessage, ServerResponse } from "node:http";
import type { SqliteViewer } from "../../adapters/storage/sqlite/viewer.js";
import { saveAttachment } from "../../adapters/storage/sqlite/attachments.js";
import { ViewerError } from "../../core/viewer/model.js";

async function uploadBody(request: IncomingMessage): Promise<unknown> {
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"]??"")) throw new ViewerError("invalid_input","첨부 요청 형식을 확인해 주세요.");
  const chunks:Buffer[]=[];let size=0,overflow=false;
  for await(const chunk of request){size+=chunk.length;if(size>6*1024*1024){overflow=true;chunks.length=0;}else if(!overflow)chunks.push(chunk);}
  if(overflow)throw new ViewerError("invalid_input","첨부는 파일당 4 MiB까지 보관할 수 있습니다.");
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}
  catch{throw new ViewerError("invalid_input","첨부 내용을 읽지 못했습니다. 같은 파일로 다시 시도해 주세요.");}
}
/** Called only after the viewer's existing Host/Origin/Bearer checks. */
export async function attachmentRoute(path:string,reader:SqliteViewer,request:IncomingMessage,response:ServerResponse,url:URL):Promise<boolean>{
  const original=/^\/api\/attachments\/([^/]+)\/original$/.exec(url.pathname);
  if(url.pathname!=="/api/attachments"&&!original)return false;
  if([...url.searchParams.keys()].some(k=>!["project","run","offset"].includes(k)))throw new ViewerError("invalid_input","첨부 조회 범위를 확인해 주세요.");
  const json=(data:unknown)=>{response.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify(data));};
  if(request.method==="POST"){
    if(url.pathname!=="/api/attachments"||url.search)throw new ViewerError("invalid_input","첨부 저장 주소를 확인해 주세요.");
    if(request.headers.origin!==url.origin)throw new ViewerError("invalid_input","Skilly 화면에서 파일을 선택해 주세요.");
    json(saveAttachment(path,await uploadBody(request)));return true;
  }
  const project=url.searchParams.get("project")??"",run=url.searchParams.get("run")??"";
  if(original?.[1]){
    if(url.searchParams.has("offset"))throw new ViewerError("invalid_input","원본 조회 주소를 확인해 주세요.");
    const {link,bytes}=reader.attachmentOriginal(project,run,original[1]);
    response.writeHead(200,{"Content-Type":"application/octet-stream","Content-Length":bytes.length,
      "Content-Disposition":`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(link.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,
      "Content-Security-Policy":"sandbox; default-src 'none'","X-Skilly-Content-SHA256":link.sha256});response.end(bytes);return true;
  }
  const raw=url.searchParams.get("offset")??"0";if(!/^\d{1,7}$/.test(raw))throw new ViewerError("invalid_input","목록 위치를 확인해 주세요.");
  json(reader.attachments(project,run,Number(raw)));return true;
}
