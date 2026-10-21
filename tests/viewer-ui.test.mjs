import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Only the DOM surface used by the viewer; run the actual app and polling callback.
class Element {
  children = [];
  dataset = {};
  className = "";
  listeners = {};
  classList = {
    add: () => {}, remove: () => {}, toggle: () => {},
  };
  constructor(tagName) { this.tagName = tagName.toUpperCase(); }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1))
      : selector === "[data-relative-time]" ? node.dataset.relativeTime !== undefined
      : node.tagName === selector.toUpperCase();
    return this.children.filter(child => child instanceof Element)
      .flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

async function viewer() {
  const initial = Date.parse("2026-10-21T01:00:00Z");
  let now = initial, scheduled, calls = 0;
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element("div"));
    return nodes.get(selector);
  };
  const document = {
    hidden: false, activeElement: null, listeners: {},
    createElement: tag => new Element(tag), createTextNode: text => String(text),
    querySelector: node,
    querySelectorAll: selector => [...nodes.values()].flatMap(root => root.querySelectorAll(selector)),
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
  const run = {
    id: "run", goal: "시간 표시 회귀 테스트", actor: "Codex", mode: "change", state: "completed",
    activity: "completed", repository: "main", environment: "test",
    created_at: new Date(initial).toISOString(), updated_at: new Date(initial).toISOString(),
  };
  const record = { id: "record", kind: "summary", topic: "task-summary", body: "변경 없는 기록",
    report_origin: "contemporaneous", observed_at: run.updated_at, recorded_at: run.updated_at };
  await runInNewContext(`(async () => {${readFileSync(new URL("../ui/app.js", import.meta.url), "utf8")}\n})()`, {
    document, URLSearchParams, location: { hash: "#token=test", pathname: "/" }, history: { replaceState() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback) { scheduled = callback; return 1; }, clearTimeout() {},
    async fetch(path) {
      calls++;
      const data = path.startsWith("/api/projects")
        ? { items: [{ id: "project", key: "test", name: "Test", total: 1, unfinished: 0 }], next_offset: null }
        : path.startsWith("/api/runs/run?")
          ? { run, record_counts: { summary: 1 }, records: { items: [record], next_before: null } }
          : { items: [run], next_offset: null };
      return { ok: true, async json() { return structuredClone(data); } };
    },
  });
  return {
    node, document, calls: () => calls,
    advance(ms) { now += ms; },
    async tick() { await scheduled(); },
    labels() {
      return [node("#tasks").querySelector(".card-time").textContent,
        node("#detail").querySelector(".metadata").children[1].querySelector("small").textContent];
    },
  };
}

test("unchanged reports keep list and detail time in sync without rebuilding detail", async () => {
  const app = await viewer();
  assert.deepEqual(app.labels(), ["방금 기록", "방금 기록"]);
  const content = app.node("#detail").children[0];
  const record = content.querySelector("details");
  record.open = false;
  app.node(".detail-panel").scrollTop = 120;
  app.advance(60_000);
  await app.tick();
  assert.deepEqual(app.labels(), ["1분 전", "1분 전"]);
  assert.equal(app.node("#detail").children[0], content);
  assert.equal(record.open, false);
  assert.equal(app.node(".detail-panel").scrollTop, 120);
  app.advance(59 * 60_000);
  await app.tick();
  assert.deepEqual(app.labels(), ["1시간 전", "1시간 전"]);
});

test("search focus pauses fetching but not elapsed time; returning to the tab refreshes both labels", async () => {
  const app = await viewer();
  const calls = app.calls();
  app.document.activeElement = app.node("#search");
  app.advance(120_000);
  await app.tick();
  assert.deepEqual(app.labels(), ["2분 전", "2분 전"]);
  assert.equal(app.calls(), calls);
  app.document.hidden = true;
  app.document.listeners.visibilitychange();
  app.advance(60_000);
  app.document.hidden = false;
  app.document.listeners.visibilitychange();
  assert.deepEqual(app.labels(), ["3분 전", "3분 전"]);
  assert.equal(app.calls(), calls);
});
