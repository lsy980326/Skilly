import { renderSkillList, renderSkillDetail } from "./skills.js";
import { renderWorkstream } from "./workstream.js";
import { createViewerSession } from "./session.js";
import { renderMachineReport } from "./reports.js";
import "./layout.js";

const $ = selector => document.querySelector(selector);
const session = createViewerSession({ location, history, getStorage: () => localStorage });
const state = { projects: [], project: null, run: null, view: "runs", filter: "all", query: "", items: [], records: [], nextProjects: null, nextItems: null, nextRecords: null,
  components: [], features: [], component: "", feature: "", nextComponents: null, nextFeatures: null, summary: {}, selectedNames: {}, overviewTasks: [], overviewPartial: false };
state.skillKey = null; state.skillVersion = null; state.skillOffset = 0;
let lastSkill = "";
let listRequest = 0, detailRequest = 0, catalogRequest = 0, refreshing = false, timer, searchTimer;
let projectsPaged = false, listPaged = false, detailPaged = false, lastDetail = "";
const paged = () => projectsPaged || listPaged || detailPaged;
const statusLabels = { recent: "최근 활동", unfinished: "갱신 확인 필요", completed: "완료", interrupted: "중단" };
const originLabels = { contemporaneous: "당시 기록", retrospective: "소급 기록", unspecified: "작성 시점 미지정" };
const kindLabels = { note: "메모", decision: "결정", change: "변경", issue: "문제", summary: "요약" };
const modeLabels = { change: "구현", diagnose: "진단", review: "검토", answer: "설명" };
const recoveryLabels = { saved: "저장 확인됨", conflict: "요청 충돌", rejected: "요청 거절", unconfirmed: "저장 미확인", retry_required: "재시도 필요", blocked: "복구 확인 필요" };
const featureStates = { planned: "계획됨", in_progress: "개발 중으로 보고", implemented: "구현됨으로 보고", blocked: "막힘 보고", retired: "종료된 기능으로 보고" };

