import {createCloudMcpHandler} from '../../dist/transport/mcp/cloud-http.js';
let handler,delayed=false;
// Public test endpoint/scope only. Keys and credentials are not supplied in bindings.
export default {fetch(request,env){
 // Test-only fault after a real committed batch; never supplied by request headers/input.
 const db=env.MCP_TEST_BATCH_DELAY_MS?{withSession(constraint){const session=env.DB.withSession(constraint);return {
  prepare:sql=>session.prepare(sql),async batch(statements){const result=await session.batch(statements);
   if(!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,env.MCP_TEST_BATCH_DELAY_MS));}return result;}
 };}}:env.DB;
 handler??=createCloudMcpHandler(db,env.MCP_CONFIG);return handler(request);
}};
