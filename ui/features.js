import { renderValidationEvidence } from "./reports.js";

export function renderMatchReasons(item, element) {
  const box=element("span","match-reasons");
  for(const reason of item.match_reasons||[]) box.append(element("span","match-reason",`${reason.label} · ${reason.value}${reason.feature_name ? ` · ${reason.feature_name}` : ""}`));
  if(item.match_reasons_truncated)box.append(element("small","catalog-note","일치 이유 일부 표시"));
  return box;
}

// Present saved reports without inferring a feature's completion or verification.
export function renderFeatureList(container, features, selected, { element, badge, labels, onSelect }) {
  container.replaceChildren();
  container.append(element("p", "catalog-note", "기능을 선택해 최근 변경과 남은 작업을 확인하세요. 상태는 AI의 당시 보고입니다."));
  if (!features.length) container.append(element("p", "catalog-note", "이 범위에서 일치하는 기능이 없습니다. 기능이 없다는 뜻은 아니며 별칭·경로가 아직 등록되지 않았을 수 있습니다."));
  for (const feature of features) {
    const card = element("button", `feature-card feature-select${feature.key === selected ? " selected" : ""}`);
    card.setAttribute("aria-pressed", String(feature.key === selected));
    card.append(element("strong", "feature-name", feature.name),
      badge(labels[feature.latest_report?.update?.state] || "상태 보고 없음", "feature"),
      element("p", "feature-description", feature.description || "기능 설명 미수집"),
      element("p", "feature-preview", feature.latest_activity?.report?.summary || "최근 변경 요약 없음"));
    card.append(renderMatchReasons(feature,element));
    const next = feature.latest_activity?.report?.next_steps;
    card.append(element("p", "feature-next", next?.length ? `다음 · ${next[0]}` : "남은 작업 보고 없음"),
      element("small", "catalog-note", `연결 작업 ${feature.total ?? 0} · 미완료 ${feature.unfinished ?? 0}`));
    card.addEventListener("click", () => onSelect(feature.key));
    container.append(card);
  }
}

