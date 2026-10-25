import {D1TaskEvents} from '../../dist/adapters/storage/d1/task-events.js';
import {D1CurrentKnowledge} from '../../dist/adapters/storage/d1/current-knowledge.js';
import {D1Skills} from '../../dist/adapters/storage/d1/skills.js';
import {d1WriteAuthority} from '../../dist/adapters/storage/d1/authority.js';
// Test-only host binding selection, not a remote/authenticated product endpoint.
export default {async fetch(request,env){try{const i=await request.json(),db=env[i.binding];if(!db)return new Response(null,{status:404});const scope={project_id:i.scope.project_id,repository:i.scope.repository,environment:i.scope.environment};return Response.json({authority:await d1WriteAuthority(db,i.scope.project_id),events:await new D1TaskEvents(db,i.scope).status(i.run_id),knowledge:await new D1CurrentKnowledge(db,scope).query(),skills:await new D1Skills(db,{...scope,root_hash:i.scope.root_hash}).taskSkills(i.run_id)});}catch(e){return Response.json({error:e.message},{status:409});}}};
