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

async function viewer({ structured = false, manyFeatures = false, lateFeatureKey = "feature-41", active = false, partial = false, failSecondProject = false, historyPage = false, initialEmpty = false,
  hash = `#token=${"a".repeat(64)}`, storage = new Map(), httpStatus = 200, requestFailure = "", reducedMotion = false, extraActiveTasks = 0,
  recovery = { status: "available", items: [], next_offset: null }, featureDetail = null, executions = { items: [], next_offset: null }, holdScopedRuns = false, holdMoreFeatures = false } = {}) {
  const initial = Date.parse("2026-10-21T01:00:00Z");
  let now = initial, scheduled, calls = 0, hangNext = false;
  const deadlines = new Set();
  let recordAvailable = !initialEmpty;
  const requests = [], authorizations = [];
  let releaseScoped, releaseMore;
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
    branch: "test/board", latest_report: structured ? { summary: "저장된 작업 요약 <img src=x>" } : null,
  };
  const record = { id: "record", kind: "summary", topic: "task-summary", body: "변경 없는 기록",
    report_origin: "contemporaneous", observed_at: run.updated_at, recorded_at: run.updated_at,
    report: structured ? { title: "목록과 상세 시간 수정", summary: "<img src=x onerror=alert(1)>", changes: ["같은 시계 사용"], checks: [{ name: "시간 검사", result: "passed" }], next_steps: ["실제 화면 확인"], technical: { files: ["ui/app.js"], symbols: ["<script>bad()</script>"], commands: ["node --test tests/viewer-ui.test.mjs"] } } : null };
  const sampleSkill = { project_id: "project", skill_key: "sample", name: "샘플 스킬", version: "2.0", source: "local:sample", description: "보관 원문", content_hash: "a".repeat(64), files: [], body: "<img src=x onerror=alert(1)>", install_instructions: "설치 안내" };
  const board = readFileSync(new URL("../ui/workstream.js", import.meta.url), "utf8").replace("export function", "function");
  const session = readFileSync(new URL("../ui/session.js", import.meta.url), "utf8").replace("export function", "function");
  const skills = readFileSync(new URL("../ui/skills.js", import.meta.url), "utf8").replaceAll("export function", "function");
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  const reports = readFileSync(new URL("../ui/reports.js", import.meta.url), "utf8").replaceAll("export function", "function");
  const featureUI = readFileSync(new URL("../ui/features.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export function", "function");
  const documents = readFileSync(new URL("../ui/document-batch.js", import.meta.url), "utf8").replaceAll("export function", "function") + '\n' + readFileSync(new URL("../ui/documents.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export function", "function");
  await runInNewContext(`(async () => {${board}\n${session}\n${skills}\n${reports}\n${featureUI}\n${documents}\n${app}\n})()`, {
    document, URLSearchParams, AbortController, location: { hash, pathname: "/" }, history: { replaceState() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { if (delay === 15000) scheduled = callback; else if (delay === 10000) deadlines.add(callback); return callback; }, clearTimeout(callback) { deadlines.delete(callback); },
    matchMedia() { return { matches: reducedMotion }; },
    async fetch(path, options) {
      calls++; requests.push(path);
      if (hangNext) { hangNext = false; await new Promise(() => {}); }
      authorizations.push(options.headers.Authorization);
      assert.equal(options.credentials, "omit");
      if (requestFailure === "network") throw new Error("연결 실패");
      if (holdScopedRuns && path.startsWith("/api/runs?") && path.includes("feature=")) {
        holdScopedRuns = false; await new Promise(resolve => { releaseScoped = resolve; });
      }
      if (holdMoreFeatures && path.startsWith("/api/overview?") && path.includes("view=features") && path.includes("offset=40")) {
        holdMoreFeatures = false; await new Promise(resolve => { releaseMore = resolve; });
      }
      if (failSecondProject && path.includes("project=other") && path.startsWith("/api/overview")) throw new Error("조회 실패");
      const data = path.startsWith("/api/projects")
        ? { items: [{ id: "project", key: "test", name: "Test", total: 1, unfinished: 0 }, ...(failSecondProject ? [{ id: "other", key: "other", name: "Other", total: 0, unfinished: 0 }] : [])], next_offset: null }
        : path.startsWith("/api/recovery?") ? recovery
        : path.startsWith("/api/skills?") ? { items: [{ skill_key: "sample", name: "샘플 스킬", versions: 2, installations: [{ repository: "web", version: "1.0", state: "modified" }], installations_total: 1 }], next_offset: null }
        : path.startsWith("/api/skill?") ? { skill: { ...sampleSkill, ...(path.includes("version=1.0") ? { version: "1.0", body: "이전 버전 전문" } : {}) }, versions: [{ version: "2.0" }, { version: "1.0" }], installations: [], installation_offset: 0, next_installation_offset: null }
        : path.startsWith("/api/overview") ? { summary: { total: 1, unfinished: 0, unclassified: 0 },
          items: path.includes("view=components") ? [{ key: "web", name: "Web", total: 1, unfinished: 0 }]
            : manyFeatures ? (path.includes("offset=40") ? [{ key: lateFeatureKey, name: "마지막 기능", total: 1, unfinished: 0 }]
              : Array.from({ length: 40 }, (_, n) => ({ key: `feature-${n}`, name: `기능 ${n}`, total: 1, unfinished: 0 })))
            : [{ key: "clock", name: "상대 시간", total: 1, unfinished: 0, ...featureDetail }],
          next_offset: manyFeatures && path.includes("view=features") && !path.includes("offset=40") ? 40 : null }
        : path.includes("state=active") ? { items: active ? [run, ...Array.from({ length: extraActiveTasks }, (_, n) => ({ ...run, id: `run-extra${n + 1}`, title: `추가 작업 ${n + 1}` }))] : [], next_offset: partial ? 20 : null }
        : path.startsWith("/api/runs/run")
          ? { run: path.includes("run-extra") ? { ...run, id: "run-extra1", title: "추가 작업 1" } : run, executions, record_counts: { summary: recordAvailable ? 1 : 0 }, records: { items: recordAvailable ? [path.includes("before=") ? { ...record, id: "older", body: "이전 기록" } : record] : [], next_before: historyPage && !path.includes("before=") ? 99 : null } }
          : { items: [run], next_offset: null };
      return { ok: httpStatus === 200, status: httpStatus, async json() {
        if (requestFailure === "json") throw new SyntaxError("잘못된 응답");
        return structuredClone(data);
      } };
    },
  });
  return {
    node, document, calls: () => calls, requests, authorizations,
    hangNext() { hangNext = true; },
    async expireRequests() { for (const callback of [...deadlines]) callback(); await new Promise(setImmediate); },
    advance(ms) { now += ms; },
    saveRecord(id) { record.id = id; recordAvailable = true; },
    updateTask(patch) { Object.assign(run, patch); },
    updateFeature(patch) { Object.assign(featureDetail, patch); },
    releaseScoped() { releaseScoped?.(); },
    releaseMore() { releaseMore?.(); },
    async tick() { await scheduled(); },
    labels() {
      return [node("#tasks").querySelector(".card-time").textContent,
        node("#detail").querySelector(".metadata").children[1].querySelector("small").textContent];
    },
  };
}

test("a new UI page without a token link restores the authorized connection", async () => {
  const storage = new Map();
  await viewer({ storage });
  const reopened = await viewer({ storage, hash: "" });
  assert.ok(reopened.calls() > 0);
  assert.ok(reopened.authorizations.every(value => value === `Bearer ${"a".repeat(64)}`));
  assert.match(reopened.node("#detail").textContent, /시간 표시/);
  assert.equal(reopened.node("#connection-error").hidden, true);
});

test("process observations and AI reports stay separate and a newly collected result refreshes detail", async () => {
  const executions = { items: [], next_offset: null };
  const app = await viewer({ structured: true, executions });
  assert.match(app.node("#detail").textContent, /수집된 실행 결과 없음/);
  assert.match(app.node("#detail").querySelector(".validation-evidence").textContent, /AI 보고만 있음/);
  executions.items.push({ id: "execution", executable: "<img src=x>", started_at: "2026-10-21T01:00:00Z", duration_ms: 150,
    outcome: "exited", exit_code: 0, stdout_bytes: 14, stderr_bytes: 0, record_id: "record" });
  await app.tick();
  const section = app.node("#detail").querySelector(".execution-observations");
  assert.match(section.textContent, /직접 실행 관측.*정상 종료 · 코드 0/);
  assert.match(app.node("#detail").querySelector(".validation-evidence").textContent, /직접 실행 관측 있음/);
  assert.match(section.textContent, /종료 코드 0은 기능 검증 완료를 뜻하지 않습니다/);
  assert.equal(section.querySelector("img"), null);
  assert.match(app.node("#detail").textContent, /확인 결과 · AI 보고.*통과 보고/);
  executions.items[0].outcome = "unconfirmed"; executions.items[0].duration_ms = null;
  await app.tick(); assert.match(app.node("#detail").textContent, /종료 관측 없음/);
  assert.match(app.node("#detail").querySelector(".validation-evidence").textContent, /확인 불가/);
});

test("recovery UI separates saved, pending and blocked requests and never calls an empty list complete", async () => {
  const rows = [
    { state: "saved", delivery_status: "saved", original_input_retained: true },
    { state: "retry_required", delivery_status: "recovery_pending", original_input_retained: true },
    { state: "conflict", delivery_status: "recovery_blocked", original_input_retained: true },
    { state: "rejected", delivery_status: "not_retained", original_input_retained: false },
  ].map((row, n) => ({ ...row, request_id: `request-${n}`, goal: "<img src=x>", received_at: "2026-10-21T01:00:00Z", environment: "test" }));
  const app = await viewer({ recovery: { status: "available", items: rows, next_offset: null } });
  app.node("#show-recovery").listeners.click(); await new Promise(setImmediate);
  const cards = app.node("#tasks").querySelectorAll(".recovery-card");
  assert.equal(cards.length, 4);
  assert.match(cards[0].textContent, /저장 확인/);
  assert.match(cards[1].textContent, /복구 대기.*아직 저장 완료는 아닙니다/);
  assert.match(cards[2].textContent, /복구 차단.*자동 재시도하지 마세요/);
  assert.match(cards[3].textContent, /원래 입력 없음/);
  assert.equal(app.node("#tasks").querySelector("img"), null);
  for (const status of ["available", "missing", "unavailable"]) {
    const emptyApp = await viewer({ recovery: { status, items: [], next_offset: null } });
    emptyApp.node("#show-recovery").listeners.click(); await new Promise(setImmediate);
    assert.match(emptyApp.node("#tasks").textContent, /누락 0건을 뜻하지 않습니다/);
    if (status !== "available") assert.equal(emptyApp.node("#list-count").textContent, "확인 불가");
  }
});

test("401 clears a rejected stored credential, but transient failures preserve it", async () => {
  for (const options of [{ httpStatus: 503 }, { requestFailure: "network" }, { requestFailure: "json" }]) {
    const storage = new Map();
    await viewer({ storage });
    const before = [...storage.entries()];
    await viewer({ storage, hash: "", ...options });
    assert.deepEqual([...storage.entries()], before);
  }
  const storage = new Map();
  await viewer({ storage });
  const rejected = await viewer({ storage, hash: "", httpStatus: 401 });
  assert.equal(storage.size, 0);
  assert.equal(rejected.calls(), 1);
  assert.equal(rejected.node("#connection-error").hidden, false);
});

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
  assert.match(app.node("#detail").textContent, /사람용 요약/);
  const machine = app.node("#detail").querySelector(".machine-report");
  assert.equal(machine.open, false);
  const data = JSON.parse(machine.querySelector("pre").textContent);
  assert.equal(data.record_id, "record");
  assert.equal(data.report.technical.files[0], "ui/app.js");
  assert.equal(data.report.technical.symbols[0], "<script>bad()</script>");
  assert.equal(machine.querySelector("script"), null);
  assert.equal(data.verified, false);
  machine.open = true;
  assert.match(app.node("#detail").textContent, /<img src=x onerror=alert\(1\)>/);
  const raw = app.node("#detail").querySelector(".raw-report");
  assert.equal(raw.open, false);
  raw.open = true;
  await app.tick();
  assert.equal(app.node("#detail").querySelector(".raw-report"), raw);
  assert.equal(raw.open, true);
  assert.equal(machine.open, true);
  app.saveRecord("next-record");
  await app.tick();
  assert.equal(app.node("#detail").querySelector(".machine-report").open, false);
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
  feature.listeners.click();
  app.node("#detail").querySelector(".button").listeners.click(); await new Promise(setImmediate);
  await app.tick();
  assert.equal(app.node("#feature-filter").value, lateFeatureKey);
  assert.equal(app.node("#feature-filter").children.find(node => node.value === lateFeatureKey).textContent, "마지막 기능");
  assert.ok(app.requests.some(path => path.includes(`feature=${lateFeatureKey}`)));
  }
});

