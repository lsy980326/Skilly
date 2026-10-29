export function renderTaskRecording(data, { element, date }) {
  const panel = element("section", "task-recording");
  panel.setAttribute("aria-label", "작업 연결과 저장 지점");
  panel.append(element("h3", "", "어디까지 저장됐나요"));
  if (!data) { panel.append(element("p", "catalog-note", "현재 서버에서 연결 정보를 제공하지 않습니다.")); return panel; }
  if (data.event_retention) panel.append(renderEventRetention(data.event_retention, { element }));
  const history = data.imported_history;
  const saved = data.last_saved ?? {};
  const steps = element("div", "recording-track");
  const labels = { PostToolUse: "도구 실행 후", Stop: "턴 종료", Interrupt: "사용자 중단", SessionStart: "세션 시작", PreCompact: "대화 압축 전", SessionEnd: "세션 종료" };
  for (const [label, value] of [
    ["지금 확인되는 저장", saved.stage === "start" ? "시작 저장 확인" : saved.record_id ? `기록 #${saved.seq} · ${date(saved.recorded_at)}` : "저장 근거 확인 불가"],
    [data.linkage === "historical_retained" ? "보관된 연결의 마지막 이벤트" : "현재 연결의 마지막 이벤트", data.latest_event ? `${labels[data.latest_event.event] ?? data.latest_event.event} · ${date(data.latest_event.received_at)}` : "연결된 이벤트 없음"],
    [data.linkage === "historical_retained" ? "보관된 중단 관측" : "현재 연결의 중단 관측", data.interruption ? date(data.interruption.received_at) : "확인된 중단 이벤트 없음"],
  ]) {
    const step = element("div", "recording-track-step");
    step.append(element("small", "", label), element("strong", "", value)); steps.append(step);
  }
  panel.append(steps);
  panel.append(element("p", "catalog-note", data.linkage === "explicit_agent_binding" ? "이 작업에 명시적으로 연결됨"
    : data.linkage === "historical_retained" ? "이전 연결은 보관됐습니다. 새 관측으로 연결을 갱신해야 이후 이벤트가 이 작업에 연결됩니다."
    : data.linkage === "unavailable" ? "연결 정보 조회 실패" : "세션과 작업이 연결되지 않음"));
  const savedPoint = (section, interrupt) => {
    if (!interrupt) return;
    const at = interrupt.saved_during_event ?? {};
    section.classList.add("has-interruption");
    section.append(element("p", "recording-interrupt", at.record_id
      ? `중단 처리 중 확인한 저장 지점: 기록 #${at.seq} (${at.record_id})`
      : at.stage === "start" ? "중단 처리 중 시작 저장까지만 확인했습니다." : "중단 당시 저장 지점을 확인하지 못했습니다."));
    if (at.source_seq !== undefined && at.source_seq !== at.seq) section.append(element("small", "recording-id", `이전 DB 순번 #${at.source_seq} · 현재 사본 순번 #${at.seq} · 기록 ID는 같습니다`));
  };
  savedPoint(panel, data.interruption);
  if (history) {
    const historical = element("section", "imported-recording");
    historical.setAttribute("aria-label", "가져온 이벤트 이력");
    historical.append(element("h4", "", "이전 위치에서 가져온 이력"), element("p", "catalog-note", "현재 세션 연결이나 실제 실행을 뜻하지 않습니다."));
    const latest = history.latest_event;
    historical.append(element("p", "catalog-note", latest ? `가져온 이력의 마지막 이벤트: ${labels[latest.event] ?? latest.event} · ${date(latest.received_at)}` : "가져온 연결 이벤트 없음"));
    savedPoint(historical, history.interruption);
    if (history.association_unconfirmed) historical.append(element("p", "recovery-note", `가져온 이력 중 연결 확인 불가 ${history.association_unconfirmed}건 · 자동 재시도하지 않습니다.`));
    panel.append(historical);
  }
  if (saved.record_id) panel.append(element("small", "recording-id", `마지막 기록 ID ${saved.record_id} · ${saved.receipt_confirmed ? "영수증 확인" : "DB 기록 확인 · 영수증 미확인"}`));
  if (data.association_unconfirmed) panel.append(element("p", "recovery-note", `작업 연결을 확인하지 못한 이벤트 ${data.association_unconfirmed}건 · 복구 대기라는 뜻은 아닙니다.`));
  panel.append(element("p", "catalog-note", "중단 이력은 현재 실행 여부나 저장 누락을 뜻하지 않습니다. 연결 전 기록은 추정하지 않으며, 저장 확인은 내용 검증과 다릅니다."));
  return panel;
}

export function renderEventRetention(data, { element }) {
  const box = element("section", "event-retention");
  box.setAttribute("aria-label", "훅 이벤트 보관 상태");
  if (!Number.isSafeInteger(data.total_events)) {
    box.append(element("h4", "", "훅 이벤트 보관 상태"), element("p", "catalog-note", data.capture_status === "not_observed"
      ? "이벤트 저장소가 아직 없습니다. 누락이 없다는 뜻은 아닙니다." : "보관 상태를 조회하지 못했습니다. 수집 가능 여부와 누락 수는 알 수 없습니다."));
    return box;
  }
  const labels = { ready: "수신 가능", rollover_ready: "새 구간으로 계속 수신", activation_required: "수집 중단 · 기존 1만 건 한도",
    retention_full: "수집 중단 · 보관 구간 한도", storage_full: "수집 중단 · DB 용량 한도" };
  const stopped = ["activation_required","retention_full","storage_full"].includes(data.capture_status);
  box.classList.toggle("is-stopped", stopped);
  box.append(element("h4", "", "훅 이벤트 보관 상태"), element("strong", "event-retention-state", labels[data.capture_status] ?? "수집 상태 확인 불가"));
  const number = value => typeof value === "number" ? value.toLocaleString("ko-KR") : "?";
  box.append(element("p", "", `현재 구간 ${number(data.active_events)} / ${number(data.window_limit)}건 · 과거 보관 ${number(data.archived_events)}건`));
  const meter = element("meter", "event-retention-meter");
  meter.min = 0; meter.max = data.window_limit; meter.value = data.active_events;
  meter.setAttribute("aria-label", "현재 수집 구간 사용량"); box.append(meter);
  box.append(element("small", "catalog-note", `전체 ${number(data.total_events)}건 · 구간 ${number(data.windows)} / ${number(data.max_windows)} · DB 본체 ${(data.body_bytes/1048576).toFixed(1)} / ${(data.body_limit_bytes/1048576).toFixed(0)} MiB`));
  if (data.task_link_status === "full") box.append(element("p", "recovery-note", "작업 연결 한도에 도달했습니다. 새 작업 연결은 저장되지 않으며 기존 연결은 보존됩니다."));
  if (stopped) box.append(element("p", "recovery-note", "새 이벤트는 저장·대기되지 않습니다. 받지 못한 이벤트의 수와 내용은 알 수 없습니다."));
  box.append(element("p", "catalog-note", "모든 프로젝트가 공유하는 훅 저장소 수치입니다. 작업일지 저장 상태와 다르며, 용량에는 임시 파일이 포함되지 않습니다. 자동 삭제하지 않습니다."));
  return box;
}
