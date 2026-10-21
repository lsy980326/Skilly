export const recoverySchemaSql = `CREATE TABLE requests (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
            tool TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, input_json TEXT,
            received_at TEXT NOT NULL, last_error TEXT, preserve_input INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project_id, request_key)
          ) STRICT;
          CREATE INDEX pending_scope ON requests(project_id, repository, environment, received_at, id) WHERE input_json IS NOT NULL;
          PRAGMA application_id = 1397446994; PRAGMA user_version = 1;`;
