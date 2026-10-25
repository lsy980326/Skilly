import {CloudflareAccessAuthenticator} from '../../dist/adapters/auth/cloudflare-access.js';
import {createCloudHandler} from '../../dist/transport/cloud/server.js';
// Test-provided public keys only. No account, private key, login or remote key fetch.
export default {async fetch(request,env){return createCloudHandler(env.DB,new CloudflareAccessAuthenticator(env.PUBLIC_AUTH_POLICY))(request);}};
