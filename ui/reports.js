// Classify available evidence, never the correctness of a test or feature.
export function validationEvidence({ checks = [], executions, aggregate, partial = false }) {
  const reports = checks.filter(check => ["passed", "failed", "not_run"].includes(check.result)).length;
  let known = Array.isArray(executions?.items), observed = 0, pending = 0;
  if (known) {
    for (const item of executions.items) {
      if (["exited", "launch_failed", "timed_out", "interrupted"].includes(item.outcome)) observed++;
      else pending++;
    }
    partial ||= executions.next_offset != null;
  } else if (aggregate && ["observations_available", "not_collected"].includes(aggregate.status)
    && Number.isInteger(aggregate.total) && Number.isInteger(aggregate.unconfirmed)
    && aggregate.unconfirmed >= 0 && aggregate.total >= aggregate.unconfirmed) {
    known = true; pending = aggregate.unconfirmed; observed = aggregate.total - pending;
  }
  const state = observed ? "observed" : !known || pending || partial || !reports ? "unknown" : "reported";
  const title = { observed: "실행 결과가 남아 있어요", reported: "AI 설명만 있어요", unknown: "결과를 확인할 수 없어요" }[state];
  const detail = state === "observed"
    ? "AI의 설명과 별도로, 실행 결과나 시작 실패 이유가 저장됐습니다."
    : !known ? "실행 결과를 불러오지 못했습니다. AI 설명과 구분해서 봐 주세요."
    : pending ? "시작 기록은 있지만 끝난 결과가 없습니다. 실행 중인지 실패했는지는 아직 모릅니다."
    : partial ? "아직 읽지 않은 기록이 있습니다. 더 보기로 근거를 확인하세요."
    : reports ? "검사에 대한 AI의 설명만 있습니다. 명령 실행 결과는 이 기록에서 찾지 못했습니다. 실행하지 않았다는 뜻은 아니에요."
    : "아직 검사 결과가 남아 있지 않습니다. 검사를 하지 않았다는 뜻은 아닙니다.";
  return { state, title, detail, reports, observed, pending, partial, known };
}

export function renderWorkBrief(records, element) {
  const latest = records.find(record => !record.superseded_by && record.report_origin !== "retrospective" && record.report);
  const report = latest?.report;
  const section = element("section", "work-brief");
  section.append(element("span", "eyebrow", "작업 한눈에 보기"), element("p", "brief-summary", report?.summary || "아직 작업 요약이 없습니다. 아래 기록에서 요청과 진행 내용을 확인하세요."));
  for (const [label, items] of [["달라진 점", report?.changes], ["다음 할 일", report?.next_steps]]) {
    if (!items?.length) continue;
    const group = element("div", "brief-group"), list = element("ul");
    group.append(element("h3", "", label));
    for (const text of items.slice(0, 3)) list.append(element("li", "", text));
    group.append(list); section.append(group);
  }
  section.append(element("small", "brief-source", latest ? "최근 AI 작업 보고 · 실행 결과는 아래에서 따로 확인합니다." : "작업 보고가 저장되면 여기에 표시합니다."));
  return section;
}

export function renderValidationEvidence(input, element) {
  const info = validationEvidence(input);
  const section = element("section", `validation-evidence ${info.state}`);
  section.setAttribute("aria-label", "확인한 결과");
  const top = element("div", "validation-heading");
  top.append(element("h3", "", "무엇을 확인했나요?"), element("strong", "validation-label", info.title));
  const counts = element("details", "validation-counts");
  counts.dataset.panel = "validation-counts";
  counts.append(element("summary", "", "확인 방식과 기록 수"));
  counts.append(element("span", "", `AI 검사 보고 ${info.reports}건`),
    element("span", "", info.known ? `종료 관측 ${info.observed}건` : "관측 조회 정보 없음"),
    element("span", "", info.known ? `종료 미확인 ${info.pending}건` : "종료 여부 미조회"));
  section.append(top, element("p", "", info.detail), counts);
  const latest = input.executions?.items?.[0];
  if (latest?.test_details?.status === "collected" && latest.outcome === "exited" && latest.output_complete !== 0) {
    const total = latest.test_details.counts;
    section.append(element("p", `validation-result${total.failed ? " has-failures" : ""}`, `최근 실행 · 통과 ${total.passed} · 실패 ${total.failed}${total.skipped ? ` · 건너뜀 ${total.skipped}` : ""}${total.cancelled ? ` · 취소 ${total.cancelled}` : ""}${total.todo ? ` · 예정 ${total.todo}` : ""}`));
  } else if (latest) {
    const endings = { launch_failed: "시작하지 못했어요.", timed_out: "제한 시간에 도달해 멈췄어요.", interrupted: "중단 결과가 저장됐어요.", unconfirmed: "끝난 결과를 확인하지 못했어요." };
    section.append(element("p", "validation-result", latest.outcome === "exited" ? `최근 명령 · ${latest.exit_code === 0 ? "정상 종료" : "오류로 종료"} · 개별 검사 수는 수집되지 않았습니다.` : `최근 명령 · ${endings[latest.outcome] || endings.unconfirmed}`));
  }
  if (info.observed && info.pending) section.append(element("p", "validation-caution", "종료 결과가 없는 관측도 있습니다. 아래 항목을 각각 확인하세요."));
  counts.append(element("small", "", "AI 보고와 실행 관측은 별도 근거입니다. 종료 코드 0도 기능 검증 완료를 보장하지 않습니다."));
  return section;
}

