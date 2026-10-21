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

async function viewer({ structured = false, manyFeatures = false, lateFeatureKey = "feature-41", active = false, partial = false, failSecondProject = false, historyPage = false, initialEmpty = false } = {}) {
  const initial = Date.parse("2026-10-21T01:00:00Z");
  let now = initial, scheduled, calls = 0;
  let recordAvailable = !initialEmpty;
  const requests = [];
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
    id: "run", goal: "시간 표시 회귀 테스트", actor: "Codex", mode: "change", state: active ? "active" : "completed",
    activity: "completed", repository: "main", environment: "test",
    created_at: new Date(initial).toISOString(), updated_at: new Date(initial).toISOString(),
    title: "시간 표시", components: [{ key: "web", name: "Web" }], features: [{ key: "clock", name: "상대 시간" }],
  };
  const record = { id: "record", kind: "summary", topic: "task-summary", body: "변경 없는 기록",
    report_origin: "contemporaneous", observed_at: run.updated_at, recorded_at: run.updated_at,
    report: structured ? { title: "목록과 상세 시간 수정", summary: "<img src=x onerror=alert(1)>", changes: ["같은 시계 사용"], checks: [{ name: "시간 검사", result: "passed" }], next_steps: ["실제 화면 확인"] } : null };
  const board = readFileSync(new URL("../ui/workstream.js", import.meta.url), "utf8").replace("export function", "function");
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8").replace(/^import .*;\n/, "");
  await runInNewContext(`(async () => {${board}\n${app}\n})()`, {
    document, URLSearchParams, location: { hash: "#token=test", pathname: "/" }, history: { replaceState() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback) { scheduled = callback; return 1; }, clearTimeout() {},
    matchMedia() { return { matches: false }; },
    async fetch(path) {
      calls++; requests.push(path);
      if (failSecondProject && path.includes("project=other") && path.startsWith("/api/overview")) throw new Error("조회 실패");
      const data = path.startsWith("/api/projects")
        ? { items: [{ id: "project", key: "test", name: "Test", total: 1, unfinished: 0 }, ...(failSecondProject ? [{ id: "other", key: "other", name: "Other", total: 0, unfinished: 0 }] : [])], next_offset: null }
        : path.startsWith("/api/overview") ? { summary: { total: 1, unfinished: 0, unclassified: 0 },
          items: path.includes("view=components") ? [{ key: "web", name: "Web", total: 1, unfinished: 0 }]
            : manyFeatures ? (path.includes("offset=40") ? [{ key: lateFeatureKey, name: "마지막 기능", total: 1, unfinished: 0 }]
              : Array.from({ length: 40 }, (_, n) => ({ key: `feature-${n}`, name: `기능 ${n}`, total: 1, unfinished: 0 })))
            : [{ key: "clock", name: "상대 시간", total: 1, unfinished: 0 }],
          next_offset: manyFeatures && path.includes("view=features") && !path.includes("offset=40") ? 40 : null }
        : path.includes("state=active") ? { items: active ? [run] : [], next_offset: partial ? 20 : null }
        : path.startsWith("/api/runs/run?")
          ? { run, record_counts: { summary: recordAvailable ? 1 : 0 }, records: { items: recordAvailable ? [path.includes("before=") ? { ...record, id: "older", body: "이전 기록" } : record] : [], next_before: historyPage && !path.includes("before=") ? 99 : null } }
          : { items: [run], next_offset: null };
      return { ok: true, async json() { return structuredClone(data); } };
    },
  });
  return {
    node, document, calls: () => calls, requests,
    advance(ms) { now += ms; },
    saveRecord(id) { record.id = id; recordAvailable = true; },
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
  const record = content.querySelector(".record");
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

test("structured report is readable, original is folded, and component filter reaches the API", async () => {
  const app = await viewer({ structured: true });
  assert.match(app.node("#detail").textContent, /핵심 변화/);
  assert.match(app.node("#detail").textContent, /확인 결과 · AI 보고/);
  assert.match(app.node("#detail").textContent, /다음 작업/);
  assert.match(app.node("#detail").textContent, /<img src=x onerror=alert\(1\)>/);
  const raw = app.node("#detail").querySelector(".raw-report");
  assert.equal(raw.open, false);
  raw.open = true;
  await app.tick();
  assert.equal(app.node("#detail").querySelector(".raw-report"), raw);
  assert.equal(raw.open, true);
  app.node("#component-filter").listeners.change({ target: { value: "web" } });
  await new Promise(setImmediate);
  assert.ok(app.requests.some(path => path.includes("component=web")));
});

test("a selected feature from a later catalog page remains visible after polling", async () => {
  for (const lateFeatureKey of ["feature-41", "unclassified"]) {
  const app = await viewer({ manyFeatures: true, lateFeatureKey });
  app.node("#show-features").listeners.click(); await new Promise(setImmediate);
  await app.node("#more-tasks").listeners.click();
  const feature = app.node("#tasks").children.find(node => node.textContent.includes("마지막 기능"));
  await feature.children.find(node => node.tagName === "BUTTON").listeners.click();
  await app.tick();
  assert.equal(app.node("#feature-filter").value, lateFeatureKey);
  assert.equal(app.node("#feature-filter").children.find(node => node.value === lateFeatureKey).textContent, "마지막 기능");
  assert.ok(app.requests.some(path => path.includes(`feature=${lateFeatureKey}`)));
  }
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

test("workstream shows saved unfinished work and opens its original detail", async () => {
  const app = await viewer({ active: true, structured: true });
  const board = app.node("#components");
  assert.match(board.textContent, /미완료 기록/);
  assert.match(board.textContent, /Codex · 상대 시간/);
  await board.querySelector(".lane-task").listeners.click();
  await new Promise(setImmediate);
  assert.match(app.node("#detail").textContent, /시간 표시/);
  assert.ok(app.requests.some(path => path.startsWith("/api/runs/run?")));
});

test("workstream discloses paging and timeline separates stored reports from start receipt", async () => {
  const app = await viewer({ partial: true, active: true });
  assert.match(app.node("#workstream-note").textContent, /최근 미완료 작업 1개 표시/);
  assert.doesNotMatch(app.node("#components").textContent, /저장된 미완료 작업 없음/);
  const entry = app.node("#detail").querySelector(".timeline-entry");
  assert.match(entry.textContent, /당시 기록/);
  assert.match(entry.textContent, /미검증/);
  assert.match(app.node("#detail").querySelector(".timeline-start").textContent, /시작 영수증/);
  const original = entry;
  await app.tick();
  assert.equal(app.node("#detail").querySelector(".timeline-entry"), original);
});

test("switching service clears prior workstream even when the next catalog fails", async () => {
  const app = await viewer({ active: true, failSecondProject: true });
  assert.match(app.node("#components").textContent, /Codex/);
  app.node("#projects").children[1].listeners.click();
  assert.equal(app.node("#components").querySelector(".lane-task"), null);
  assert.equal(app.node("#service-summary").textContent, "");
  await new Promise(setImmediate);
  assert.equal(app.node("#project-name").textContent, "Other");
  assert.doesNotMatch(app.node("#components").textContent, /Codex|Web/);
  assert.match(app.node("#connection-error").textContent, /조회 실패/);
});

test("new report animates once while older history pages never signal a new save", async () => {
  const app = await viewer();
  assert.doesNotMatch(app.node("#detail").querySelector(".timeline-entry").className, /newly-saved/);
  app.saveRecord("newly-persisted");
  await app.tick();
  assert.match(app.node("#detail").querySelector(".timeline-entry").className, /newly-saved/);
  const unchanged = app.node("#detail").querySelector(".timeline-entry");
  await app.tick();
  assert.equal(app.node("#detail").querySelector(".timeline-entry"), unchanged);

  const history = await viewer({ historyPage: true });
  const more = history.node("#detail").querySelectorAll("button").find(button => button.textContent === "이전 기록 더 보기");
  await more.listeners.click();
  assert.equal(history.node("#detail").querySelectorAll(".timeline-entry").length, 2);
  assert.ok(history.node("#detail").querySelectorAll(".timeline-entry").every(entry => !entry.className.includes("newly-saved")));

  const firstReport = await viewer({ initialEmpty: true });
  assert.equal(firstReport.node("#detail").querySelector(".timeline-entry"), null);
  firstReport.saveRecord("first-change"); await firstReport.tick();
  assert.match(firstReport.node("#detail").querySelector(".timeline-entry").className, /newly-saved/);
});