function chips(task) {
  const container = element("div", "work-chips");
  for (const item of task.components ?? []) container.append(badge(item.name, "component"));
  if (!task.components?.length) container.append(badge(task.projection_truncated ? "상세에서 구성요소 확인" : "구성요소 미분류", ""));
  for (const item of task.features ?? []) container.append(badge(item.name, "feature"));
  if (task.links_truncated) container.append(badge(`일부 연결 표시 · 구성요소 ${task.components_total} / 기능 ${task.features_total}`, ""));
  return container;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function empty(title, body) {
  const node = element("div", "empty");
  node.append(element("strong", "", title), element("p", "", body));
  return node;
}
function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "시각 미수집" : new Intl.DateTimeFormat("ko-KR", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(parsed);
}
function relative(value, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(value)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return date(value);
  if (minutes < 1) return "방금 기록";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  return date(value);
}
function relativeTime(value, tag = "span", className = "") {
  const node = element(tag, className, relative(value));
  node.dataset.relativeTime = value;
  return node;
}
function refreshRelativeTimes() {
  const now = Date.now();
  // Time can change even when the report fingerprint is unchanged. Keep the
  // existing detail nodes so reading, focus and expanded records are undisturbed.
  for (const node of document.querySelectorAll("[data-relative-time]")) {
    const label = relative(node.dataset.relativeTime, now);
    if (node.textContent !== label) node.textContent = label;
  }
}
function badge(label, style, dot = false) {
  const node = element("span", `badge ${style}`);
  if (dot) node.append(element("span", "activity-dot"));
  node.append(document.createTextNode(label));
  return node;
}
async function api(path) {
  const response = await fetch(path, { headers: session.headers(), credentials: "omit", cache: "no-store" });
  if (response.status === 401) session.reject();
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "기록을 읽지 못했습니다.");
  session.confirm();
  return result;
}
function showError(error) {
  $("#connection-error").textContent = error.message || "연결을 확인하고 새로고침해 주세요.";
  $("#connection-error").hidden = false;
  $("#sync-status").textContent = "조회 실패 · 마지막 화면 유지";
}
function showSynced() {
  $("#connection-error").hidden = true;
  $("#sync-status").textContent = `${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })} 확인 · ${paged() ? "이전 목록 조회 중" : "15초마다 갱신"}`;
  if (session.persistenceLimited) $("#sync-status").textContent += " · 브라우저 저장 제한: 새로고침 시 다시 연결해 주세요";
}
function renderProjects() {
  const container = $("#projects");
  container.replaceChildren();
  $("#project-count").textContent = String(state.projects.length);
  if (!state.projects.length) container.append(empty("아직 프로젝트가 없습니다", "연결된 AI가 첫 작업을 저장하면 여기에 나타납니다."));
  for (const project of state.projects) {
    const button = element("button", `project-choice${state.project === project.id ? " selected" : ""}`);
    button.setAttribute("aria-pressed", String(state.project === project.id));
    button.append(element("span", "project-icon", project.name.slice(0, 1).toUpperCase()));
    const labels = element("span");
    labels.append(element("span", "project-label", project.name),
      element("span", "project-meta", `작업 ${project.total} · 미완료 ${project.unfinished}`));
    button.append(labels);
    button.addEventListener("click", () => { void selectProject(project.id).catch(showError); });
    container.append(button);
  }
  $("#more-projects").hidden = state.nextProjects === null;
}
async function loadProjects(more = false) {
  const data = await api(`/api/projects?offset=${more ? state.nextProjects : 0}`);
  if (more) {
    const byId = new Map(state.projects.map(project => [project.id, project]));
    data.items.forEach(project => byId.set(project.id, project));
    state.projects = [...byId.values()];
  } else state.projects = data.items;
  state.nextProjects = data.next_offset;
  renderProjects();
}
async function selectProject(id) {
  if (state.project === id) return;
  state.project = id; state.run = null; state.skillKey = null; state.skillVersion = null; state.skillOffset = 0; lastSkill = ""; state.query = ""; state.filter = "all";
  state.component = ""; state.feature = ""; state.components = []; state.features = [];
  state.overviewTasks = []; state.overviewPartial = false;
  state.summary = {}; state.nextComponents = null; state.nextFeatures = null;
  state.selectedNames = {};
  listPaged = false; detailPaged = false; lastDetail = "";
  listRequest++; detailRequest++; catalogRequest++;
  clearTimeout(searchTimer);
  $("#search").value = "";
  state.records = []; state.nextRecords = null;
  $("#detail").replaceChildren(empty("작업을 선택하세요", "저장된 흐름과 상세 기록을 여기에서 확인할 수 있습니다."));
  $(".detail-panel").scrollTop = 0;
  const project = state.projects.find(project => project.id === id);
  $("#project-key").textContent = project.key;
  $("#project-name").textContent = project.name;
  $("#project-description").textContent = "어디에서, 어떤 기능을, 누가 작업했는지 한눈에.";
  renderProjects(); renderFilters();
  renderCatalog();
  $("#service-summary").replaceChildren();
  $("#components").replaceChildren(element("p", "loading", "구성요소와 작업 흐름을 불러오는 중…"));
  $("#workstream-note").textContent = "";
  $("#tasks").replaceChildren(element("p", "loading", "기록을 불러오는 중…"));
  await loadCatalog();
  await loadList();
}
async function loadCatalog(moreView) {
  if (!state.project) return;
  const request = ++catalogRequest, project = state.project;
  const views = moreView ? [moreView] : ["components", "features"];
  const responses = await Promise.all([
    ...views.map(view => api(`/api/overview?project=${project}&view=${view}&offset=${moreView ? (view === "components" ? state.nextComponents : state.nextFeatures) : 0}`)),
    ...(!moreView ? [api(`/api/runs?project=${project}&state=active&offset=0`)] : []),
  ]);
  if (request !== catalogRequest || project !== state.project) return;
  views.forEach((view, index) => {
    const data = responses[index];
    state.summary = data.summary;
    state[view] = moreView ? [...new Map([...state[view], ...data.items].map(item => [item.key, item])).values()] : data.items;
    if (view === "components") state.nextComponents = data.next_offset;
    else state.nextFeatures = data.next_offset;
  });
  if (!moreView) { state.overviewTasks = responses[views.length].items; state.overviewPartial = responses[views.length].next_offset !== null; }
  renderCatalog();
}
function renderCatalog() {
  const summary = $("#service-summary"); summary.replaceChildren();
  for (const [label, value] of [["작업", state.summary.total], ["미완료", state.summary.unfinished], ["미분류", state.summary.unclassified]]) {
    const item = element("span"); item.append(element("strong", "", value ?? 0), document.createTextNode(` ${label}`)); summary.append(item);
  }
  renderWorkstream($("#components"), { project: state.project, components: state.components, tasks: state.overviewTasks,
    animate: !document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches,
    selected: state.component, summary: state.summary, partial: state.overviewPartial },
  key => { void applyScope("component", key).catch(showError); },
  task => { void openRun(task.id).catch(showError); });
  $("#workstream-note").textContent = `구성요소를 누르면 관련 작업을 봅니다. ${state.overviewPartial ? `최근 미완료 작업 ${state.overviewTasks.length}개 표시 · 나머지는 목록에서 확인` : "미완료는 종료 기록이 없다는 뜻입니다."}`;
  $("#more-components").hidden = state.nextComponents === null;
  for (const [id, items, value, label] of [["component", state.components, state.component, "구성요소"], ["feature", state.features, state.feature, "기능"]]) {
    const select = $(`#${id}-filter`); select.replaceChildren();
    const all = element("option", "", `전체 ${label}`); all.value = ""; select.append(all);
    if (id === "component") { const option = element("option", "", "미분류 기록"); option.value = "unclassified"; select.append(option); }
    for (const item of items) { const option = element("option", "", item.name); option.value = item.key; select.append(option); }
    if (value && (id !== "component" || value !== "unclassified") && !items.some(item => item.key === value)) {
      const option = element("option", "", state.selectedNames[id] || value); option.value = value; select.append(option);
    }
    select.value = value;
  }
}
async function applyScope(field, value) {
  state.selectedNames[field] = state[field === "component" ? "components" : "features"].find(item => item.key === value)?.name || value;
  state[field] = value; state.run = null; listPaged = false; detailPaged = false; lastDetail = "";
  listRequest++; detailRequest++;
  state.records = []; $("#detail").replaceChildren(empty("작업을 선택하세요", "선택한 구성요소와 기능의 작업을 확인하세요."));
  renderCatalog();
  if (state.view !== "runs") await changeView("runs");
  else await loadList();
}
function renderFilters() {
  for (const button of $("#filters").children) {
    const selected = button.dataset.state === state.filter;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}
async function loadList(more = false) {
  if (!state.project) return;
  const request = ++listRequest;
  const project = state.project, view = state.view;
  if (view === "features") {
    renderFeatures(); return;
  }
  const params = new URLSearchParams({ project, offset: String(more ? state.nextItems : 0) });
  if (view === "runs") { params.set("state", state.filter); params.set("query", state.query); }
  if (view === "runs" && state.component) params.set("component", state.component);
  if (view === "runs" && state.feature) params.set("feature", state.feature);
  const data = await api(`/api/${view === "runs" ? "runs" : view === "skills" ? "skills" : "recovery"}?${params}`);
  if (request !== listRequest || project !== state.project || view !== state.view) return;
  state.items = more ? [...new Map([...state.items, ...data.items].map(item => [item.id ?? item.request_id ?? item.skill_key, item])).values()] : data.items;
  state.nextItems = data.next_offset;
  $("#list-count").textContent = view === "recovery" && data.status !== "available"
    ? "확인 불가" : `${state.items.length}${data.next_offset !== null ? "+" : ""}개`;
  $("#more-tasks").hidden = data.next_offset === null;
  $("#more-tasks").textContent = view === "runs" ? "작업 더 보기" : view === "skills" ? "스킬 더 보기" : "복구 요청 더 보기";
  if (view === "skills") {
    renderSkillList($("#tasks"), state.items, state.skillKey, key => { void openSkill(key).catch(showError); });
    if (!state.skillKey && state.items[0]) await openSkill(state.items[0].skill_key);
    else if (state.skillKey) await openSkill(state.skillKey, state.skillVersion, state.skillOffset);
  } else if (view === "runs") {
    renderTasks();
    if (!state.run && state.items[0]) {
      state.run = state.items[0].id; renderTasks(); await loadDetail();
    }
  } else renderRecovery(data.status);
}
async function openSkill(key, version, installationOffset = 0) {
  const request = ++detailRequest, project = state.project;
  state.skillKey = key; state.skillVersion = version; state.skillOffset = installationOffset;
  renderSkillList($("#tasks"), state.items, key, selected => { void openSkill(selected).catch(showError); });
  const params = new URLSearchParams({ project, skill: key, offset: String(installationOffset) }); if (version) params.set("version", version);
  const data = await api(`/api/skill?${params}`);
  if (request !== detailRequest || state.project !== project || state.view !== "skills") return;
  state.skillVersion = data.skill.version;
  const fingerprint = JSON.stringify(data); if (lastSkill === fingerprint) return; lastSkill = fingerprint;
  renderSkillDetail($("#detail"), data, selected => { void openSkill(key, selected).catch(showError); }, offset => { void openSkill(key, state.skillVersion, offset).catch(showError); });
}
function renderTasks() {
  const container = $("#tasks"); container.replaceChildren();
  if (!state.items.length) container.append(empty("해당하는 작업이 없습니다", state.query ? "검색어나 상태 필터를 바꿔 보세요." : "AI가 작업을 저장하면 목록에 나타납니다."));
  for (const task of state.items) {
    const button = element("button", `task-card${task.id === state.run ? " selected" : ""}`);
    button.setAttribute("aria-pressed", String(task.id === state.run));
    const top = element("span", "card-top");
    top.append(badge(statusLabels[task.activity], task.activity, true), relativeTime(task.updated_at, "span", "card-time"));
    button.append(top, element("span", "task-goal", task.title || task.goal), chips(task));
    if (task.latest_report) button.append(element("span", "task-summary", task.latest_report.summary));
    const footer = element("span", "card-footer");
    footer.append(element("span", "actor-icon", task.actor ? task.actor.slice(0, 1) : "?"),
      element("span", "", task.actor || "작성자 미수집"),
      element("span", "card-repo", task.repository));
    button.append(footer);
    button.addEventListener("click", () => { void openRun(task.id).catch(showError); });
    container.append(button);
  }
}
async function openRun(id) {
  state.run = id; detailPaged = false; lastDetail = "";
  if (state.view === "runs") renderTasks();
  $("#detail").replaceChildren(element("p", "loading", "상세 기록을 불러오는 중…"));
  $(".detail-panel").scrollTop = 0;
  await loadDetail();
  if (matchMedia("(max-width: 600px)").matches) $(".detail-panel").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
}
function renderFeatures() {
  const container = $("#tasks"); container.replaceChildren();
  $("#list-count").textContent = `${state.features.length}${state.nextFeatures !== null ? "+" : ""}개`;
  $("#more-tasks").hidden = state.nextFeatures === null;
  $("#more-tasks").textContent = "기능 더 보기";
  if (!state.features.length) container.append(empty("연결된 기능이 없습니다", "다음 작업에서 AI가 기능을 연결하면 설명과 최근 보고를 여기에서 볼 수 있습니다. 과거 기록을 추정해 분류하지 않습니다."));
  for (const feature of state.features) {
    const card = element("article", "feature-card");
    card.append(element("h3", "", feature.name), element("p", "", feature.description || "기능 설명 미수집"));
    card.append(element("p", "catalog-note", `연결 작업 ${feature.total} · 미완료 ${feature.unfinished}`));
    if (feature.latest_report) {
      const latest = feature.latest_report;
      card.append(badge(featureStates[latest.update.state] ?? "상태 미수집", "feature"), element("p", "", latest.update.summary),
        element("small", "catalog-note", `당시 보고 · 미검증 · ${latest.repository} / ${latest.environment} · ${date(latest.observed_at)}`));
    } else card.append(element("p", "catalog-note", "현재 상태 보고 없음 · 작업 종료를 기능 완료로 간주하지 않습니다."));
    const button = element("button", "button", "연결 작업 보기");
    button.addEventListener("click", async () => {
      try { await applyScope("feature", feature.key); } catch (error) { showError(error); }
    });
    card.append(button); container.append(card);
  }
}
async function loadDetail(more = false) {
  if (!state.project || !state.run) return;
  const request = ++detailRequest, project = state.project, run = state.run;
  const data = await api(`/api/runs/${run}?project=${project}${more ? `&before=${state.nextRecords}` : ""}`);
  if (request !== detailRequest || project !== state.project || run !== state.run) return;
  state.records = more ? [...state.records, ...data.records.items] : data.records.items;
  state.nextRecords = data.records.next_before;
  const fingerprint = JSON.stringify([data.run, data.record_counts, state.records, state.nextRecords]);
  if (fingerprint === lastDetail) return;
  lastDetail = fingerprint;
  renderDetail(data.run, data.record_counts, !more);
}
function meta(label, value, hint) {
  const node = element("div");
  const dd = element("dd", "", value);
  if (hint) dd.append(typeof hint === "string" ? element("small", "", hint) : hint);
  node.append(element("dt", "", label), dd);
  return node;
}
function renderDetail(task, counts = {}, animateNew = true) {
  const sameTask = $("#detail").querySelector(".detail-content")?.dataset.run === task.id;
  const priorRecords = new Set([...$("#detail").querySelectorAll(".record")].map(node => node.dataset.record));
  const expanded = new Map([...$("#detail").querySelectorAll("details")].map(node => [node.dataset.record, node.open]));
  const rawExpanded = new Map([...$("#detail").querySelectorAll("details")].filter(node => node.dataset.raw).map(node => [node.dataset.raw, node.open]));
  const machineExpanded = new Map([...$("#detail").querySelectorAll(".machine-report")].map(node => [node.dataset.machine, node.open]));
  const panel = element("div", "detail-content");
  panel.dataset.run = task.id;
  const top = element("div", "detail-top");
  top.append(element("p", "eyebrow", modeLabels[task.mode] ?? task.mode), badge(statusLabels[task.activity], task.activity, true));
  panel.append(top, element("h2", "detail-title", task.title || Array.from(task.goal).slice(0, 100).join("") + (task.goal.length > 100 ? "…" : "")), chips(task));
  const request = element("details", "original-request");
  request.append(element("summary", "", "전체 작업 요청"), element("p", "record-body", task.goal));
  panel.append(request);
  const metadata = element("dl", "metadata");
  metadata.append(meta("작성 주체", task.actor || "작성자 미수집", task.actor ? "AI가 제공한 이름 · 신원 인증 아님" : "이 기록에는 작성자 정보가 없습니다"),
    meta("마지막 기록", date(task.updated_at), relativeTime(task.updated_at, "small")),
    meta("저장소 / 환경", `${task.repository} / ${task.environment}`, task.branch ? `브랜치 ${task.branch}` : undefined),
    meta("작업 시작", date(task.created_at)));
  panel.append(metadata);
  const flow = element("div", "flow");
  const progress = Object.entries(counts).some(([kind, count]) => kind !== "summary" && count > 0);
  for (const [label, hint, done] of [
    ["시작", "시작 저장됨", true],
    ["진행 기록", progress ? "변경·진행 보고 있음" : "아직 없음", progress],
    [task.state === "interrupted" ? "중단" : "종료", task.state === "active" ? "마감되지 않음" : "마감 저장됨", task.state !== "active"],
  ]) {
    const step = element("div", `flow-step${done ? " done" : ""}`);
    step.append(element("span", "flow-point"), document.createTextNode(label), element("small", "", hint));
    flow.append(step);
  }
  panel.append(flow, element("p", "activity-note", task.state === "active"
    ? "최근 활동은 5분 이내 기록이 저장됐다는 뜻입니다. 실시간 실행 여부는 수집하지 않으므로, 오래 갱신되지 않은 작업은 AI 채팅에서 확인하세요."
    : "마감은 작업 상태를 뜻합니다. 기록 내용의 정확성이나 테스트 성공을 자동 검증한 것은 아닙니다."));
  const heading = element("div", "timeline-heading");
  heading.append(element("h3", "", "기록 타임라인"), element("span", "", "최근 저장 순 · AI가 작성한 보고"));
  panel.append(heading);
  if (!state.records.length) panel.append(empty("아직 상세 기록이 없습니다", "작업 시작만 저장됐습니다. 변경·종료 보고가 들어오면 나타납니다."));
  state.records.forEach((record, index) => {
    const entry = element("article", `timeline-entry ${record.report_origin}${animateNew && sameTask && !priorRecords.has(record.id) ? " newly-saved" : ""}`);
    const stamp = element("div", "timeline-stamp");
    const stage = record.report_origin === "retrospective" ? "소급" : kindLabels[record.kind] ?? "기록";
    const time = element("time", "", date(record.recorded_at)); time.dateTime = record.recorded_at;
    stamp.append(element("span", `timeline-marker ${record.kind}`, stage), time);
    const details = element("details", `record${record.superseded_by ? " superseded" : ""}`);
    details.dataset.record = record.id;
    details.open = expanded.has(record.id) ? expanded.get(record.id) : index === 0;
    const summary = element("summary");
    summary.append(element("span", "record-title", record.report?.title || `${kindLabels[record.kind] ?? record.kind} · ${record.topic}`));
    const tags = element("div", "record-badges");
    tags.append(badge(originLabels[record.report_origin] || originLabels.unspecified, record.report_origin),
      badge("미검증", ""));
    if (record.superseded_by) tags.append(badge("정정된 기록", "warning"));
    details.append(summary, tags);
    if (record.report) {
      details.append(element("p", "report-label", "사람용 요약"));
      details.append(element("p", "report-summary", record.report.summary));
      for (const [label, entries] of [["핵심 변화", record.report.changes], ["제약·확인 필요", record.report.limitations], ["다음 작업", record.report.next_steps]]) {
        if (!entries?.length) continue;
        const section = element("section", "report-section"); section.append(element("h4", "", label));
        const list = element("ul"); entries.forEach(entry => list.append(element("li", "", entry)));
        section.append(list); details.append(section);
      }
      if (record.report.checks?.length) {
        const section = element("section", "report-section"); section.append(element("h4", "", "확인 결과 · AI 보고"));
        for (const check of record.report.checks) {
          const item = element("div", "check-row");
          item.append(badge({ passed: "통과 보고", failed: "실패 보고", not_run: "미실행" }[check.result] || "미수집", check.result === "failed" ? "warning" : ""),
            element("span", "", check.name));
          if (check.detail) item.append(element("small", "", check.detail));
          section.append(item);
        }
        details.append(section);
      }
    } else {
      details.append(element("p", "catalog-note", "기존 원문 기록 · 구조화 요약 없음"),
        element("p", "legacy-preview", Array.from(record.body).slice(0, 180).join("") + (record.body.length > 180 ? "…" : "")));
    }
    details.append(renderMachineReport(record, task, element, machineExpanded.get(record.id) ?? false));
    const raw = element("details", "raw-report"); raw.dataset.raw = record.id;
    raw.open = rawExpanded.get(record.id) ?? false;
    raw.append(element("summary", "", "원문 기록 보기"), element("p", "record-body", record.body));
    details.append(raw);
    const id = element("details", "record-id"); id.append(element("summary", "", "출처·기록 ID"), element("div", "", `기록 ${record.id}`));
    id.append(element("div", "", `관측 시각 ${date(record.observed_at)} · 저장 시각 ${date(record.recorded_at)}`));
    if (record.superseded_by) id.append(element("div", "", `후속 기록 ${record.superseded_by}`));
    details.append(id); entry.append(stamp, details); panel.append(entry);
  });
  if (state.nextRecords === null) {
    const start = element("div", "timeline-start");
    start.append(element("span", "", "작업 시작"), element("time", "", date(task.created_at)), element("small", "", "시작 영수증 · 상세 보고와 구분"));
    panel.append(start);
  }
  if (state.nextRecords !== null) {
    const more = element("button", "button more", "이전 기록 더 보기");
    more.addEventListener("click", async () => {
      detailPaged = true;
      try { await loadDetail(true); showSynced(); } catch (error) { showError(error); }
    });
    panel.append(more);
  }
  panel.append(element("p", "record-id", `작업 ${task.id}`));
  $("#detail").replaceChildren(panel);
}
function renderRecovery(status) {
  const container = $("#tasks"); container.replaceChildren();
  if (status === "unavailable") {
    container.append(empty("복구 보관함을 읽지 못했습니다", "저장 실패가 없다는 뜻은 아닙니다. DB 파일 상태와 접근 권한을 확인한 뒤 새로고침해 주세요.")); return;
  }
  if (status === "missing") {
    container.append(empty("복구 보관함이 없습니다", "아직 생성되지 않았거나 구버전 연결일 수 있습니다. 실패 여부는 이 화면에서 확인할 수 없습니다.")); return;
  }
  container.append(element("div", "recovery-note", "저장 결과를 확인할 요청입니다. 이 화면은 자동 재시도하거나 기록을 변경하지 않습니다. 원래 작업을 수행한 AI에게 재연결 후 확인을 요청하세요."));
  if (!state.items.length) container.append(empty("확인할 보관 요청이 없습니다", "서버에 도달하지 못한 요청은 여기에도 남지 않을 수 있습니다."));
  for (const request of state.items) {
    const card = element("article", "recovery-card");
    card.append(badge(recoveryLabels[request.state], request.state === "saved" ? "completed" : "warning"),
      element("p", "", request.goal || `${request.tool.replace("memory_", "")} · ${request.repository}`),
      element("p", "", request.state === "saved" ? "본 DB의 저장 영수증이 있습니다. 보관함 상태가 정리되지 않은 요청입니다." : request.original_input_retained ? "원래 요청이 보관돼 있습니다. 연결된 AI가 같은 요청으로 복구할 수 있습니다." : "원래 요청은 보관돼 있지 않습니다. 자동 복구를 보장할 수 없습니다."),
      element("p", "card-time", `${date(request.received_at)} · ${request.environment}`));
    if (request.last_error) card.append(element("code", "", `오류: ${request.last_error}`));
    card.append(element("code", "", `요청 ${request.request_id}`));
    if (request.run_id) {
      const button = element("button", "button", "관련 작업 보기");
      button.addEventListener("click", async () => {
        state.run = request.run_id; detailPaged = false; lastDetail = "";
        $(".detail-panel").scrollTop = 0;
        try { await loadDetail(); } catch (error) {
          $("#detail").replaceChildren(empty("작업을 찾지 못했습니다", "이 프로젝트에서 해당 작업의 저장 여부를 확인해 주세요."));
          showError(error);
        }
      });
      card.append(button);
    }
    container.append(card);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true; $("#refresh").disabled = true; $("#sync-dot").classList.add("refreshing");
  try {
    await loadProjects();
    if (!state.project && state.projects[0]) await selectProject(state.projects[0].id);
    else {
      if (state.project) { await loadCatalog(); await loadList(); }
      if (state.run) await loadDetail();
    }
    showSynced();
  } catch (error) { showError(error); }
  finally { refreshRelativeTimes(); refreshing = false; $("#refresh").disabled = false; $("#sync-dot").classList.remove("refreshing"); }
}
function schedule() {
  clearTimeout(timer);
  if (!document.hidden) timer = setTimeout(async () => {
    if (!document.hidden && !paged() && document.activeElement !== $("#search")) await refresh();
    else if (!document.hidden) refreshRelativeTimes();
    schedule();
  }, 15_000);
}
$("#refresh").addEventListener("click", () => { projectsPaged = false; listPaged = false; detailPaged = false; void refresh(); });
$(".brand").addEventListener("click", event => { event.preventDefault(); projectsPaged = false; listPaged = false; detailPaged = false; void refresh(); });
$("#more-projects").addEventListener("click", async () => {
  projectsPaged = true;
  try { await loadProjects(true); showSynced(); } catch (error) { showError(error); }
});
$("#more-tasks").addEventListener("click", async () => {
  listPaged = true;
  try {
    if (state.view === "features") { await loadCatalog("features"); renderFeatures(); }
    else await loadList(true);
    showSynced();
  } catch (error) { showError(error); }
});
async function changeView(view) {
    state.view = view; listPaged = false; state.items = [];
    if (view === "skills" || state.skillKey) { state.run = null; state.skillKey = null; state.skillVersion = null; state.skillOffset = 0; lastSkill = ""; detailRequest++;
      $("#detail").replaceChildren(empty("항목을 선택하세요", "선택한 항목의 상세 내용을 확인하세요.")); }
    listRequest++;
    $("#run-controls").hidden = view !== "runs";
    $("#list-label").textContent = view === "runs" ? "작업 현황" : view === "features" ? "기능 목록" : view === "skills" ? "프로젝트 스킬" : "복구 요청";
    for (const [id, target] of [["#show-runs", "runs"], ["#show-features", "features"], ["#show-recovery", "recovery"], ["#show-skills", "skills"]]) {
      const node = $(id), selected = view === target;
      node.classList.toggle("selected", selected); node.setAttribute("aria-pressed", String(selected));
    }
    $("#tasks").replaceChildren(element("p", "loading", "기록을 불러오는 중…"));
    await loadList();
}
for (const [id, view] of [["#show-runs", "runs"], ["#show-features", "features"], ["#show-recovery", "recovery"], ["#show-skills", "skills"]]) {
  $(id).addEventListener("click", () => { void changeView(view).catch(showError); });
}
$("#more-components").addEventListener("click", async () => {
  projectsPaged = true;
  try { await loadCatalog("components"); showSynced(); } catch (error) { showError(error); }
});
for (const field of ["component", "feature"]) {
  $(`#${field}-filter`).addEventListener("change", event => { void applyScope(field, event.target.value).catch(showError); });
}
$("#filters").addEventListener("click", async event => {
  const selected = event.target.closest("button[data-state]");
  if (!selected) return;
  state.filter = selected.dataset.state; listPaged = false; renderFilters();
  try { await loadList(); } catch (error) { showError(error); }
});
$("#search").addEventListener("input", () => {
  state.query = $("#search").value; listRequest++; listPaged = false;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { void loadList().catch(showError); }, 200);
});
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    event.preventDefault(); if (state.view === "runs") $("#search").focus();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshRelativeTimes();
  schedule();
});
await refresh();
schedule();