// This is another view of the saved record, not a generated second report.
export function renderMachineReport(record, task, element, open = false) {
  const panel = element("details", "machine-report");
  panel.dataset.machine = record.id;
  panel.open = open;
  panel.append(element("summary", "", "AI용 구조화 정보"),
    element("p", "catalog-note", "같은 기록의 조회 정보입니다. 명령어·검사 결과는 AI가 작성한 보고이며 자동 검증되지 않았습니다."));
  const data = {
    record_id: record.id, run_id: task.id,
    repository: task.repository, environment: task.environment,
    report_origin: record.report_origin, provenance: "agent_report", verified: false,
    observed_at: record.observed_at, recorded_at: record.recorded_at,
    source_fingerprint: record.source_fingerprint ?? null,
    report: record.report ?? null,
  };
  panel.append(element("pre", "machine-data", JSON.stringify(data, null, 2)));
  return panel;
}

export function renderExecutions(data, { element, date, more }) {
  const section = element("details", "execution-observations");
  section.dataset.panel = "executions";
  section.append(element("summary", "", `검사 자세히 보기 · ${data?.items?.length ?? "조회 못 함"}${data?.items ? "건" : ""}`));
  const heading = element("div", "timeline-heading");
  heading.append(element("h3", "", "명령 실행 결과"), element("span", "", "실제로 실행한 결과"));
  section.append(heading, element("p", "catalog-note", "Skilly 실행기를 거친 명령만 수집합니다. 종료 코드 0은 기능 검증 완료를 뜻하지 않습니다. 인자·출력 원문은 저장하지 않습니다."));
  if (!data?.items?.length) section.append(element("p", "execution-empty", Array.isArray(data?.items)
    ? "수집된 실행 결과 없음 · 명령을 실행하지 않았다는 뜻은 아닙니다."
    : "실행 관측 조회 정보 없음 · 수집 유무와 실행 여부를 판단할 수 없습니다."));
  for (const item of data?.items ?? []) {
    const card = element("article", `execution-card ${item.outcome === "unconfirmed" ? "unconfirmed" : "observed"}`);
    const label = item.outcome === "unconfirmed" ? "종료 관측 없음" : item.outcome === "launch_failed" ? "시작 실패"
      : item.outcome === "timed_out" ? "시간 제한 도달" : item.outcome === "interrupted" ? "중단 관측"
      : item.signal ? `신호 종료 · ${item.signal}` : item.exit_code === 0 ? "정상 종료 · 코드 0" : `비정상 종료 · 코드 ${item.exit_code}`;
    const top = element("div", "execution-top");
    top.append(element("strong", "", item.executable), element("span", "execution-outcome", label));
    card.append(top, element("p", "execution-meta", `${date(item.started_at)}${item.duration_ms === null ? " · 종료 여부 확인 필요" : ` · ${(item.duration_ms / 1000).toFixed(2)}초`}`));
    const version = item.code_version, comparison = version?.comparison;
    const versionPanel = element("details", `execution-version ${comparison?.status ?? "unknown"}`);
    versionPanel.dataset.panel = `version-${item.id}`;
    versionPanel.setAttribute("aria-label", "검사 당시 코드와 현재 코드 비교");
    const versionLabels = { same_version: "검사 때와 같은 코드예요", changed: "검사 뒤 코드가 바뀌었어요", unknown: "지금 코드에도 같은 결과일까요?" };
    const versionReasons = { legacy_not_collected: "이전 기록에는 검사 당시 코드 정보가 없습니다. 검사 실패라는 뜻은 아닙니다.", execution_unfinished: "실행 종료 시점의 코드 버전을 확인하지 못했습니다.",
      source_unavailable: "Git 버전 정보를 확인할 수 없습니다.", execution_scope_mismatch: "실행 전후의 프로젝트 범위가 다릅니다.",
      changed_during_execution: "실행 도중 커밋이 바뀌었습니다.", uncommitted_changes: "저장소에 커밋되지 않은 수정이 있어 검사 때와 같은 코드인지 판단하지 않습니다. 검사 실패라는 뜻은 아닙니다.",
      comparison_root_not_configured: "현재 코드와 비교할 프로젝트 폴더가 지정되지 않았습니다.", comparison_scope_mismatch: "비교 대상 프로젝트 범위가 다릅니다.",
      different_commit: "검사 당시와 현재 커밋이 다릅니다.", matching_clean_observations: "실행 전·후와 조회 시점에 변경 없는 같은 커밋을 관측했습니다." };
    versionPanel.append(element("summary", "", versionLabels[comparison?.status] ?? versionLabels.unknown),
      element("p", "", versionReasons[comparison?.reason] ?? "버전 비교 정보가 없습니다."));
    if (version?.before?.commit) versionPanel.append(element("code", "", `검사 전 ${version.before.commit.slice(0, 12)} · 검사 후 ${version.after?.commit?.slice(0, 12) ?? "미확인"} · 현재 ${version.current?.commit?.slice(0, 12) ?? "미확인"}`));
    if (comparison?.checked_at) versionPanel.append(element("small", "", `비교 시각 ${date(comparison.checked_at)}`));
    versionPanel.append(element("small", "", "Git 버전의 관측 비교입니다. 무시된 파일·의존성·실행환경과 기능 검증은 포함하지 않습니다."));

    card.append(element("small", "", `관측한 출력 ${item.stdout_bytes}B / 오류 출력 ${item.stderr_bytes}B · 원문 미보관`));
    if (item.output_complete === 0) card.append(element("p", "catalog-note", "출력 스트림을 끝까지 확인하지 못했습니다. 크기·해시는 관측한 범위만 나타냅니다."));
    const details = item.test_details;
    if (details?.status === "collected") {
      const tests = element("section", "test-results");
      tests.setAttribute("aria-label", "수집된 검사 상세");
      tests.append(element("strong", "", `검사 상세 수집 · ${details.framework === "vitest" ? "Vitest" : "Node.js"}`));
      const counts = element("div", "test-counts");
      for (const [key, label] of [["passed", "통과"], ["failed", "실패"], ["cancelled", "취소"], ["skipped", "건너뜀"], ["todo", "예정"]]) {
        counts.append(element("span", `test-count ${key}`, `${label} ${details.counts[key]}`));
      }
      tests.append(counts, element("small", "", `테스트 ${details.counts.tests}개 · 스위트 ${details.counts.suites}개 · 실행기 종합 판정: ${details.suite_success ? "성공" : "실패"}`));
      if (details.failures.length) {
        const list = element("ul", "test-failures");
        for (const name of details.failures) list.append(element("li", "", name));
        tests.append(element("h4", "", "실패 항목"), list);
      }
      if (details.failures_truncated) tests.append(element("p", "catalog-note", "실패 이름은 최대 20개·각 200자입니다. 일부 항목 또는 이름이 생략됐습니다."));
      tests.append(element("p", "catalog-note", "테스트 실행기의 집계입니다. 실패 목록에는 상위 테스트·스위트가 함께 나올 수 있습니다. 기능 검증 완료를 뜻하지 않습니다."));
      card.append(tests);
    } else {
      const reason = { unsupported_command: "지원 대상이 아닌 명령 또는 별도 리포터 사용", legacy: "이전 관측에는 검사 상세가 없음", unfinished: "종료 결과 미확인",
        missing_summary: "최종 테스트 집계 없음", interrupted: "중단 또는 불완전한 수집", invalid_report: "올바른 집계를 확인하지 못함", limit_exceeded: "수집 크기 제한 초과" }[details?.reason] ?? "상세 조회 정보 없음";
      card.append(element("p", "test-unavailable", `검사 상세 미수집 · ${reason}. 통과·실패 0개라는 뜻은 아닙니다.`));
    }
    card.append(versionPanel);
    if (item.record_id) card.append(element("code", "feature-source", `연결된 AI 기록 ${item.record_id}`));
    const raw = element("details", "machine-report");
    raw.append(element("summary", "", "실행 관측 정보·ID"), element("pre", "machine-data", JSON.stringify(item, null, 2)));
    card.append(raw); section.append(card);
  }
  if (data?.next_offset !== null && data?.next_offset !== undefined) {
    const button = element("button", "button more", "실행 결과 더 보기");
    button.addEventListener("click", more); section.append(button);
  }
  return section;
}
