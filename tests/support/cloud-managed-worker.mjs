import {createManagedCloudHandler} from '../../dist/transport/cloud/managed-server.js';
let handler;
// Keeps the same handler across rotation. No account or remotely fetched keys.
export default {fetch(request,env){handler??=createManagedCloudHandler(env.DB,'personal-test');return handler(request);}};
