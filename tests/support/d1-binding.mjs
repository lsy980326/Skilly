import { DatabaseSync } from 'node:sqlite';

/** SQLite-backed D1 API shape, NOT workerd/Miniflare or Cloudflare conformance. */
export class LocalD1Binding {
  constructor(db) { this.db = db; this.constraints = []; this.batchCalls = 0; }
  withSession(constraint) {
    this.constraints.push(constraint);
    return {
      prepare: sql => new Statement(this, sql),
      batch: async statements => {
        this.batchCalls++;
        if (this.beforeBatch) { const fn = this.beforeBatch; this.beforeBatch = undefined; await fn(); }
        this.db.exec('BEGIN IMMEDIATE');
        let results;
        try {
          results = statements.map((s, index) => {
            const result = s.execute();
            if (this.failAfter === index) throw Error('injected statement failure');
            return result;
          });
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        if (this.loseResponse) { this.loseResponse = false; throw Error('response lost after commit'); }
        if (this.malformedResponse) return [];
        return results;
      },
    };
  }
}
class Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.binding, this.sql, values); }
  execute() {
    const db = this.binding.db;
    const results = db.prepare(this.sql).all(...this.values);
    return { success: true, results, meta: { changes: db.prepare('SELECT changes() AS n').get().n } };
  }
  async all() {
    if (this.binding.failReads || this.binding.failReceiptReads && this.sql.startsWith('SELECT payload_hash')) throw Error('receipt read unavailable');
    return this.execute();
  }
}

export function openD1Database(path) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA busy_timeout=1000');
  return db;
}
