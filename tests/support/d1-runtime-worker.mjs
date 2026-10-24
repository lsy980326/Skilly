// Test-only entrypoint. No remote binding, credentials, authentication or production route.
import { D1AtomicCommitStore } from '../../dist/adapters/storage/d1/atomic-store.js';

export default {
  async fetch(request, env) {
    const input = await request.json();
    const store = new D1AtomicCommitStore(env.DB, input.project_id);
    try {
      if (input.operation === 'commit') return Response.json({ status: await store.commit(input.mutation) });
      if (input.operation === 'receipt') return Response.json({ receipt: await store.getReceipt(input.project_id, input.key) });
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json({ error: error.code ?? 'unexpected_error', retryable: error.retryable ?? false }, { status: 409 });
    }
  },
};
