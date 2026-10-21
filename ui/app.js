const $ = selector => document.querySelector(selector);
const token = new URLSearchParams(location.hash.slice(1)).get("token");
history.replaceState(null, "", location.pathname);
const state = { projects: [], project: null, run: null, view: "runs", filter: "all", query: "", items: [], records: [], nextProjects: null, nextItems: null, nextRecords: null };
let listRequest = 0, detailRequest = 0, refreshing = false, timer, searchTimer;
let projectsPaged = false, listPaged = false, detailPaged = false, lastDetail = "";
const paged = () => projectsPaged || listPaged || detailPaged;
const statusLabels = { recent: "최근 활동", unfinished: "갱신 확인 필요", completed: "완료", interrupted: "중단" };
const originLabels = { contemporaneous: "당시 기록", retrospective: "소급 기록", unspecified: "작성 시점 미지정" };
const kindLabels = { note: "메모", decision: "결정", change: "변경", issue: "문제", summary: "요약" };
const modeLabels = { change: "구현", diagnose: "진단", review: "검토", answer: "설명" };
const recoveryLabels = { saved: "저장 확인됨", conflict: "요청 충돌", rejected: "요청 거절", unconfirmed: "저장 미확인", retry_required: "재시도 필요", blocked: "복구 확인 필요" };

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
  if (!token) throw new Error("연결 주소가 필요합니다. Skilly를 실행한 터미널의 전체 주소로 다시 열어 주세요.");
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "기록을 읽지 못했습니다.");
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
  state.project = id; state.run = null; state.query = ""; state.filter = "all";
  listPaged = false; detailPaged = false; lastDetail = "";
  listRequest++; detailRequest++;
  clearTimeout(searchTimer);
  $("#search").value = "";
  state.records = []; state.nextRecords = null;
  $("#detail").replaceChildren(empty("작업을 선택하세요", "저장된 흐름과 상세 기록을 여기에서 확인할 수 있습니다."));
  $(".detail-panel").scrollTop = 0;
  const project = state.projects.find(project => project.id === id);
  $("#project-key").textContent = project.key;
  $("#project-name").textContent = project.name;
  $("#project-description").textContent = "지난 맥락부터 다음 작업까지, 한곳에서.";
  renderProjects(); renderFilters();
  $("#tasks").replaceChildren(element("p", "loading", "기록을 불러오는 중…"));
  await loadList();
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
  const params = new URLSearchParams({ project, offset: String(more ? state.nextItems : 0) });
  if (view === "runs") { params.set("state", state.filter); params.set("query", state.query); }
  const data = await api(`/api/${view === "runs" ? "runs" : "recovery"}?${params}`);
  if (request !== listRequest || project !== state.project || view !== state.view) return;
  state.items = more ? [...new Map([...state.items, ...data.items].map(item => [item.id ?? item.request_id, item])).values()] : data.items;
  state.nextItems = data.next_offset;
  $("#list-count").textContent = view === "recovery" && data.status !== "available"
    ? "확인 불가" : `${state.items.length}${data.next_offset !== null ? "+" : ""}개`;
  $("#more-tasks").hidden = data.next_offset === null;
  $("#more-tasks").textContent = view === "runs" ? "작업 더 보기" : "복구 요청 더 보기";
  if (view === "runs") {
    renderTasks();
    if (!state.run && state.items[0]) {
      state.run = state.items[0].id; renderTasks(); await loadDetail();
    }
  } else renderRecovery(data.status);
}
function renderTasks() {
  const container = $("#tasks"); container.replaceChildren();
  if (!state.items.length) container.append(empty("해당하는 작업이 없습니다", state.query ? "검색어나 상태 필터를 바꿔 보세요." : "AI가 작업을 저장하면 목록에 나타납니다."));
  for (const task of state.items) {
    const button = element("button", `task-card${task.id === state.run ? " selected" : ""}`);
    button.setAttribute("aria-pressed", String(task.id === state.run));
    const top = element("span", "card-top");
    top.append(badge(statusLabels[task.activity], task.activity, true), relativeTime(task.updated_at, "span", "card-time"));
    button.append(top, element("span", "task-goal", task.goal));
    const footer = element("span", "card-footer");
    footer.append(element("span", "actor-icon", task.actor ? task.actor.slice(0, 1) : "?"),
      element("span", "", task.actor || "작성자 미수집"),
      element("span", "card-repo", task.repository));
    button.append(footer);
    button.addEventListener("click", async () => {
      state.run = task.id; detailPaged = false; lastDetail = ""; renderTasks();
      $("#detail").replaceChildren(element("p", "loading", "상세 기록을 불러오는 중…"));
      $(".detail-panel").scrollTop = 0;
      try {
        await loadDetail();
        if (matchMedia("(max-width: 600px)").matches) $(".detail-panel").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      } catch (error) { showError(error); }
    });
    container.append(button);
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
  renderDetail(data.run, data.record_counts);
}
function meta(label, value, hint) {
  const node = element("div");
  const dd = element("dd", "", value);
  if (hint) dd.append(typeof hint === "string" ? element("small", "", hint) : hint);
  node.append(element("dt", "", label), dd);
  return node;
}
function renderDetail(task, counts = {}) {
  const expanded = new Map([...$("#detail").querySelectorAll("details")].map(node => [node.dataset.record, node.open]));
  const panel = element("div", "detail-content");
  const top = element("div", "detail-top");
  top.append(element("p", "eyebrow", modeLabels[task.mode] ?? task.mode), badge(statusLabels[task.activity], task.activity, true));
  panel.append(top, element("h2", "detail-title", task.goal));
  const metadata = element("dl", "metadata");
  metadata.append(meta("작성 주체", task.actor || "작성자 미수집", task.actor ? "AI가 제공한 이름 · 신원 인증 아님" : "이 기록에는 작성자 정보가 없습니다"),
    meta("마지막 기록", date(task.updated_at), relativeTime(task.updated_at, "small")),
    meta("저장소 / 환경", `${task.repository} / ${task.environment}`),
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
    const details = element("details", `record${record.superseded_by ? " superseded" : ""}`);
    details.dataset.record = record.id;
    details.open = expanded.has(record.id) ? expanded.get(record.id) : index < 2;
    const summary = element("summary");
    summary.append(element("span", "record-title", `${kindLabels[record.kind] ?? record.kind} · ${record.topic}`));
    const tags = element("div", "record-badges");
    tags.append(badge(originLabels[record.report_origin] || originLabels.unspecified, record.report_origin),
      badge("미검증", ""), element("time", "record-time", date(record.recorded_at)));
    if (record.superseded_by) tags.append(badge("정정된 기록", "warning"));
    details.append(summary, tags, element("p", "record-body", record.body));
    const id = element("div", "record-id", `기록 ${record.id}`);
    id.append(element("div", "", `관측 시각 ${date(record.observed_at)} · 저장 시각 ${date(record.recorded_at)}`));
    if (record.superseded_by) id.append(element("div", "", `후속 기록 ${record.superseded_by}`));
    details.append(id); panel.append(details);
  });
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
      if (state.project) await loadList();
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
  try { await loadList(true); showSynced(); } catch (error) { showError(error); }
});
for (const [id, view] of [["#show-runs", "runs"], ["#show-recovery", "recovery"]]) {
  $(id).addEventListener("click", async () => {
    state.view = view; listPaged = false; state.items = [];
    $("#run-controls").hidden = view !== "runs";
    $("#list-label").textContent = view === "runs" ? "저장된 작업" : "복구 요청";
    for (const node of [$("#show-runs"), $("#show-recovery")]) {
      const selected = node === $(id);
      node.classList.toggle("selected", selected); node.setAttribute("aria-pressed", String(selected));
    }
    $("#tasks").replaceChildren(element("p", "loading", "기록을 불러오는 중…"));
    try { await loadList(); } catch (error) { showError(error); }
  });
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
