import {createCloudMcpHandler} from '../../dist/transport/mcp/cloud-http.js';
let handler;
// Public test endpoint/scope only. Keys and credentials are not supplied in bindings.
export default {fetch(request,env){handler??=createCloudMcpHandler(env.DB,env.MCP_CONFIG);return handler(request);}};