test("search focus keeps polling; returning to a visible tab immediately fetches updates", async () => {
  const app = await viewer();
  const calls = app.calls();
  app.document.activeElement = app.node("#search");
  app.advance(120_000);
  await app.tick();
  assert.deepEqual(app.labels(), ["2분 전", "2분 전"]);
  assert.ok(app.calls() > calls);
  const afterFocusedPoll = app.calls();
  app.document.hidden = true;
  app.document.listeners.visibilitychange();
  app.advance(60_000);
  app.document.hidden = false;
  app.document.listeners.visibilitychange();
  assert.deepEqual(app.labels(), ["3분 전", "3분 전"]);
  await new Promise(setImmediate);
  assert.ok(app.calls() > afterFocusedPoll);
});

test("feature brief separates declared status, latest work and uncollected evidence; polling refreshes only changes", async () => {
  const activity = { record_id: "source", run_id: "run-extra1", actor: "Codex", repository: "web", environment: "test", observed_at: "2026-10-21T00:00:00Z",
    report: { summary: "<img src=x>", changes: ["저장 처리 변경"], next_steps: ["브라우저 재접속 확인"], checks: [{ name: "단위 검사", result: "passed" }] } };
  const app = await viewer({ featureDetail: { description: "경과 시간을 표시합니다.", latest_activity: activity,
    latest_report: { record_id: "status", repository: "web", environment: "test", observed_at: activity.observed_at, update: { state: "in_progress", summary: "재접속 확인 남음" } } } });
  app.node("#show-features").listeners.click(); await new Promise(setImmediate);
  const detail = app.node("#detail").children[0];
  assert.match(detail.textContent, /개발 중으로 보고/);
  assert.match(detail.textContent, /최근 무엇이 바뀌었나요/);
  assert.match(detail.textContent, /브라우저 재접속 확인/);
  assert.match(detail.textContent, /관측 조회 정보 없음.*통과 보고/);
  assert.match(detail.textContent, /기록 source/);
  assert.equal(detail.querySelector("img"), null);
  await app.tick();
  assert.equal(app.node("#detail").children[0], detail);
  app.updateFeature({ latest_activity: { ...activity, report: { summary: "새 보고", next_steps: ["다음 검사"] } } });
  await app.tick(); assert.match(app.node("#detail").textContent, /다음 검사/);
  app.node("#detail").querySelector(".feature-actions").children[1].listeners.click(); await new Promise(setImmediate);
  assert.ok(app.requests.some(path => path.startsWith("/api/runs/run-extra1?")));
  const missing = await viewer();
  missing.node("#show-features").listeners.click(); await new Promise(setImmediate);
  assert.match(missing.node("#detail").textContent, /할 일이 없거나 기능이 완료됐다는 뜻은 아닙니다/);
});

