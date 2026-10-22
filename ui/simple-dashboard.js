import { createFactoryScene } from "./factory-scene.js";
// Saved run state is never evidence of live execution; only an explicit click acknowledges it.
export function createSimpleDashboard({ root, request, element, svgElement, relativeTime, onOpen, onAcknowledged }) {
  const cache = new Map(), cards = new Map();
  let epoch = 0, fingerprint = "", baseline = true, motionPaused = false;
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const entry of entries) { entry.target.classList.toggle("motion-offscreen", !entry.isIntersecting); entry.target.workshopMotion?.setVisible(entry.isIntersecting); }
  }) : null;
  const recent = (a, b) => String(b.updated_at || b.last_activity || "").localeCompare(String(a.updated_at || a.last_activity || "")) || a.id.localeCompare(b.id);
  const pageView = page => ({ next_offset: page.next_offset, items: page.items.map(task => ({
    id: task.id, title: task.title, goal: task.goal, updated_at: task.updated_at, actor: task.actor,
    components: task.components, features: task.features, latest_report: task.latest_report ? { summary: task.latest_report.summary } : null,
  })) });
  function taskCard(project, task) {
    const card = element("button", "factory-task");
    card.append(element("strong", "", task.title || task.goal),
      element("span", "factory-scope", [...(task.components || []).map(x => x.name), ...(task.features || []).map(x => x.name)].join(" · ") || "미분류"),
      element("p", "", task.latest_report?.summary || "요약 기록 없음"),
      element("small", "", `작성자: ${task.actor || "미상"} · `), relativeTime(task.updated_at));
    card.addEventListener("click", () => onOpen(project.id, task.id));
    return card;
  }
  function render(projects, partial) {
    const entries = [...projects].sort(recent).map(project => ({ project, ...cache.get(project.id) }));
    const signature = JSON.stringify([entries.map(({ transfers, ...entry }) => entry), partial]);
    if (signature === fingerprint) return;
    fingerprint = signature;
    observer?.disconnect();
    const desired = [];
    if (partial) desired.push(element("p", "factory-notice", "불러온 프로젝트 기준입니다. 왼쪽 ‘프로젝트 더 보기’로 나머지를 불러오세요."));
    if (!entries.length) desired.push(element("p", "empty", "아직 등록된 프로젝트가 없습니다."));
    for (const entry of entries) {
      const { project, active, completed, error, transfers = [] } = entry;
      const cardSignature = JSON.stringify({ project, active, completed, error });
      const previousCard = cards.get(project.id);
      if (previousCard?.signature === cardSignature) { desired.push(previousCard.node); continue; }
      const factory = element("article", "factory");
      const header = element("header", "factory-heading");
      const title = element("div", "");
      title.append(element("small", "eyebrow", project.key), element("h3", "", project.name));
      header.append(title, element("span", "factory-count", `진행중 ${project.unfinished} · 미확인 완료 ${project.unreviewed_completed ?? "—"} · 중단 ${project.interrupted}`));
      factory.append(header);
      const notices = element("div", "factory-notices");
      if (error) notices.append(element("p", "factory-notice", "갱신 실패 · 아래 내용은 마지막으로 조회한 기록입니다. 현재 상태는 확인하지 못했습니다."));
      factory.append(notices);
      const sceneSignature = JSON.stringify([error, (active?.items || []).slice(0, 3).map(t => [t.id, t.title, t.goal]), (completed?.items || []).slice(0, 4).map(t => t.id)]);
      factory.append(createFactoryScene({ element, svgElement, sceneId: project.id, active: error ? [] : active?.items || [], completed: completed?.items || [], transfers: error ? [] : transfers, onOpen: id => onOpen(project.id, id) }));
      const lanes = element("div", "factory-lanes");
      for (const [key, page, label] of [["active", active, "진행중"], ["completed", completed, "완료 보관함"]]) {
        const lane = element("section", `factory-lane ${key}`);
        lane.append(element("h4", "", key === "completed" ? "미확인 완료 보관함" : label));
        if (key === "completed") lane.append(element("p", "factory-review-note", "확인 완료를 누른 작업은 보관함에서만 빠집니다. 이 로컬 DB 전체 기준이며, 내용 검증과 다릅니다."));
        if (!page) lane.append(element("p", "factory-notice", "기록을 조회하지 못했습니다."));
        else {
          for (const task of [...page.items].sort(recent).slice(0, 3)) {
            if (key !== "completed") { lane.append(taskCard(project, task)); continue; }
            const item = element("div", "factory-completion");
            const acknowledge = element("button", "button acknowledge-task", "확인 완료");
            acknowledge.setAttribute("aria-label", `${task.title || task.goal} 확인 완료`);
            const feedback = element("p", "factory-review-feedback"); feedback.setAttribute("role", "status");
            acknowledge.addEventListener("click", async () => {
              acknowledge.disabled = true; feedback.textContent = "확인 상태 저장 중…";
              try {
                await request("/api/runs/acknowledge", { method: "POST", body: JSON.stringify({ project_id: project.id, run_id: task.id, expected_updated_at: task.updated_at }) });
                feedback.textContent = "확인 상태 저장됨 · 목록 갱신 중…";
                await onAcknowledged();
              } catch (error) { feedback.textContent = error.message || "확인 상태를 저장하지 못했습니다. 다시 시도해 주세요."; acknowledge.disabled = false; }
            });
            item.append(taskCard(project, task), acknowledge, feedback); lane.append(item);
          }
          if (!page.items.length) lane.append(element("p", "factory-empty", key === "active" ? "저장된 진행중 작업 없음" : "확인할 완료 작업이 없습니다. 전체 완료 기록은 상세보기에 남아 있습니다."));
          if (page.items.length > 3 || page.next_offset !== null) {
            const more = element("button", "button", key === "completed" ? "미확인 완료 더 보기" : `${label} 더 보기 → 상세보기`);
            more.addEventListener("click", () => onOpen(project.id, null, key, key === "completed")); lane.append(more);
          }
        }
        lanes.append(lane);
      }
      factory.append(lanes, element("p", "factory-footer", "최근 활동 · "));
      factory.children[factory.children.length - 1].append(project.last_activity ? relativeTime(project.last_activity) : element("span", "", "작업 기록 없음"));
      let card = factory;
      if (previousCard) {
        card = previousCard.node;
        // Updating a summary must not replay the machine's arrival/assembly cycle.
        const fresh = [...factory.children];
        for (const index of [0, 1, 2, 3, 4]) {
          if (index === 2 && previousCard.sceneSignature === sceneSignature) { fresh[index].workshopMotion?.dispose(); continue; }
          if (index === 2) card.children[index].workshopMotion?.dispose();
          card.replaceChild(fresh[index], card.children[index]);
        }
      }
      cards.set(project.id, { signature: cardSignature, sceneSignature, node: card });
      desired.push(card);
    }
    for (const [index, node] of desired.entries()) {
      if (root.children[index] !== node) {
        if (root.moveBefore && node.parentElement) root.moveBefore(node, root.children[index] || null);
        else root.insertBefore(node, root.children[index] || null);
      }
    }
    const kept = new Set(desired);
    for (const node of [...root.children]) if (!kept.has(node)) { node.children[2]?.workshopMotion?.dispose(); root.removeChild(node); }
    for (const [id] of cards) if (!projects.some(project => project.id === id)) cards.delete(id);
    for (const card of cards.values()) { const scene=card.node.children[2]; scene.workshopMotion?.setPaused(motionPaused); if(observer) observer.observe(scene); else scene.workshopMotion?.setVisible(true); }
  }
  return {
    setPaused(value) { motionPaused=value; for(const card of cards.values()) card.node.children[2]?.workshopMotion?.setPaused(value); },
    cancel() { epoch++; baseline = true; },
    async refresh(projects, partial) {
      const ticket = ++epoch, showTransitions = !baseline;
      let cursor = 0;
      // Two project workers, one request per worker at a time; no extra polling timer.
      await Promise.all(Array.from({ length: Math.min(2, projects.length) }, async () => {
        while (cursor < projects.length && ticket === epoch) {
          const project = projects[cursor++];
          try {
            const active = await request(`/api/runs?project=${encodeURIComponent(project.id)}&state=active&offset=0`);
            const completed = await request(`/api/runs?project=${encodeURIComponent(project.id)}&state=completed&review=unread&offset=0`);
            if (ticket === epoch) {
              const previous = cache.get(project.id);
              const ids = new Set(showTransitions && !previous?.error ? previous?.active?.items.map(task => task.id) : []);
              cache.set(project.id, { active: pageView(active), completed: pageView(completed), error: false,
                transfers: completed.items.filter(task => ids.has(task.id)) });
            }
          } catch { if (ticket === epoch) cache.set(project.id, { ...cache.get(project.id), error: true }); }
        }
      }));
      if (ticket === epoch) { render(projects, partial); baseline = false; }
    },
  };
}