export function renderFeatureDetail(feature, { element, badge, date, labels, onTasks, onReport }) {
  const panel = element("div", "feature-detail");
  panel.append(element("p", "eyebrow", "FEATURE BRIEF"), element("h2", "", feature.name),
    element("p", "feature-purpose", feature.description || "이 기능의 설명은 아직 기록되지 않았습니다."));
  panel.append(renderMatchReasons(feature,element));
  const discovery=element("section","feature-section");discovery.append(element("h3","","찾기에 사용하는 등록 정보"));
  for(const [key,label]of[["aliases","별칭"],["code_paths","코드 경로"]]) {
    const rows=feature.discovery?.[key]||[];
    discovery.append(element("p","catalog-note",`${label} · ${rows.length?rows.map(r=>`${r.value} (${r.repository} / ${r.environment})`).join(" · "):"등록 정보 없음"}`));
  }
  if(feature.discovery?.truncated)discovery.append(element("p","catalog-note","등록 정보 일부만 표시합니다. 검색은 전체 등록 정보를 대상으로 합니다."));
  discovery.append(element("small","catalog-note","AI가 명시적으로 등록한 검색 정보입니다. 실제 파일 존재·코드 실행을 확인한 근거가 아니며 과거 미분류 기록을 자동 연결하지 않습니다."));panel.append(discovery);
  const status = feature.latest_report;
  const state = element("section", "feature-status");
  state.append(badge(labels[status?.update?.state] || "상태 보고 없음", "feature"),
    element("p", "", status?.update?.summary || "작업 종료만으로 기능 완료를 판단하지 않습니다."));
  if (status) state.append(element("small", "catalog-note", `상태 출처 · AI 보고 · 미검증 · ${status.repository} / ${status.environment} · ${date(status.observed_at)}`),
    element("code", "feature-source", `기록 ${status.record_id}`));
  panel.append(state);
  if (feature.projection_truncated) panel.append(element("p", "recovery-note", "응답 크기 제한으로 상세 정보가 생략됐습니다. 연결 작업에서 원문을 확인하세요."));
  const latest = feature.latest_activity, report = latest?.report;
  panel.append(renderValidationEvidence({ checks: report?.checks ?? [], aggregate: feature.execution_evidence,
    partial: Boolean(feature.projection_truncated) }, element),
    element("p", "catalog-note", "기능의 관측 수는 연결 작업 전체 기준이며, AI 검사 보고 수는 현재 표시한 최근 보고 기준입니다."));
  function section(title, content, fallback) {
    const box = element("section", "feature-section");
    box.append(element("h3", "", title));
    if (content?.length) {
      const list = element("ul");
      for (const value of content) list.append(element("li", "", value));
      box.append(list);
    } else box.append(element("p", "catalog-note", fallback));
    panel.append(box);
  }
  const recent = element("section", "feature-section feature-recent");
  recent.append(element("h3", "", "최근 무엇이 바뀌었나요?"),
    element("p", "", report?.summary || "최근 변경을 설명하는 당시 보고가 없습니다. 과거 원문을 임의로 요약하지 않습니다."));
  if (latest) recent.append(element("small", "catalog-note", `연결된 작업의 최근 보고 · ${latest.actor || "작성자 미수집"} · ${latest.repository} / ${latest.environment} · ${date(latest.observed_at)}`),
    element("code", "feature-source", `기록 ${latest.record_id}`));
  panel.append(recent);
  section("변경 내용 · AI 보고", report?.changes, "구체적인 변경 항목이 기록되지 않았습니다.");
  section("남은 작업 · 최근 작업 보고 기준", report?.next_steps, "남은 작업이 기록되지 않았습니다. 할 일이 없거나 기능이 완료됐다는 뜻은 아닙니다.");
  panel.append(element("p", "catalog-note", `종료 기록이 없는 연결 작업 ${feature.unfinished ?? 0}개 · 실행 중이라는 뜻은 아닙니다.`));
  section("제약·확인 필요", report?.limitations, "별도 제약 보고가 없습니다. 제한이 없다는 뜻은 아닙니다.");
  const evidence = element("section", "feature-section feature-evidence");
  evidence.append(element("h3", "", "실제로 확인된 실행 근거"),
    element("p", "", feature.execution_evidence?.status === "observations_available"
      ? `직접 실행 관측 ${feature.execution_evidence.total}건 · 종료 미확인 ${feature.execution_evidence.unconfirmed}건. 연결 작업에서 확인하세요. 기능 검증 완료를 뜻하지 않습니다.`
      : feature.execution_evidence?.status === "not_collected"
        ? "미수집 · 연결 작업에 수집된 실행 결과가 없습니다. 명령 미실행을 뜻하지 않습니다. 아래 AI 보고와 구분합니다."
        : "실행 관측 조회 정보 없음 · 수집 여부를 판단할 수 없습니다. 아래 AI 보고와 구분합니다."),
    element("h4", "", "AI가 보고한 검사 결과 · 미검증"));
  if (report?.checks?.length) {
    const list = element("ul");
    const results = { passed: "통과 보고", failed: "실패 보고", not_run: "미실행 보고" };
    for (const check of report.checks) {
      const item = element("li");
      item.append(element("strong", "", `${results[check.result] || "결과 미수집"} · ${check.name}`));
      if (check.detail) item.append(element("p", "", check.detail));
      list.append(item);
    }
    evidence.append(list);
  } else evidence.append(element("p", "catalog-note", "검사 결과가 보고되지 않았습니다."));
  panel.append(evidence);
  const actions = element("div", "feature-actions");
  const tasks = element("button", "button", "연결 작업 보기"); tasks.addEventListener("click", onTasks); actions.append(tasks);
  if (latest?.run_id) {
    const original = element("button", "button", "최근 보고 원문 보기"); original.addEventListener("click", () => onReport(latest.run_id)); actions.append(original);
  }
  panel.append(actions, element("p", "record-id", `기능 ${feature.key} · 소급 보고와 정정된 기록은 현재 상태·최근 보고를 대체하지 않습니다.`));
  return panel;
}
