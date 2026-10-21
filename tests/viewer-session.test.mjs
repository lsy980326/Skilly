import test from "node:test";
import assert from "node:assert/strict";
import { createViewerSession } from "../ui/session.js";

const key = "skilly.viewer.connection.v1", ttl = 7 * 24 * 60 * 60 * 1000;
const firstToken = "a".repeat(64), secondToken = "b".repeat(64);
function fixture() {
  const entries = new Map();
  let time = 1000, writes = 0;
  const storage = {
    getItem: name => entries.get(name) ?? null,
    setItem(name, value) { entries.set(name, value); writes++; },
    removeItem: name => entries.delete(name),
  };
  const start = (token, getStorage = () => storage) => {
    const history = [];
    const session = createViewerSession({
      location: { hash: token === undefined ? "" : `#token=${token}`, pathname: "/" },
      history: { replaceState: (...args) => history.push(args) }, getStorage, now: () => time,
    });
    assert.deepEqual(history, [[null, "", "/"]]);
    return session;
  };
  return { entries, storage, start, writes: () => writes, advance: ms => { time += ms; } };
}

test("only a successful server response persists a connection; a new page restores it", () => {
  const f = fixture(), first = f.start(firstToken);
  assert.deepEqual(first.headers(), { Authorization: `Bearer ${firstToken}` });
  assert.equal(f.entries.size, 0);
  first.confirm(); first.confirm();
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.start().headers(), first.headers());
  assert.deepEqual(JSON.parse(f.entries.get(key)), { version: 1, token: firstToken, expiresAt: 1000 + ttl });
});

test("a bad link never falls back to or overwrites a stored connection", () => {
  const f = fixture(); f.start(firstToken).confirm();
  const before = f.entries.get(key);
  const malformed = f.start("invalid");
  assert.throws(() => malformed.headers(), /연결 주소/);
  malformed.confirm();
  const wrongServer = f.start(secondToken);
  wrongServer.reject();
  assert.throws(() => wrongServer.headers(), /연결 주소/);
  assert.equal(f.entries.get(key), before);
  assert.deepEqual(f.start().headers(), { Authorization: `Bearer ${firstToken}` });
});

test("401 invalidates the rejected connection but preserves another tab's newer value", () => {
  const f = fixture();
  const old = f.start(firstToken); old.confirm();
  f.start(secondToken).confirm();
  old.reject();
  assert.equal(JSON.parse(f.entries.get(key)).token, secondToken);
  const current = f.start(); current.reject();
  assert.equal(f.entries.has(key), false);
  assert.throws(() => current.headers(), /연결 주소/);
});

test("a delayed old success cannot replace a newer tab's verified connection", () => {
  const f = fixture(), delayed = f.start(firstToken);
  f.start(secondToken).confirm();
  delayed.confirm();
  assert.equal(JSON.parse(f.entries.get(key)).token, secondToken);
  const restored = f.start(); restored.confirm();
  assert.equal(f.writes(), 1);
  assert.deepEqual(restored.headers(), { Authorization: `Bearer ${secondToken}` });
});

test("an old tab rejecting its token cannot prevent a valid new link from being saved", () => {
  const f = fixture(), old = f.start(firstToken); old.confirm();
  const fresh = f.start(secondToken);
  old.reject();
  fresh.confirm();
  assert.deepEqual(f.start().headers(), { Authorization: `Bearer ${secondToken}` });
  assert.equal(fresh.persistenceLimited, false);
});

test("expired, malformed and unsupported stored entries never become authorization headers", () => {
  const f = fixture();
  for (const raw of ["{", "null", "x".repeat(1025), JSON.stringify({ version: 2, token: firstToken, expiresAt: 2000 }),
    JSON.stringify({ version: 1, token: firstToken, expiresAt: 1000 }),
    JSON.stringify({ version: 1, token: firstToken, expiresAt: 1001 + ttl }),
    JSON.stringify({ version: 1, token: "bad", expiresAt: 2000 })]) {
    f.entries.set(key, raw);
    f.entries.set("unrelated", "preserve");
    assert.throws(() => f.start().headers(), /연결 주소/);
    assert.equal(f.entries.has(key), false);
    assert.equal(f.entries.get("unrelated"), "preserve");
  }
  const current = f.start(firstToken); current.confirm();
  f.advance(ttl);
  assert.throws(() => current.headers(), /연결 주소/);
  assert.equal(f.entries.has(key), false);
});

test("blocked storage keeps the current authorized tab usable and exposes the persistence limit", () => {
  const f = fixture();
  const blocked = () => { throw new Error("blocked"); };
  const session = f.start(firstToken, blocked);
  session.confirm(); session.confirm();
  assert.deepEqual(session.headers(), { Authorization: `Bearer ${firstToken}` });
  assert.equal(session.persistenceLimited, true);
  assert.throws(() => f.start(undefined, blocked).headers(), /연결 주소/);
  const full = f.start(firstToken, () => ({ ...f.storage, setItem() { throw new Error("quota"); } }));
  full.confirm();
  assert.equal(full.persistenceLimited, true);
  assert.deepEqual(full.headers(), { Authorization: `Bearer ${firstToken}` });
});
