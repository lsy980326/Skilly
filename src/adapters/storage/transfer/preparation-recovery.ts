import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { tables } from "../../../core/transfer/format.js";
import { eventTables } from "../../../core/transfer/events.js";
import { lifecycleSchemaSql } from "../sqlite/lifecycle.js";
import { taskLinkSchema } from "../sqlite/task-event-storage.js";
import { authorityRow, hasAuthority, putAuthority, type AuthorityRow, type AuthorityKind } from "../sqlite/project-authority.js";
import { initialize, validateDatabase } from "./database.js";
import { validateEventStore } from "./events.js";
import { fail, fileDescriptor, newDirectory, safePath, writeNew } from "./files.js";

/** Only the coordinator's pre-activation preparing phase may use this path.
 * An import rollback can leave valid empty parts without authority. Fence them
 * under the same write lock used to establish emptiness, before reopening source.
 * Unknown schemas, unowned data and any writable target remain fail-closed. */
export function quarantinePreparation(path: string, authority: AuthorityRow, sourceVersion: number): void {
  const directory=dirname(path);safePath(directory);
  if (!existsSync(directory)) newDirectory(directory);
  else if (!lstatSync(directory).isDirectory()) fail("incomplete_transfer","Target directory is unavailable; the source remains fenced.");
  const parts:[AuthorityKind,string][]=[["main",""],["recovery",".recovery.sqlite"],["events",".events.sqlite"]];
  for (const [kind,suffix] of parts) {
    const file=path+suffix;safePath(file);let created=false;
    if (!existsSync(file)) {writeNew(file,"");created=true;}
    closeSync(fileDescriptor(file));
    const db=new DatabaseSync(file);
    try {
      if (created) {
        if (kind==="events") db.exec(lifecycleSchemaSql+taskLinkSchema);
        else initialize(db,kind==="recovery",sourceVersion);
      }
      db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
      if (kind==="events") validateEventStore(db);else validateDatabase(db,kind==="recovery");
      const owners=hasAuthority(db)?db.prepare("SELECT * FROM project_authority LIMIT 2").all():[];
      if (owners.length) {
        const existing=authorityRow.parse(owners[0]);
        if (owners.length!==1 || (["project_id","project_key","transfer_id","generation","role","state"] as const)
          .some(key=>existing[key]!==authority[key]))
          fail("authority_conflict","Incomplete target has different or writable authority; nothing was reopened.");
      } else {
        const names=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>String(row["name"])));
        const data=kind==="main"?tables.filter(t=>t!=="requests"):kind==="recovery"?["requests"]:eventTables;
        if (data.some(table=>names.has(table) && db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()))
          fail("incomplete_transfer","Unowned target data requires inspection; the source remains fenced.");
      }
      if (kind==="events") db.exec(taskLinkSchema);
      putAuthority(db,kind,authority);db.exec("COMMIT");
    } finally {if(db.isTransaction)db.exec("ROLLBACK");db.close();}
  }
}
