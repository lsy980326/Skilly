import { randomBytes,timingSafeEqual } from 'node:crypto';
import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { RemoteHostSession,remoteHostError } from '../../adapters/remote/host-session.js';

const json=(r:ServerResponse,status:number,value:unknown)=>{r.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});r.end(JSON.stringify(value));};
export async function remoteRecoveryRoute(session:RemoteHostSession|undefined,request:IncomingMessage,response:ServerResponse,url:URL){
 if(!['/api/remote-recovery','/api/remote-recovery/recover'].includes(url.pathname))return false;
 if(!session){json(response,200,{configured:false,claims_verified:false});return true;}
 if([...url.searchParams.keys()].some(k=>k!=='offset')){json(response,400,{error:'지원하지 않는 조회 조건입니다.'});return true;}
 try{
  if(url.pathname.endsWith('/recover')){
   if(request.method!=='POST'){json(response,405,{error:'복구는 명시적인 요청으로만 실행합니다.'});return true;}
   let bytes=0;const chunks:Buffer[]=[];
   for await(const chunk of request){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>1024)throw Error('body limit');chunks.push(b);}
   json(response,200,await session.recover(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  }else{
   if(request.method!=='GET'){json(response,405,{error:'조회는 GET만 지원합니다.'});return true;}
   const raw=url.searchParams.get('offset')??'0';if(!/^\d{1,4}$/.test(raw)||Number(raw)>1000)throw Error('offset');
   json(response,200,session.status(Number(raw)));
  }
 }catch(error){json(response,503,{error:'처리 결과를 확인하지 못했습니다. 새로고침으로 보관 상태를 확인해 주세요.',detail:remoteHostError(error)});}
 return true;
}
/** Same loopback/Bearer/origin boundary as the local viewer, without opening any memory DB. */
export async function startRemoteRecoveryViewer(session:RemoteHostSession,port=0){
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid local viewer port.');
 const token=randomBytes(32).toString('hex'),expected=Buffer.from(`Bearer ${token}`);
 const assets=new Map<string,{name:string;type:string}>([
  ['/',{name:'remote-recovery.html',type:'text/html; charset=utf-8'}],
  ['/remote-recovery.js',{name:'remote-recovery.js',type:'text/javascript; charset=utf-8'}],
  ['/remote-recovery.css',{name:'remote-recovery.css',type:'text/css; charset=utf-8'}],
  ['/session.js',{name:'session.js',type:'text/javascript; charset=utf-8'}],
  ['/style.css',{name:'style.css',type:'text/css; charset=utf-8'}],
 ]);
 let origin='';
 const server=createServer(async(request,response)=>{
  response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('X-Frame-Options','DENY');
  response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if(`http://${request.headers.host}`!==origin||(request.headers.origin!==undefined&&request.headers.origin!==origin)||request.headers['sec-fetch-site']==='cross-site'){json(response,403,{error:'이 컴퓨터의 Skilly 화면에서만 접근할 수 있습니다.'});return;}
  const url=new URL(request.url??'/',origin),asset=assets.get(url.pathname);
  if(request.method==='GET'&&asset){response.writeHead(200,{'Content-Type':asset.type});response.end(readFileSync(new URL(`../../../ui/${asset.name}`,import.meta.url)));return;}
  const supplied=Buffer.from(request.headers.authorization??'');
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){json(response,401,{error:'전체 연결 주소로 다시 열어 주세요.'});return;}
  if(url.origin!==origin||request.method==='POST'&&request.headers.origin!==origin){json(response,403,{error:'Skilly 화면에서 복구를 요청해 주세요.'});return;}
  if(!await remoteRecoveryRoute(session,request,response,url))json(response,404,{error:'페이지를 찾을 수 없습니다.'});
 });
 server.maxConnections=16;server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=2000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){reject(Error('Missing listener'));return;}origin=`http://127.0.0.1:${address.port}`;resolve();});});
 return {origin,url:`${origin}/#token=${token}`,close:()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
