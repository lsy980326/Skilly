export function renderTaskRecording(data, { element, date }) {
  const panel = element("section", "task-recording");
  panel.setAttribute("aria-label", "작업 연결과 저장 지점");
  panel.append(element("h3", "", "어디까지 저장됐나요"));
  if (!data) { panel.append(element("p", "catalog-note", "현재 서버에서 연결 정보를 제공하지 않습니다.")); return panel; }
  const saved = data.last_saved ?? {}, interrupt = data.interruption;
  const steps = element("div", "recording-track");
  const labels = { PostToolUse: "도구 실행 후", Stop: "턴 종료", Interrupt: "사용자 중단", SessionStart: "세션 시작", PreCompact: "대화 압축 전", SessionEnd: "세션 종료" };
  for (const [label, value] of [
    ["지금 확인되는 저장", saved.stage === "start" ? "시작 저장 확인" : saved.record_id ? `기록 #${saved.seq} · ${date(saved.recorded_at)}` : "저장 근거 확인 불가"],
    ["연결된 마지막 이벤트", data.latest_event ? `${labels[data.latest_event.event] ?? data.latest_event.event} · ${date(data.latest_event.received_at)}` : "연결된 이벤트 없음"],
    ["중단 관측", interrupt ? date(interrupt.received_at) : "확인된 중단 이벤트 없음"],
  ]) {
    const step = element("div", "recording-track-step");
    step.append(element("small", "", label), element("strong", "", value)); steps.append(step);
  }
  panel.append(steps);
  panel.append(element("p", "catalog-note", data.linkage === "explicit_agent_binding" ? "이 작업에 명시적으로 연결됨"
    : data.linkage === "unavailable" ? "연결 정보 조회 실패" : "세션과 작업이 연결되지 않음"));
  if (interrupt) {
    const at = interrupt.saved_during_event ?? {};
    panel.classList.add("has-interruption");
    panel.append(element("p", "recording-interrupt", at.record_id
      ? `중단 처리 중 확인한 저장 지점: 기록 #${at.seq} (${at.record_id})`
      : at.stage === "start" ? "중단 처리 중 시작 저장까지만 확인했습니다." : "중단 당시 저장 지점을 확인하지 못했습니다."));
  }
  if (saved.record_id) panel.append(element("small", "recording-id", `마지막 기록 ID ${saved.record_id} · ${saved.receipt_confirmed ? "영수증 확인" : "DB 기록 확인 · 영수증 미확인"}`));
  if (data.association_unconfirmed) panel.append(element("p", "recovery-note", `작업 연결을 확인하지 못한 이벤트 ${data.association_unconfirmed}건 · 복구 대기라는 뜻은 아닙니다.`));
  panel.append(element("p", "catalog-note", "중단 이력은 현재 실행 여부나 저장 누락을 뜻하지 않습니다. 연결 전 기록은 추정하지 않으며, 저장 확인은 내용 검증과 다릅니다."));
  return panel;
}
