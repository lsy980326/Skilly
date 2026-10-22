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
  const title = { observed: "직접 실행 관측 있음", reported: "AI 보고만 있음", unknown: "확인 불가" }[state];
  const detail = state === "observed"
    ? "프로세스 종료 결과가 저장됐습니다. 개별 검사 보고와의 대응이나 기능 검증 완료를 뜻하지 않습니다."
    : !known ? "실행 관측 조회 정보가 없습니다. AI 보고가 있어도 직접 수집 여부를 판단할 수 없습니다."
    : pending ? "시작은 저장됐지만 종료 결과를 확인하지 못한 관측이 있습니다. 실행 중·실패로 단정하지 않습니다."
    : partial ? "아직 읽지 않은 기록이 있습니다. 더 보기로 근거를 확인하세요."
    : reports ? "검사 내용은 AI가 작성한 보고입니다. 조회한 범위에 직접 실행 관측은 없으며, 미실행을 뜻하지 않습니다."
    : "조회한 범위에 구조화된 검사 보고나 종료 관측이 없습니다. 검사를 하지 않았다는 뜻은 아닙니다.";
  return { state, title, detail, reports, observed, pending, partial, known };
}

export function renderValidationEvidence(input, element) {
  const info = validationEvidence(input);
  const section = element("section", `validation-evidence ${info.state}`);
  section.setAttribute("aria-label", "검사 근거");
  const top = element("div", "validation-heading");
  top.append(element("h3", "", "검사 근거"), element("strong", "validation-label", info.title));
  const counts = element("div", "validation-counts");
  counts.append(element("span", "", `AI 검사 보고 ${info.reports}건`),
    element("span", "", info.known ? `종료 관측 ${info.observed}건` : "관측 조회 정보 없음"),
    element("span", "", info.known ? `종료 미확인 ${info.pending}건` : "종료 여부 미조회"));
  section.append(top, element("p", "", info.detail), counts);
  if (info.observed && info.pending) section.append(element("p", "validation-caution", "종료 결과가 없는 관측도 있습니다. 아래 항목을 각각 확인하세요."));
  section.append(element("small", "", "AI 보고와 실행 관측은 별도 근거입니다. 종료 코드 0도 기능 검증 완료를 보장하지 않습니다."));
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
  const section = element("section", "execution-observations");
  const heading = element("div", "timeline-heading");
  heading.append(element("h3", "", "직접 실행 관측"), element("span", "", "로컬 실행기 · AI 보고와 분리"));
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
