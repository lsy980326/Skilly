import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { hasAuthority, readAuthority } from "../sqlite/project-authority.js";
import { readDatabase } from "./database.js";
import { readEvents } from "./events.js";

/** Compare only this project's authority, not records or other projects' activity.
 * Absent parts and empty authority are equivalent before provisioning. */
export function sourceAuthority(path: string, projectId: string) {
  let writable=true,generation=0;
  const rows=["main","recovery","events"].map(kind=>{
    const file=path+(kind==="main"?"":`.${kind}.sqlite`);
    if(!existsSync(file))return null;
    const db=kind==="events"?readEvents(file):readDatabase(file,kind==="recovery");
    try {
      writable=writable && readAuthority(db,projectId)["write_allowed"]===true;
      const row=hasAuthority(db)?db.prepare("SELECT * FROM project_authority WHERE project_id=?").get(projectId)??null:null;
      generation=Math.max(generation,Number(row?.["generation"]??0));return row;
    } finally {db.close();}
  });
  return {writable,generation,sha256:createHash("sha256").update(JSON.stringify(rows)).digest("hex")};
}
