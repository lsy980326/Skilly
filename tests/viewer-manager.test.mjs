import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, rmSync, lstatSync, existsSync, writeFileSync, renameSync, symlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openLocal } from "../dist/runtime/local/app.js";
import { manageViewer } from "../dist/runtime/local/viewer-manager.js";
import { controlPaths, control } from "../dist/runtime/local/viewer-control.js";

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, "bounded wait expired"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "skilly-viewer-manager-")), db = join(dir, "test.sqlite");
  const app = openLocal(db);
  await app.dispatcher.call("memory_register_project", { key: "manager-test", name: "테스트", idempotency_key: "project" });
  await app.close();
  const paths = controlPaths(db);
  t.after(async () => {
    if (existsSync(paths.socket)) {
      try { await control(paths.db, paths.socket, "stop"); await waitFor(() => !existsSync(paths.socket)); } catch { /* Failure remains visible in the test assertions. */ }
    }
    rmSync(dir, { recursive: true, force: true });
    try { rmdirSync(paths.directory); } catch { /* A failed start may leave its own stale socket for diagnosis. */ }
  });
  return { dir, db, paths };
}
const headers = result => ({ Authorization: `Bearer ${new URLSearchParams(new URL(result.url).hash.slice(1)).get("token")}` });

test("managed viewer starts once, reports health, reloads with the same authorization and never modifies DB", async t => {
  const f = await fixture(t), before = readFileSync(f.db);
  assert.equal((await manageViewer("status", f.db, 0)).status, "stopped");
  const started = await manageViewer("start", f.db, 0);
  assert.equal(started.status, "running");
  assert.equal(lstatSync(f.paths.socket).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.paths.directory).mode & 0o777, 0o700);
  assert.equal((await fetch(`${started.origin}/api/projects`)).status, 401);
  assert.equal((await fetch(`${started.origin}/api/projects`, { headers: headers(started) })).status, 200);
  assert.equal((await fetch(`${started.origin}/api/projects`, { headers: { ...headers(started), Origin: "http://example.com" } })).status, 403);
  assert.equal((await fetch(`${started.origin}/api/projects`, { method: "POST", headers: headers(started) })).status, 405);
  const again = await manageViewer("start", f.db, 50916);
  assert.equal(again.pid, started.pid); assert.equal(again.url, started.url);
  const status = await manageViewer("status", f.db, 0);
  assert.equal(status.status, "running"); assert.equal("url" in status, false);
  const restarted = await manageViewer("restart", f.db, 0);
  assert.equal(restarted.restart_mode, "reload_in_place");
  assert.equal(restarted.pid, started.pid); assert.equal(restarted.url, started.url);
  assert.equal((await fetch(`${started.origin}/api/projects`, { headers: headers(started) })).status, 200);
  await manageViewer("stop", f.db, 0); await waitFor(() => !existsSync(f.paths.socket));
  assert.equal((await manageViewer("status", f.db, 0)).status, "stopped");
  assert.deepEqual(readFileSync(f.db), before);
});

test("failed reload leaves the existing authorized reader usable", async t => {
  const f = await fixture(t), started = await manageViewer("start", f.db, 0);
  renameSync(f.db, `${f.db}.original`); writeFileSync(f.db, "not sqlite");
  try {
    await assert.rejects(manageViewer("restart", f.db, 0));
    assert.equal((await fetch(`${started.origin}/api/projects`, { headers: headers(started) })).status, 200);
    rmSync(f.db);
    const invalid = new DatabaseSync(f.db);
    invalid.exec("PRAGMA application_id=1397446988; PRAGMA user_version=5;"); invalid.close();
    await assert.rejects(manageViewer("restart", f.db, 0));
    assert.equal((await fetch(`${started.origin}/api/projects`, { headers: headers(started) })).status, 200);
  } finally { rmSync(f.db); renameSync(`${f.db}.original`, f.db); }
});

test("missing DB is degraded rather than stopped and its managed worker can still be stopped", async t => {
  const f = await fixture(t), started = await manageViewer("start", f.db, 0);
  renameSync(f.db, `${f.db}.original`);
  try {
    const status = await manageViewer("status", f.db, 0);
    assert.equal(status.status, "degraded"); assert.equal(status.pid, started.pid);
    assert.equal((await manageViewer("stop", f.db, 0)).status, "stopped");
    await waitFor(() => !existsSync(f.paths.socket));
  } finally { renameSync(`${f.db}.original`, f.db); }
});

test("occupied ports and foreign socket paths are preserved instead of killing their owner", async t => {
  const f = await fixture(t);
  const other = createServer((_request, response) => response.end("unmanaged"));
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const port = other.address().port;
  await assert.rejects(manageViewer("start", f.db, port));
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "unmanaged");
  await waitFor(() => !existsSync(f.paths.socket));
  symlinkSync(f.db, f.paths.socket);
  await assert.rejects(manageViewer("start", f.db, 0), /信頼|신뢰/);
  assert.equal(lstatSync(f.paths.socket).isSymbolicLink(), true);
  rmSync(f.paths.socket);
});

