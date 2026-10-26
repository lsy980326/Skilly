import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SqliteRemoteOutbox } from '../../adapters/storage/sqlite/remote-outbox.js';
import { CloudMcpConnection } from '../../adapters/remote/cloud-mcp-connection.js';
import { RemoteHostSession } from '../../adapters/remote/host-session.js';
import { remoteDestinationSchema } from '../../core/access/remote-outbox.js';
import { createRemoteProxy } from '../../transport/mcp/remote-proxy.js';
import { BoundedTransport } from '../../transport/mcp/bounded-transport.js';
import { MAX_FRAME_BYTES } from '../../transport/tools.js';
import { startRemoteRecoveryViewer } from '../../transport/viewer/remote-recovery.js';

export async function remoteServe(args:string[]){
 const {values}=parseArgs({args,options:{endpoint:{type:'string'},'project-id':{type:'string'},repository:{type:'string'},environment:{type:'string'},outbox:{type:'string'},'credential-env':{type:'string'},'viewer-port':{type:'string'},help:{type:'boolean'}}});
 if(values.help){process.stdout.write('skilly remote-serve --endpoint <exact HTTPS MCP URL> --project-id <UUID> --repository <scope> --environment <scope> --outbox /absolute/remote.sqlite --credential-env <explicit variable name> [--viewer-port 0]\nExplicit remote transmission only. No account login, config edits or local memory DB fallback. Viewer uses loopback and separate local authentication.\n');return;}
 if(!values.outbox||!values['credential-env']||!/^SKILLY_[A-Z0-9_]{1,90}$/.test(values['credential-env']))throw Error('An explicit private outbox and SKILLY_ credential environment variable name are required.');
 const destination=remoteDestinationSchema.parse({endpoint:values.endpoint,scope:{project_id:values['project-id'],repository:values.repository,environment:values.environment}});
 const viewerPort=values['viewer-port'];if(viewerPort!==undefined&&(!/^\d{1,5}$/.test(viewerPort)||Number(viewerPort)>65535))throw Error('Invalid viewer port.');
 const store=new SqliteRemoteOutbox(values.outbox,destination),session=new RemoteHostSession(store,new CloudMcpConnection(destination,async()=>process.env[values['credential-env']!]),()=>process.env['SKILLY_RECORDING']!=='off');
 const server=createRemoteProxy(session);
 let viewer:Awaited<ReturnType<typeof startRemoteRecoveryViewer>>|undefined;
 let closing:Promise<void>|undefined;
 const close=()=>closing??=Promise.resolve().then(async()=>{server.onclose=()=>{};await server.close();await session.close();await viewer?.close();process.stdin.destroy();});
 const stop=()=>{void close().catch(()=>{process.exitCode=1;});};
 server.onclose=stop;server.onerror=()=>{process.stderr.write('Skilly remote: protocol error.\n');};
 process.stdin.once('end',stop);process.once('SIGINT',stop);process.once('SIGTERM',stop);process.stdout.once('error',stop);
 try{
  if(viewerPort!==undefined){viewer=await startRemoteRecoveryViewer(session,Number(viewerPort));process.stderr.write(`Skilly 원격 저장 상태: ${viewer.url}\n`);}
  await server.connect(new BoundedTransport(new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:MAX_FRAME_BYTES})));
 }catch(error){await close();throw error;}
}
