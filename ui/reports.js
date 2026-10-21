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
