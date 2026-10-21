function node(tag, className, text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}

const boards = new WeakMap();
function taskData(task) {
  const { id, updated_at, state, title, goal, actor, components, features, links_truncated, latest_report, branch } = task;
  return { id, updated_at, state, title, goal, actor, components, features, links_truncated, latest_report, branch };
}

function savedTime(value) {
  if (typeof value !== "string" || !value.trim()) return "기록 시각 미수집";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "기록 시각 미수집" : `마지막 기록 ${new Intl.DateTimeFormat("ko-KR", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date)}`;
}

// The board projects saved rows only. Missing rows never imply an idle worker.
export function renderWorkstream(container, { project, components, tasks, selected, summary, partial, animate = true }, onComponent, onRun) {
  const fingerprint = JSON.stringify({ project, components, tasks: tasks.map(taskData), selected, summary, partial });
  const previous = boards.get(container);
  if (previous?.fingerprint === fingerprint && container.children.length) return;
  const sameProject = previous !== undefined && previous.project === project;
  const signatures = new Map();
  const scrollLeft = sameProject ? container.scrollLeft : 0;
  container.replaceChildren();
  const items = [...components];
  if (summary.unclassified) items.push({ key: "unclassified", name: "미분류", total: summary.unclassified });
  if (!items.length) {
    container.append(node("p", "catalog-note", "구성요소가 아직 연결되지 않았습니다. 다음 작업에서 AI가 연결하면 여기에 나타납니다."));
    boards.set(container, { project, fingerprint, signatures });
    return;
  }
  for (const component of items) {
    const lane = node("article", `component-lane${selected === component.key ? " selected" : ""}`);
    const button = node("button", "component-tile");
    button.setAttribute("aria-pressed", String(selected === component.key));
    button.append(node("span", "lane-port"), node("strong", "", component.name),
      node("span", "", `작업 ${component.total}${component.unfinished === undefined ? "" : ` · 미완료 ${component.unfinished}`}`));
    button.addEventListener("click", () => onComponent(component.key));
    lane.append(button);
    const matching = tasks.filter(task => component.key === "unclassified"
      ? !task.components?.length && !task.links_truncated
      : task.components?.some(item => item.key === component.key));
    const task = matching[0];
    const signature = JSON.stringify({ component, matching: matching.map(taskData) });
    signatures.set(component.key, signature);
    const known = sameProject && previous.signatures.has(component.key);
    if (animate && !known) lane.className += " lane-enter";
    else if (animate && previous.signatures.get(component.key) !== signature) lane.className += " lane-updated";
    if (task) {
      lane.className += " has-unfinished";
      matching.slice(0, 3).forEach((item, index) => {
        const card = node("button", `lane-task${index ? " lane-task-extra" : ""}`);
        card.append(node("span", "lane-state", "미완료 기록"), node("strong", "", item.title || item.goal),
          node("span", "lane-actor", `${item.actor || "작성자 미수집"} · ${item.features?.[0]?.name || "기능 미분류"}`),
          node("span", "lane-last", savedTime(item.updated_at)),
          node("span", "lane-summary", item.latest_report?.summary || "아직 구조화된 요약이 없습니다. 상세 기록에서 원문을 확인하세요."));
        if (item.branch) card.append(node("span", "lane-branch", `브랜치 ${item.branch}`));
        card.addEventListener("click", () => onRun(item));
        lane.append(card);
      });
    } else {
      lane.append(node("p", "lane-empty", component.unfinished > 0 || partial || component.key === "unclassified"
        ? "아래 목록에서 작업 확인" : "저장된 미완료 작업 없음"));
    }
    if (matching.length > 1) {
      lane.append(node("small", "lane-more lane-more-compact", `조회된 미완료 작업 ${matching.length}개 · 높이를 늘리면 더 보기`),
        node("small", "lane-more lane-more-expanded", `조회된 미완료 작업 ${matching.length}개 중 ${Math.min(3, matching.length)}개 표시`));
    }
    container.append(lane);
  }
  container.scrollLeft = scrollLeft;
  boards.set(container, { project, fingerprint, signatures });
}