test("concurrent starts cannot create two managed listeners", async t => {
  const f = await fixture(t);
  const replies = await Promise.allSettled([manageViewer("start", f.db, 0), manageViewer("start", f.db, 0)]);
  const saved = replies.filter(reply => reply.status === "fulfilled").map(reply => reply.value);
  assert.ok(saved.length >= 1);
  assert.equal(new Set(saved.map(reply => reply.pid)).size, 1);
  assert.equal((await manageViewer("status", f.db, 0)).pid, saved[0].pid);
  await assert.rejects(control(f.paths.db + ".other", f.paths.socket, "restart"));
});

test("a crashed test worker is reported unresponsive and start recovers only its stale socket", async t => {
  const f = await fixture(t), started = await manageViewer("start", f.db, 0);
  process.kill(started.pid, "SIGKILL");
  let status;
  const deadline = Date.now() + 3000;
  do {
    await new Promise(resolve => setTimeout(resolve, 10));
    status = await manageViewer("status", f.db, 0);
  } while (status.status === "running" && Date.now() < deadline);
  assert.equal(status.status, "unresponsive");
  const recovered = await manageViewer("start", f.db, Number(new URL(started.origin).port));
  assert.notEqual(recovered.pid, started.pid);
  assert.equal(recovered.origin, started.origin);
  assert.notEqual(recovered.url, started.url, "Credentials are intentionally memory-only and rotate after a process crash.");
  assert.equal((await fetch(`${recovered.origin}/api/projects`, { headers: headers(started) })).status, 401);
  assert.equal((await fetch(`${recovered.origin}/api/projects`, { headers: headers(recovered) })).status, 200);
});

test("code restart replaces the worker while preserving origin, authorization, records and reload support", async t => {
  const f=await fixture(t), before=readFileSync(f.db), started=await manageViewer('start',f.db,0);
  const restarted=await manageViewer('restart-code',f.db,0);
  assert.equal(restarted.restart_mode,'process_replaced');assert.notEqual(restarted.pid,started.pid);
  assert.equal(restarted.origin,started.origin);assert.equal(restarted.url,started.url);
  assert.equal((await fetch(started.origin+'/api/projects',{headers:headers(started)})).status,200);
  assert.equal((await fetch(started.origin+'/api/projects')).status,401);
  assert.equal((await fetch(started.origin+'/api/projects',{headers:{...headers(started),Origin:'https://example.com'}})).status,403);
  assert.equal((await manageViewer('restart',f.db,0)).pid,restarted.pid);
  assert.deepEqual(readFileSync(f.db),before);
});

test("code restart preflight failure preserves the existing authenticated process", async t => {
  const f=await fixture(t), started=await manageViewer('start',f.db,0);
  renameSync(f.db,f.db+'.original');writeFileSync(f.db,'not sqlite');
  try {
    await assert.rejects(manageViewer('restart-code',f.db,0));
    assert.equal((await fetch(started.origin+'/api/projects',{headers:headers(started)})).status,200);
    assert.equal((await control(f.paths.db,f.paths.socket,'connect')).pid,started.pid);
  } finally { rmSync(f.db);renameSync(f.db+'.original',f.db); }
});

test('degraded reader is replaced only after the current database passes preflight, preserving authorization',async t=>{
 const f=await fixture(t),initial=new DatabaseSync(f.db);initial.exec('PRAGMA journal_mode=DELETE');initial.close();
 const before=readFileSync(f.db),started=await manageViewer('start',f.db,0);
 const unsupported=new DatabaseSync(f.db);unsupported.exec('PRAGMA user_version=18');unsupported.close();
 assert.equal((await manageViewer('status',f.db,0)).status,'degraded');
 await assert.rejects(manageViewer('restart-code',f.db,0));
 assert.equal((await control(f.paths.db,f.paths.socket,'connect')).pid,started.pid,'failed probe must retain the degraded process');
 // The running reader keeps its old inode; current code probes a separately valid file.
 renameSync(f.db,f.db+'.unsupported');writeFileSync(f.db,before,{mode:0o600});
 assert.equal((await manageViewer('status',f.db,0)).status,'degraded');
 const restarted=await manageViewer('restart-code',f.db,0);
 assert.notEqual(restarted.pid,started.pid);assert.equal(restarted.url,started.url);
 assert.equal((await fetch(started.origin+'/api/projects',{headers:headers(started)})).status,200);
 assert.equal((await fetch(started.origin+'/api/projects')).status,401);
});


test("explicit comparison roots survive code restart and invalid roots preserve the authorized worker",async t=>{
  const f=await fixture(t),root=realpathSync(f.dir);
  writeFileSync(join(root,'skilly.project.json'),JSON.stringify({version:1,key:'manager-test',name:'test',repository:'default',environment:'development'}));
  const started=await manageViewer('start',f.db,0,[root]);
  assert.deepEqual(started.sourceProjects,[root]);
  const restarted=await manageViewer('restart-code',f.db,0);
  assert.deepEqual(restarted.sourceProjects,[root]);assert.equal(restarted.url,started.url);
  await assert.rejects(manageViewer('restart-code',f.db,0,['/missing/skilly-test-root']));
  assert.equal((await manageViewer('status',f.db,0)).pid,restarted.pid);
  assert.equal((await fetch(started.origin+'/api/projects',{headers:headers(started)})).status,200);
});
