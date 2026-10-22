// A file remains in the browser until its reviewed text is explicitly imported.
export function createDocumentImport({ document, request, onSaved }) {
  const node = (tag, className = "", text) => {
    const n = document.createElement(tag); n.className = className;
    if (text !== undefined) n.textContent = text; return n;
  };
  const dialog = node("dialog", "document-import");
  dialog.setAttribute("aria-labelledby", "document-import-title");
  const header = node("header", "import-heading"), title = node("h2", "", "문서 가져오기"); title.id = "document-import-title";
  const close = node("button", "button quiet", "닫기");
  header.append(node("div", "eyebrow", "DOCUMENT → MEMORY"), close, title,
    node("p", "", "선택한 원문을 그대로 보관합니다. 파일을 옮기거나 내용을 검증하지 않습니다."));
  const steps = node("ol", "import-steps");
  const stepNodes = ["파일 선택", "원문 미리보기", "소급 기록 저장"].map(text => { const n = node("li", "", text); steps.append(n); return n; });
  const grid = node("div", "import-grid"), controls = node("div", "import-controls");
  const destination = node("p", "import-destination");
  const field = (caption, input) => { const label = node("label", "import-field"); label.append(node("span", "", caption), input); return label; };
  const target = node("select"); target.setAttribute("aria-label", "저장할 작업 공간");
  const newScope = node("div", "import-new-scope"); newScope.hidden = true;
  const repository = node("input"); repository.type = "text"; repository.maxLength = 100; repository.placeholder = "예: main"; repository.setAttribute("aria-label", "새 작업 공간 저장소");
  const environment = node("input"); environment.type = "text"; environment.maxLength = 100; environment.placeholder = "예: development"; environment.setAttribute("aria-label", "새 작업 공간 환경");
  newScope.append(field("저장소 이름", repository), field("환경 이름", environment), node("small", "", "서비스 공통 위치로 저장합니다. 폴더 연결이나 기존 설정은 변경하지 않습니다."));
  const file = node("input"); file.type = "file"; file.accept = ".md,.markdown,text/markdown"; file.setAttribute("aria-label", "Markdown 파일 선택");
  const path = node("input"); path.type = "text"; path.maxLength = 300; path.setAttribute("aria-label", "문서 이름");
  const previewButton = node("button", "button", "원문 미리보기");
  const caution = node("p", "import-caution", "소급 · 미검증으로 저장합니다. 과거 문서의 주장은 현재 기능 상태나 검사 성공으로 처리하지 않습니다.");
  controls.append(destination, field("저장할 작업 공간", target), newScope, field("Markdown 파일 · 최대 48 KiB", file), field("문서 이름", path),
    node("small", "", "파일 선택 시 실제 폴더 경로는 전달되지 않습니다. 문서 이름은 출처를 구분하기 위한 표기입니다."), previewButton, caution);
  const previewPane = node("section", "import-preview");
  const meta = node("p", "import-preview-meta", "파일을 선택하고 원문을 확인해 주세요.");
  const original = node("pre", "import-original", "아직 선택한 원문이 없습니다."); original.setAttribute("aria-label", "선택한 문서 원문"); original.tabIndex = 0;
  previewPane.append(node("h3", "", "원문 미리보기"), meta, original); grid.append(controls, previewPane);
  const footer = node("footer", "import-footer"), status = node("p", "import-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const save = node("button", "button primary", "소급 기록으로 가져오기"), view = node("button", "button", "저장된 기록 보기"); view.hidden = true;
  footer.append(status, view, save); dialog.append(header, steps, grid, footer); document.body.append(dialog);
  let project, targets = [], text = null, reviewed = null, saved = null, busy = false, generation = 0;
  function step(index) { stepNodes.forEach((n, i) => { n.className = i === index ? "current" : i < index ? "done" : ""; n.setAttribute("aria-current", i === index ? "step" : "false"); }); }
  function enable() { target.disabled = busy; repository.disabled = busy; environment.disabled = busy; file.disabled = busy; path.disabled = busy; close.disabled = busy; previewButton.disabled = busy || text === null || (!targets.length && target.value !== "new"); save.disabled = busy || !reviewed || Boolean(saved); }
  function invalidate() { reviewed = null; saved = null; view.hidden = true; meta.textContent = "문서나 저장 위치가 바뀌었습니다. 원문 미리보기를 다시 눌러 주세요."; status.textContent = "아직 DB에 저장하지 않았습니다."; step(0); enable(); }
  function payload() { if (target.value === "new") {
    if (!repository.value.trim() || !environment.value.trim()) throw new Error("새 작업 공간의 저장소와 환경 이름을 입력해 주세요.");
    return { project_id: project.id, target_scope: { repository: repository.value.trim(), environment: environment.value.trim() }, component_key: "", path: path.value, text };
  } const t = targets[Number(target.value)]; if (!t) throw new Error("저장할 작업 공간을 선택해 주세요."); return { project_id: project.id, target_run_id: t.id, component_key: t.component_key, path: path.value, text }; }
  async function action(work) {
    if (busy) return; busy = true; enable();
    try { await work(); } catch (error) { status.textContent = error.message || "연결을 확인한 뒤 같은 문서로 다시 시도해 주세요."; }
    finally { busy = false; enable(); }
  }
  file.addEventListener("change", async () => {
    invalidate(); const version = ++generation, selected = file.files?.[0]; text = null; original.textContent = "아직 선택한 원문이 없습니다."; enable();
    if (!selected) return;
    try {
      if (selected.size > 49152) throw new Error("48 KiB 이하의 문서를 선택해 주세요.");
      const bytes = await selected.arrayBuffer();
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (version !== generation) return;
      text = decoded; path.value = selected.name; original.textContent = decoded; meta.textContent = `${selected.name} · ${bytes.byteLength}B · 브라우저에서 읽음`;
      status.textContent = "원문을 확인한 뒤 미리보기해 주세요. 아직 DB에 저장하지 않았습니다."; enable();
    } catch { if (version === generation) { status.textContent = selected.size > 49152 ? "48 KiB 이하의 문서를 선택해 주세요." : "UTF-8 문서를 읽지 못했습니다. 파일 인코딩을 확인해 주세요."; enable(); } }
  });
  path.addEventListener("input", invalidate); repository.addEventListener("input", invalidate); environment.addEventListener("input", invalidate);
  target.addEventListener("change", () => { newScope.hidden = target.value !== "new"; invalidate(); });
  previewButton.addEventListener("click", () => action(async () => {
    const input = payload(); status.textContent = "원문과 저장 위치를 확인하는 중…";
    const result = await request("/api/documents/preview", { method: "POST", body: JSON.stringify(input) });
    reviewed = { input, token: result.preview_token }; step(1);
    meta.textContent = `${result.source.bytes}B · ${result.parts}개 원문 조각 · SHA-256 ${result.source.sha256}`;
    status.textContent = "미리보기 완료. 원본을 보존하고 소급·미검증 자료로 저장할 준비가 됐습니다. 아직 저장하지 않았습니다.";
  }));
  save.addEventListener("click", () => action(async () => {
    if (!reviewed) return;
    status.textContent = "확인한 원문을 저장하는 중…"; step(2);
    saved = await request("/api/documents/import", { method: "POST", body: JSON.stringify({ ...reviewed.input, preview_token: reviewed.token }) });
    status.textContent = "가져오기 완료 · 소급·미검증으로 저장했습니다. 원본 파일은 그대로입니다.";
    stepNodes.forEach(n => { n.className = "done"; n.setAttribute("aria-current", "false"); }); view.hidden = false;
  }));
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  view.addEventListener("click", () => { if (saved) { dialog.close(); void onSaved(project.id, saved.run_id); } });
  return { async open(selected) {
    if (!selected?.id) return; generation++; project = selected; text = null; repository.value = ""; environment.value = ""; newScope.hidden = true; file.value = ""; path.value = ""; targets = []; target.replaceChildren(); invalidate(); original.textContent = "아직 선택한 원문이 없습니다.";
    destination.textContent = `저장할 서비스 · ${project.name}`; dialog.showModal();
    await action(async () => {
      const data = await request(`/api/documents/targets?project=${project.id}`); targets = data.items;
      targets.forEach((t, i) => { const option = node("option", "", `${t.component_name} · ${t.repository} / ${t.environment}`); option.value = String(i); target.append(option); });
      if (!data.unavailable) { const option = node("option", "", "새 작업 공간 · 서비스 공통"); option.value = "new"; target.append(option); }
      target.value = targets.length ? String(Math.max(0, targets.findIndex(t => !t.component_key))) : data.unavailable ? "" : "new";
      newScope.hidden = target.value !== "new";
      status.textContent = targets.length ? "문서 한 개를 선택해 주세요. 선택만으로 DB에 저장하지 않습니다." : data.unavailable || "첫 문서를 저장할 작업 공간의 저장소와 환경 이름을 입력해 주세요. 미리보기만으로 기록은 생기지 않습니다.";
      if (data.truncated) status.textContent += " 저장 위치는 앞의 100개만 표시합니다.";
    });
  } };
}
