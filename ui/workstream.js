function node(tag, className, text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}

// The board projects saved rows only. Missing rows never imply an idle worker.
export function renderWorkstream(container, { components, tasks, selected, summary, partial }, onComponent, onRun) {
  container.replaceChildren();
  const items = [...components];
  if (summary.unclassified) items.push({ key: "unclassified", name: "미분류", total: summary.unclassified });
  if (!items.length) {
    container.append(node("p", "catalog-note", "구성요소가 아직 연결되지 않았습니다. 다음 작업에서 AI가 연결하면 여기에 나타납니다."));
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
    if (task) {
      const card = node("button", "lane-task");
      card.append(node("span", "lane-state", "미완료 기록"), node("strong", "", task.title || task.goal),
        node("span", "lane-actor", `${task.actor || "작성자 미수집"} · ${task.features?.[0]?.name || "기능 미분류"}`));
      card.addEventListener("click", () => onRun(task));
      lane.append(card);
    } else {
      lane.append(node("p", "lane-empty", component.unfinished > 0 || partial || component.key === "unclassified"
        ? "아래 목록에서 작업 확인" : "저장된 미완료 작업 없음"));
    }
    if (matching.length > 1) lane.append(node("small", "lane-more", `조회된 미완료 작업 ${matching.length}개`));
    container.append(lane);
  }
}
