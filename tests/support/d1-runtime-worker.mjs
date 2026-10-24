// Test-only entrypoint. No remote binding, credentials, authentication or production route.
import { D1AtomicCommitStore } from '../../dist/adapters/storage/d1/atomic-store.js';
import { D1TaskReader } from '../../dist/adapters/storage/d1/task-reader.js';
import { D1Decisions } from '../../dist/adapters/storage/d1/decisions.js';
import { D1Plans } from '../../dist/adapters/storage/d1/plans.js';
import { D1Executions } from '../../dist/adapters/storage/d1/executions.js';
import { D1TaskEvents } from '../../dist/adapters/storage/d1/task-events.js';

export default {
  async fetch(request, env) {
    const input = await request.json();
    const store = new D1AtomicCommitStore(env.DB, input.project_id);
    try {
      if (input.operation === 'commit') return Response.json({ status: await store.commit(input.mutation) });
      if (input.operation === 'receipt') return Response.json({ receipt: await store.getReceipt(input.project_id, input.key) });
      if (input.operation === 'task') return Response.json(await new D1TaskReader(env.DB, input.scope).getTask(input.id));
      if (input.operation === 'record') return Response.json(await new D1TaskReader(env.DB, input.scope).getRecord(input.id));
      if (input.operation === 'tasks') return Response.json(await new D1TaskReader(env.DB, input.scope).listTasks(input.query));
      if (input.operation === 'decisions') return Response.json(await new D1Decisions(env.DB, input.scope).query(input.query));
      if (input.operation === 'save-plan') return Response.json(await new D1Plans(env.DB, input.scope).save(input.input));
      if (input.operation === 'update-plan') return Response.json(await new D1Plans(env.DB, input.scope).update(input.input));
      if (input.operation === 'plans') return Response.json(await new D1Plans(env.DB, input.scope).query(input.query));
      // Host-sink contract fixtures only, never production AI tools or an authenticated endpoint.
      if (input.operation === 'execution-start') return Response.json(await new D1Executions(env.DB, input.scope).start(input.input));
      if (input.operation === 'execution-finish') return Response.json(await new D1Executions(env.DB, input.scope).finish(input.input));
      if (input.operation === 'executions') return Response.json(await new D1Executions(env.DB, input.scope).list(input.run_id,input.offset));
      if (input.operation === 'event-receive') return Response.json(await new D1TaskEvents(env.DB,input.scope).receive(input.input));
      if (input.operation === 'event-link') return Response.json(await new D1TaskEvents(env.DB,input.scope).link(input.input));
      if (input.operation === 'event-status') return Response.json(await new D1TaskEvents(env.DB,input.scope).status(input.run_id));
      if (input.operation === 'event-observations') return Response.json(await new D1TaskEvents(env.DB,input.scope).observations(input.offset));
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json({ error: error.code ?? 'unexpected_error', retryable: error.retryable ?? false }, { status: 409 });
    }
  },
};
