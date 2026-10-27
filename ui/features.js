import { renderValidationEvidence } from "./reports.js";
import { renderComponentTags } from "./component-scope.js";

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
    card.append(renderComponentTags(feature,element));
    const knowledge = feature.current_knowledge;
    card.append(badge(knowledgeLabels[knowledge?.status] || "근거 미확인", knowledge?.status === "conflict" ? "warning" : "feature"));
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
  panel.append(renderFeatureKnowledge(feature.current_knowledge, { element, badge, date, onReport }));
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


const knowledgeLabels = { current: "현재 버전 근거 있음", stale: "오래된 검사", conflict: "검사 결과 충돌", unknown: "근거 미확인" };
const knowledgeReasons = {
  opposing_test_observations: "같은 코드 버전·명령에서 통과와 실패가 함께 관측됐습니다. 최근 성공만으로 충돌을 덮지 않습니다.",
  observation_limit_exceeded: "조회 상한을 넘어 전체 근거를 판정하지 못했습니다. 연결 작업에서 확인하세요.",
  incomparable_observations: "현재 코드와 비교할 수 없거나 검사 결과가 불완전한 관측이 있습니다.",
  compatible_test_observations: "허용된 프로젝트 경로에서 현재 Git 버전과 비교 가능한 검사 관측이 있습니다.",
  source_version_changed: "검사 당시와 현재 코드 버전이 달라 당시 결과를 현재 성공으로 재사용할 수 없습니다.",
  no_direct_test_observations: "직접 수집된 검사 근거가 없습니다. AI의 구현·검사 보고만으로 확정하지 않습니다.",
};
const evidenceReasons = { source_not_clean: "코드가 dirty 또는 관측 불가 상태", matching_clean_observations: "현재 커밋과 일치", different_commit: "현재 커밋이 달라짐",
  changed_during_execution: "실행 중 커밋 변경", uncommitted_changes: "미커밋 변경으로 비교 불가",
  matching_source_fingerprints: "수집한 소스 내용 일치", source_fingerprint_changed: "검사 후 소스 변경", source_changed_during_execution: "검사 중 소스 변경",
  fingerprint_inventory_limit_exceeded: "파일 목록 수집 한도 초과", fingerprint_source_file_limit_exceeded: "공개 코드 2,048개 한도 초과", fingerprint_limit_exceeded: "소스 수집 한도 초과", fingerprint_excluded_changes: "제외 파일 변경으로 확인 필요", fingerprint_unsafe_entry: "안전하게 읽을 수 없는 항목",
  fingerprint_unstable: "수집 중 소스 변경", fingerprint_read_failed: "소스 지문 읽기 실패",
  comparison_root_not_configured: "비교할 프로젝트 경로 미설정", legacy_not_collected: "당시 코드 정보 없음",
  execution_unfinished: "실행 종료·코드 정보 불완전", test_verdict_unavailable: "검사 상세·정상 종료 근거 부족",
  source_unavailable: "코드 관측 불가", execution_scope_mismatch: "실행 범위 불일치", comparison_scope_mismatch: "현재 비교 범위 불일치" };
export function renderFeatureKnowledge(knowledge, { element, badge, date, onReport }) {
  const box = element("section", "feature-knowledge");
  box.append(element("h3", "", "지금 판단할 수 있는 근거"),
    badge(knowledgeLabels[knowledge?.status] || "근거 미확인", knowledge?.status === "conflict" ? "warning" : "feature"),
    element("p", "", knowledgeReasons[knowledge?.reason] || "조회 정보가 없거나 생략돼 현재 근거를 판정할 수 없습니다."));
  const counts = knowledge?.counts;
  if (counts) box.append(element("p", "catalog-note", `관측 기준 · 현재 버전 ${counts.current}건 · 오래됨 ${counts.stale}건 · 미확인 ${counts.unknown}건 · 현재 통과 ${counts.passed} / 실패 ${counts.failed}`));
  box.append(element("p", "catalog-note", "이 판정은 검사 근거의 코드 버전 적합성입니다. 기능 전체의 정상 동작·배포·의존성·실행환경을 검증하지 않으며 AI 보고를 확정 사실로 승격하지 않습니다."));
  if (knowledge?.conflicts?.length) {
    const list = element("ul", "knowledge-conflicts");
    for (const conflict of knowledge.conflicts) list.append(element("li", "", `충돌 · ${conflict.repository} / ${conflict.environment} · ${conflict.commit?.slice(0, 12) || "버전 미확인"} · 실행 ${conflict.execution_ids.join(", ")}${conflict.ids_truncated ? " (일부 표시)" : ""}`));
    box.append(list);
  }
  const results = { passed: "통과 관측", failed: "실패 관측", unknown: "결과 미확인" };
  for (const row of knowledge?.evidence || []) {
    const item = element("div", "knowledge-evidence");
    item.append(element("strong", "", `${knowledgeLabels[row.status] || "근거 미확인"} · ${results[row.result] || "결과 미확인"}`),
      element("p", "catalog-note", `${evidenceReasons[row.reason] || "비교 불가"} · ${row.repository} / ${row.environment} · 검사 커밋 ${row.commit?.slice(0, 12) || "없음"} / 현재 ${row.current_commit?.slice(0, 12) || "미확인"}`));
    if (row.comparison?.public_source) item.append(element("p", "catalog-note", row.comparison.public_source.status === "same_version"
      ? "비교한 공개 코드는 같아요. 제외 파일과 실행환경은 별도 확인이 필요합니다."
      : "비교한 공개 코드가 달라졌어요."));
    if (row.comparison?.excluded_changes) {
      const excluded = row.comparison.excluded_changes;
      item.append(element("p", "catalog-note", `제외 파일 변경 · 검사 전 ${excluded.before ?? "미확인"} / 후 ${excluded.after ?? "미확인"} / 현재 ${excluded.current ?? "미확인"}개 · 내용 미수집`));
    }
    if (row.counts) item.append(element("p", "catalog-note", `검사 ${row.counts.tests} · 통과 ${row.counts.passed} / 실패 ${row.counts.failed} / 취소 ${row.counts.cancelled} / 건너뜀 ${row.counts.skipped}`));
    item.append(element("code", "feature-source", `실행 ${row.execution_id} · 작업 ${row.run_id}`));
    if (row.comparison?.checked_at) item.append(element("small", "catalog-note", `비교 시각 ${date(row.comparison.checked_at)}`));
    const button = element("button", "button", "근거 작업 보기"); button.addEventListener("click", () => onReport(row.run_id)); item.append(button);
    box.append(item);
  }
  if (knowledge?.truncated || knowledge?.evidence_truncated || knowledge?.conflicts_truncated) box.append(element("p", "recovery-note", "근거 일부 표시 · 조회 범위와 표시 상한을 확인하세요. 생략은 성공을 뜻하지 않습니다."));
  return box;
}
