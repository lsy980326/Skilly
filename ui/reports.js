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
  if (!data?.items?.length) section.append(element("p", "execution-empty", "수집된 실행 결과 없음 · 명령을 실행하지 않았다는 뜻은 아닙니다."));
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
