import { createFactoryScene } from "./factory-scene.js";

// Animation follows saved states. Opening a part never acknowledges its completion.
export function createSimpleDashboard({ root, request, element, svgElement, relativeTime, onOpen, onAcknowledged }) {
  const cache = new Map(), cards = new Map(), selections = new Map();
  let epoch = 0, fingerprint = "", baseline = true, motionPaused = false;
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const entry of entries) entry.target.workshopMotion?.setVisible(entry.isIntersecting);
  }) : null;
  const recent = (a, b) => String(b.updated_at || b.last_activity || "").localeCompare(String(a.updated_at || a.last_activity || "")) || a.id.localeCompare(b.id);
  const pageView = page => ({ next_offset: page.next_offset, filtered_total: page.filtered_total, items: page.items.map(task => ({
    id: task.id, title: task.title, goal: task.goal, updated_at: task.updated_at, actor: task.actor,
    components: task.components, features: task.features, latest_report: task.latest_report ? { summary: task.latest_report.summary } : null,
  })) });
  const dispose = card => card?.scenes.forEach(scene => scene.workshopMotion?.dispose());
  function inspect(project, id, trigger) {
    const message = cards.get(project.id)?.selectionMessage; if (message) message.textContent = "";
    selections.set(project.id, { id, trigger }); updateInspector(project);
    cards.get(project.id)?.inspector.focus?.({ preventScroll: true });
    cards.get(project.id)?.inspector.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }
  function updateInspector(project) {
    const card = cards.get(project.id), data = cache.get(project.id), selected = selections.get(project.id);
    if (!card) return;
    const task = [...(data?.active?.items || []), ...(data?.completed?.items || [])].find(task => task.id === selected?.id);
    const inspectorSignature = JSON.stringify([task, data?.error, selected?.id]);
    if (card.inspectorSignature === inspectorSignature) return;
    card.inspectorSignature = inspectorSignature;
    const panel = card.inspector;
    if (!task) {
      const restoreFocus = panel.matches?.(":focus-within");
      panel.hidden = true;
      if (selected) card.selectionMessage.textContent = "선택한 작업이 현재 목록에서 빠졌습니다. 이전 기록은 상세보기에서 볼 수 있어요.";
      selections.delete(project.id);
      if (restoreFocus) card.listing.children[0].focus?.();
      return;
    }
    panel.hidden = false;
    const completed = data.completed.items.some(item => item.id === task.id);
    const scope = [...(task.components || []).map(x => x.name), ...(task.features || []).map(x => x.name)].join(" · ");
    const fillMeta = node => { node.replaceChildren(element("span", "", `${scope ? scope + " · " : ""}${task.actor || "작성자 정보 없음"} · `), relativeTime(task.updated_at)); };
    if (card.inspectorView?.id === task.id && card.inspectorView.completed === completed) {
      card.inspectorView.title.textContent = task.title || task.goal;
      card.inspectorView.summary.textContent = task.latest_report?.summary || "아직 요약이 없습니다. 상세 기록에서 작업 요청을 볼 수 있습니다.";
      fillMeta(card.inspectorView.meta); return;
    }
    panel.replaceChildren();
    const heading = element("div", "factory-inspector-heading"), close = element("button", "button", "닫기");
    close.addEventListener("click", () => { const trigger = selections.get(project.id)?.trigger; panel.hidden = true; const current = cards.get(project.id); if (current) current.inspectorSignature = null; selections.delete(project.id); trigger?.focus?.(); });
    heading.append(element("span", "factory-scope", completed ? "완료 · 아직 확인하지 않음" : "진행중으로 저장됨"), close);
    const title = element("h4", "", task.title || task.goal), summary = element("p", "factory-inspector-summary", task.latest_report?.summary || "아직 요약이 없습니다. 상세 기록에서 작업 요청을 볼 수 있습니다.");
    const meta = element("p", "factory-scope"); fillMeta(meta);
    panel.append(heading, title, summary, meta);
    card.inspectorView = { id: task.id, completed, title, summary, meta };
    const actions = element("div", "factory-inspector-actions"), detail = element("button", "button factory-open-detail", "상세 기록 보기 →");
    detail.addEventListener("click", () => onOpen(project.id, task.id)); actions.append(detail);
    if (completed) {
      const acknowledge = element("button", "button acknowledge-task", "확인 완료"), feedback = element("p", "factory-review-feedback");
      feedback.setAttribute("role", "status");
      acknowledge.addEventListener("click", async () => {
        acknowledge.disabled = true; feedback.textContent = "확인 상태 저장 중…";
        try {
          const latest = cache.get(project.id)?.completed?.items.find(item => item.id === task.id);
          if (!latest) throw new Error("보관함이 바뀌었습니다. 다시 확인해 주세요.");
          await request("/api/runs/acknowledge", { method: "POST", body: JSON.stringify({ project_id: project.id, run_id: task.id, expected_updated_at: latest.updated_at }) });
          feedback.textContent = "보관함에서 정리했습니다. 기록은 그대로 남습니다."; await onAcknowledged();
        } catch (error) { feedback.textContent = error.message || "저장하지 못했습니다. 다시 눌러주세요."; acknowledge.disabled = false; }
      });
      actions.append(acknowledge); panel.append(element("small", "factory-review-note", "확인 완료는 이 DB의 보관함에서만 정리합니다. 기록 삭제나 내용 검증은 아닙니다."), feedback);
    }
    panel.append(actions);
  }
  function buildFloor(project, data, previous) {
    const floor = previous?.floor || element("div", "factory-floor");
    const lines = previous?.lines || element("div", "assembly-lines"), laneCache = new Map(), desired = [], scenes = [];
    const makeScene = (task, transfer) => {
      const key = `${transfer ? "delivery" : "active"}-${task?.id || "idle"}`;
      const signature = JSON.stringify([task?.id, task?.title, task?.goal, task?.components, data.error]);
      const existing = previous?.laneCache.get(key);
      if (existing?.signature === signature) { laneCache.set(key, existing); desired.push(existing.lane); scenes.push(existing.scene); return; }
      const lane = element("section", `assembly-line${transfer ? " transfer-line" : ""}`), title = element("div", "assembly-heading");
      const name = element(task ? "button" : "strong", "assembly-name", task?.title || task?.goal || "다음 작업을 기다리는 중");
      if (task) { name.setAttribute("aria-label", `${task.title || task.goal} 내용 보기`); name.addEventListener("click", () => inspect(project, task.id, name)); }
      title.append(element("span", "assembly-state", transfer ? "완료" : task ? "진행중" : "대기"), name);
      if (task?.components?.length) title.append(element("small", "", task.components.map(x => x.name).join(" · ")));
      let scene;
      scene = createFactoryScene({ element, svgElement, sceneId: `${project.id}-${task?.id || "idle"}`, active: task && !transfer && !data.error ? [task] : [], completed: transfer ? [task] : [], transfers: transfer && !data.error ? [task] : [], compact: true, onOpen: (id, trigger) => inspect(project, id, trigger) });
      lane.append(title, scene); desired.push(lane); scenes.push(scene); laneCache.set(key, { signature, lane, scene });
    };
    const active = [...(data.active?.items || [])].sort(recent).slice(0, 6);
    for (const task of active) makeScene(task, false);
    for (const task of data.transfers.slice(0, 2)) makeScene(task, true);
    if (!active.length && !data.transfers.length) makeScene(null, false);
    if ((data.active?.items.length || 0) > 6 || data.active?.next_offset != null) {
      const more = element("button", "button", "나머지 진행중 작업 보기 →"); more.addEventListener("click", () => onOpen(project.id, null, "active")); desired.push(more);
    }
    for (const [key, old] of previous?.laneCache || []) if (laneCache.get(key)?.scene !== old.scene) old.scene.workshopMotion?.dispose();
    for (const [index, node] of desired.entries()) if (lines.children[index] !== node) {
      if (lines.moveBefore && node.parentElement) lines.moveBefore(node, lines.children[index] || null); else lines.insertBefore(node, lines.children[index] || null);
    }
    for (const node of [...lines.children]) if (!desired.includes(node)) lines.removeChild(node);
    const store = previous?.store || element("section", "completion-store");
    const art = previous?.art || element("div", "store-art"), listing = previous?.listing || element("details", "store-list");
    if (!previous) {
      art.setAttribute("aria-label", "최근 1시간 미확인 완료 부품");
      const summary = element("summary", "store-trigger"), label = element("span", "store-label");
      label.append(element("strong", "", "완료 보관함"), element("span"), element("span", "store-window", "최근 1시간 · 미확인"), element("small", "", "목록 열기"));
      summary.append(label); listing.append(summary, element("div", "store-contents"));store.append(art,listing);floor.append(lines,store);
    }
    const summary = listing.children[0], label = summary.children[0], list = listing.children[1];
    label.children[1].textContent = `${data.completed?.filtered_total ?? "—"}개`;
    const completionButtons = new Map(), packageButtons = new Map(), contents = [], packages = [];
    for (const task of [...(data.completed?.items || [])].sort(recent).slice(0, 6)) {
      const item = previous?.completionButtons.get(task.id) || element("button", "factory-completion");
      item.textContent = task.title || task.goal;
      if (!previous?.completionButtons.has(task.id)) item.addEventListener("click", () => inspect(project, task.id, item));
      completionButtons.set(task.id, item); contents.push(item);
      const part = previous?.packageButtons.get(task.id) || element("button", "store-package filled");
      part.setAttribute("aria-label", `${task.title || task.goal} 완료 내용 보기`);part.setAttribute("title", task.title || task.goal);
      if (!previous?.packageButtons.has(task.id)) part.addEventListener("click", () => inspect(project, task.id, part));
      packageButtons.set(task.id,part);packages.push(part);
    }
    for (let i=packages.length;i<6;i++) { const empty=element("span","store-package");empty.setAttribute("aria-hidden","true");packages.push(empty); }
    for (const [index,node] of packages.entries()) if (art.children[index] !== node) art.insertBefore(node,art.children[index] || null);
    for (const node of [...art.children]) if (!packages.includes(node)) art.removeChild(node);
    if (!contents.length) contents.push(element("p", "factory-empty", data.error ? "보관함을 불러오지 못했습니다." : "최근 1시간의 미확인 완료가 없어요."));
    if ((data.completed?.items.length || 0) > 6 || data.completed?.next_offset != null) {
      const more = element("button", "button", "전체 완료 기록 보기 →"); more.addEventListener("click", () => onOpen(project.id, null, "completed", true)); contents.push(more);
    }
    for (const [index, node] of contents.entries()) if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
    for (const node of [...list.children]) if (!contents.includes(node)) list.removeChild(node);
    const selected = selections.get(project.id);
    if (selected) selected.trigger = packageButtons.get(selected.id) || completionButtons.get(selected.id) || laneCache.get(`active-${selected.id}`)?.lane.querySelector?.("button") || summary;
    return { floor, scenes, store, art, listing, lines, laneCache, completionButtons, packageButtons };
  }

  function render(projects, partial) {
    const entries = [...projects].sort(recent).map(project => ({ project, ...cache.get(project.id) }));
    const signature = JSON.stringify([entries.map(({ transfers, ...entry }) => entry), partial]);
    if (signature === fingerprint) return;
    fingerprint = signature; observer?.disconnect();
    const desired = [];
    if (partial) desired.push(element("p", "factory-notice", "불러온 프로젝트만 표시합니다. ‘프로젝트 더 보기’로 이어서 볼 수 있습니다."));
    if (!entries.length) desired.push(element("p", "empty", "첫 작업이 저장되면 공장이 생깁니다."));
    for (const data of entries) {
      const { project } = data;
      const previous = cards.get(project.id), cardSignature = JSON.stringify({ ...data, transfers: undefined });
      if (previous?.signature === cardSignature) { desired.push(previous.node); continue; }
      const factory = previous?.node || element("article", "factory");
      const header = element("header", "factory-heading"), title = element("div", ""); title.append(element("h3", "", project.name));
      header.append(title, element("span", "factory-count", `진행중 ${project.unfinished} · 최근 완료 ${data.completed?.filtered_total ?? "—"}${project.interrupted ? ` · 중단 ${project.interrupted}` : ""}`));
      const notices = element("div", "factory-notices");
      const selectionMessage = previous?.selectionMessage || element("p", "factory-selection-message"); selectionMessage.setAttribute("role", "status");
      notices.append(selectionMessage);
      if (data.error) notices.append(element("p", "factory-notice", "연결을 확인하지 못했어요. 마지막 기록을 보여주며 기계는 멈췄습니다."));
      const structure = buildFloor(project, { ...data, transfers: data.transfers || [] }, previous);
      const { floor, scenes, store } = structure;
      const inspector = previous?.inspector || element("aside", "factory-inspector"); inspector.tabIndex = -1; inspector.setAttribute("aria-label", `${project.name} 선택한 작업`);
      const footer = element("p", "factory-footer", "최근 저장 · "); footer.append(project.last_activity ? relativeTime(project.last_activity) : element("span", "", "기록 없음"));
      if (previous) { factory.replaceChild(header, factory.children[0]); factory.replaceChild(notices, factory.children[1]); if (floor !== previous.floor) factory.replaceChild(floor, previous.floor); factory.replaceChild(footer, factory.children[4]); }
      else factory.append(header, notices, floor, inspector, footer);
      cards.set(project.id, { signature: cardSignature, node: factory, ...structure, inspector, selectionMessage, inspectorSignature: previous?.inspectorSignature, inspectorView: previous?.inspectorView }); updateInspector(project); desired.push(factory);
    }
    for (const [index, node] of desired.entries()) if (root.children[index] !== node) { if (root.moveBefore && node.parentElement) root.moveBefore(node, root.children[index] || null); else root.insertBefore(node, root.children[index] || null); }
    for (const node of [...root.children]) if (!desired.includes(node)) root.removeChild(node);
    for (const [id, card] of cards) if (!projects.some(project => project.id === id)) { dispose(card); cards.delete(id); selections.delete(id); }
    for (const card of cards.values()) for (const scene of card.scenes) { scene.workshopMotion?.setPaused(motionPaused); if (observer) observer.observe(scene); else scene.workshopMotion?.setVisible(true); }
  }
  return {
    setPaused(value) { motionPaused = value; for (const card of cards.values()) for (const scene of card.scenes) scene.workshopMotion?.setPaused(value); },
    cancel() { epoch++; baseline = true; },
    async refresh(projects, partial) {
      const ticket = ++epoch, showTransitions = !baseline; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(2, projects.length) }, async () => {
        while (cursor < projects.length && ticket === epoch) {
          const project = projects[cursor++];
          try {
            const active = await request(`/api/runs?project=${encodeURIComponent(project.id)}&state=active&offset=0`);
            const completed = await request(`/api/runs?project=${encodeURIComponent(project.id)}&state=completed&review=unread&completed_within=1h&offset=0`);
            if (!Number.isSafeInteger(completed.filtered_total) || completed.filtered_total < 0) throw new Error("최근 완료 조회를 지원하는 서버가 필요합니다.");
            if (ticket === epoch) { const previous = cache.get(project.id), ids = new Set(showTransitions && !previous?.error ? previous?.active?.items.map(task => task.id) : []); cache.set(project.id, { active: pageView(active), completed: pageView(completed), error: false, transfers: completed.items.filter(task => ids.has(task.id)) }); }
          } catch { if (ticket === epoch) cache.set(project.id, { ...cache.get(project.id), transfers: [], error: true }); }
        }
      }));
      if (ticket === epoch) { render(projects, partial); baseline = false; }
    },
  };
}