test("leaving a feature while its original-report navigation awaits cannot overwrite the new view", async () => {
  const app = await viewer({ holdScopedRuns: true, featureDetail: { latest_activity: { run_id: "run-extra1", record_id: "source", report: { summary: "이전 기능 보고" } } } });
  app.node("#show-features").listeners.click(); await new Promise(setImmediate);
  app.node("#detail").querySelector(".feature-actions").children[1].listeners.click();
  app.node("#show-skills").listeners.click(); await new Promise(setImmediate);
  app.releaseScoped(); await new Promise(setImmediate);
  assert.match(app.node("#detail").textContent, /샘플 스킬/);
  assert.ok(!app.requests.some(path => path.startsWith("/api/runs/run-extra1?")));
});

test("a late feature catalog page cannot overwrite a newly selected skill view", async () => {
  const app = await viewer({ manyFeatures: true, holdMoreFeatures: true });
  app.node("#show-features").listeners.click(); await new Promise(setImmediate);
  const pending = app.node("#more-tasks").listeners.click();
  app.node("#show-skills").listeners.click(); await new Promise(setImmediate);
  app.releaseMore(); await pending;
  assert.match(app.node("#tasks").textContent, /샘플 스킬/);
  assert.match(app.node("#detail").textContent, /샘플 스킬/);
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

test("workstream preserves unchanged nodes and scroll; only saved changes animate", async () => {
  const app = await viewer({ active: true });
  const board = app.node("#components"), original = board.children[0];
  assert.match(original.className, /lane-enter/);
  board.scrollLeft = 120;
  await app.tick();
  assert.equal(board.children[0], original);
  assert.equal(board.scrollLeft, 120);
  app.updateTask({ activity: "unfinished" });
  await app.tick();
  assert.equal(board.children[0], original, "A clock-derived activity change is not a new saved record.");
  app.updateTask({ updated_at: "2026-10-21T01:01:00Z" });
  await app.tick();
  const updated = board.children[0];
  assert.match(updated.className, /lane-updated/);
  assert.equal(board.scrollLeft, 120);
  await app.tick();
  assert.equal(board.children[0], updated);
  const reduced = await viewer({ active: true, reducedMotion: true });
  assert.doesNotMatch(reduced.node("#components").children[0].className, /lane-enter|lane-updated/);
  reduced.updateTask({ updated_at: "2026-10-21T01:01:00Z" });
  await reduced.tick();
  assert.doesNotMatch(reduced.node("#components").children[0].className, /lane-enter|lane-updated/);
});

test("expanded board prepares up to three linked tasks with safe saved details and refreshes summaries", async () => {
  const app = await viewer({ active: true, structured: true, extraActiveTasks: 4 });
  const board = app.node("#components"), cards = board.querySelectorAll(".lane-task");
  assert.equal(cards.length, 3);
  assert.match(cards[0].textContent, /마지막 기록/);
  assert.match(cards[0].textContent, /저장된 작업 요약 <img src=x>/);
  assert.equal(cards[0].querySelector("img"), null);
  assert.match(cards[0].textContent, /브랜치 test\/board/);
  assert.match(board.textContent, /5개 중 3개 표시/);
  await cards[1].listeners.click();
  await new Promise(setImmediate);
  assert.ok(app.requests.some(path => path.startsWith("/api/runs/run-extra1?")));
  assert.match(app.node("#detail").textContent, /추가 작업 1/);
  app.updateTask({ latest_report: { summary: "새 요약" }, updated_at: null });
  await app.tick();
  assert.match(board.querySelector(".lane-summary").textContent, /새 요약/);
  assert.match(board.querySelector(".lane-last").textContent, /기록 시각 미수집/);
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

test("skill tab renders versioned plain-text content and keeps unchanged detail stable during polling", async () => {
  const app = await viewer();
  app.node("#show-skills").listeners.click(); await new Promise(setImmediate);
  assert.match(app.node("#tasks").textContent, /샘플 스킬/); assert.match(app.node("#tasks").textContent, /내용 변경/);
  assert.match(app.node("#detail").textContent, /설치 방법/); assert.match(app.node("#detail").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(app.node("#detail").querySelector("img"), null);
  const before = app.node("#detail").children[0]; await app.tick();
  assert.equal(app.node("#detail").children[0], before);
  const select = app.node("#detail").querySelector("select"); select.value = "1.0"; select.listeners.change(); await new Promise(setImmediate);
  assert.match(app.node("#detail").textContent, /이전 버전 전문/);
  assert.ok(app.requests.some(path => path.startsWith("/api/skill?") && path.includes("version=1.0")));
});

test('missing execution data is not rendered as a confirmed empty query', async () => {
  const app = await viewer({ structured: true, executions: null });
  const detail = app.node('#detail');
  assert.match(detail.querySelector('.validation-evidence').textContent, /확인 불가/);
  assert.match(detail.querySelector('.execution-observations').textContent, /조회 정보 없음/);
  assert.doesNotMatch(detail.querySelector('.execution-observations').textContent, /수집된 실행 결과 없음/);
});

test('feature evidence summary follows aggregate observations without promoting its AI check', async () => {
  const app = await viewer({ featureDetail: {
    latest_activity: { report: { summary: '검사 보고', checks: [{ name: '테스트', result: 'passed' }] } },
    execution_evidence: { status: 'observations_available', total: 2, unconfirmed: 1 }
  } });
  app.node('#show-features').listeners.click(); await new Promise(setImmediate);
  assert.match(app.node('#detail').querySelector('.validation-evidence').textContent, /직접 실행 관측 있음/);
  assert.match(app.node('#detail').textContent, /연결 작업 전체 기준/);
  assert.match(app.node('#detail').textContent, /통과 보고/);
  app.updateFeature({ execution_evidence: { status: 'observations_available', total: 2, unconfirmed: 2 } });
  await app.tick();
  assert.match(app.node('#detail').querySelector('.validation-evidence').textContent, /확인 불가/);
});

test('execution cards render collected counts and safe failure names without promoting AI reports', async () => {
  const row = { id: 'observed', executable: 'node', outcome: 'exited', exit_code: 1, duration_ms: 500, started_at: '2026-10-21T01:00:00Z', stdout_bytes: 25, stderr_bytes: 0,
    test_details: {status:'collected',framework:'node_test',counts:{tests:4,passed:1,failed:1,cancelled:0,skipped:1,todo:1,suites:1},suite_success:false,failures:['<img src=x onerror=bad()>'],failures_truncated:true} };
  const app = await viewer({structured:true,executions:{items:[row],next_offset:null}});
  const detail = app.node('#detail'), section = detail.querySelector('.test-results');
  assert.match(section.textContent,/통과 1/);assert.match(section.textContent,/실패 1/);assert.match(section.textContent,/건너뜀 1/);
  assert.match(section.textContent,/실행기 종합 판정: 실패/);assert.match(section.textContent,/일부 항목 또는 이름이 생략/);
  assert.match(section.textContent,/<img src=x/);assert.equal(section.querySelector('img'),null);
  assert.match(detail.textContent,/AI 검사 보고 1건/);assert.match(detail.textContent,/기능 검증 완료를 뜻하지 않습니다/);
  const unknown=await viewer({executions:{items:[{...row,test_details:{status:'not_collected',reason:'interrupted'}}],next_offset:null}});
  assert.match(unknown.node('#detail').textContent,/검사 상세 미수집/);assert.equal(unknown.node('#detail').querySelector('.test-results'),null);
});

test('manual refresh reads new records and a hung request releases the button for retry',async()=>{
 const app=await viewer();app.saveRecord('manual-new');app.node('#refresh').listeners.click();await new Promise(setImmediate);
 assert.equal(app.node('#detail').querySelector('.timeline-entry').querySelector('details').dataset.record,'manual-new');
 app.hangNext();app.node('#refresh').listeners.click();assert.equal(app.node('#refresh').disabled,true);await app.expireRequests();
 assert.equal(app.node('#refresh').disabled,false);assert.match(app.node('#connection-error').textContent,/초과/);
 app.node('#refresh').listeners.click();await new Promise(setImmediate);assert.equal(app.node('#connection-error').hidden,true);assert.equal(app.node('#refresh').disabled,false);
});
test('expanded older records remain while polling updates the latest record and dashboard',async()=>{
 const app=await viewer({historyPage:true,active:true});await app.node('#detail').querySelectorAll('button').find(b=>b.textContent==='이전 기록 더 보기').listeners.click();
 assert.equal(app.node('#detail').querySelectorAll('.timeline-entry').length,2);const calls=app.calls();app.saveRecord('new-head');app.updateTask({title:'갱신된 작업'});await app.tick();
 assert.ok(app.calls()>calls);assert.match(app.node('#components').textContent,/갱신된 작업/);assert.ok(app.node('#detail').querySelectorAll('.timeline-entry').some(node=>node.querySelector('details').dataset.record==='older'));
 assert.ok(app.node('#detail').querySelectorAll('.timeline-entry').some(node=>node.querySelector('details').dataset.record==='new-head'));
});

test('only unfinished storage stages have a current flow point; closed tasks stay still',async()=>{
 const app=await viewer({active:true});assert.equal(app.node('#detail').querySelector('.flow').dataset.state,'active');
 assert.equal(app.node('#detail').querySelector('.flow').querySelectorAll('.current').length,1);
 assert.match(app.node('#detail').textContent,/마감 대기.*실제 실행 감지/);
 app.updateTask({state:'completed',activity:'completed'});await app.tick();
 assert.equal(app.node('#detail').querySelector('.flow').querySelectorAll('.current').length,0);
 app.updateTask({state:'interrupted',activity:'interrupted'});await app.tick();
 assert.equal(app.node('#detail').querySelector('.flow').querySelectorAll('.current').length,0);
});

test('empty-project import keeps a selected file while its new destination is edited', async () => {
 const body=new Element('body');let savedInput;
 const doc={body,createElement:tag=>{const n=new Element(tag);n.showModal=()=>{};n.close=()=>{};return n;}};
 const source=readFileSync(new URL('../ui/document-batch.js',import.meta.url),'utf8').replace('export function','function')+'\n'+readFileSync(new URL('../ui/documents.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export function','function');
 const ui=runInNewContext(source+'; createDocumentImport', {TextDecoder})({document:doc,request:async(url,options)=>{
  if(!options)return {items:[]};savedInput=JSON.parse(options.body);return {preview_token:'preview',source:{bytes:10,sha256:'hash'},parts:1};
 },onSaved:()=>{}});
 await ui.open({id:'new-project',name:'새 프로젝트'});
 const inputs=body.querySelectorAll('input'),[repository,environment,file]=inputs;
 const select=body.querySelector('select');assert.equal(select.value,'new');
 let finishRead;file.files=[{name:'first.md',size:10,arrayBuffer:()=>new Promise(resolve=>{finishRead=resolve;})}];
 const reading=file.listeners.change();repository.value='main';repository.listeners.input();environment.value='development';environment.listeners.input();
 finishRead(new TextEncoder().encode('# 원문').buffer);await reading;
 const preview=body.querySelectorAll('button').find(n=>n.textContent==='원문 미리보기');assert.equal(preview.disabled,false);await preview.listeners.click();
 assert.deepEqual(JSON.parse(JSON.stringify(savedInput)),{project_id:'new-project',target_scope:{repository:'main',environment:'development'},component_key:'',path:'first.md',text:'# 원문'});
 const save=body.querySelectorAll('button').find(n=>n.textContent==='소급 기록으로 가져오기');assert.equal(save.disabled,false);
 environment.value='test';environment.listeners.input();assert.equal(save.disabled,true);
});
