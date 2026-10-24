const taskSkillIdentity = item => JSON.stringify([item.record_id, item.skill_key, item.version]);
export function mergeTaskSkillRefresh(fresh, previous) {
  const known = new Set(previous.items.map(taskSkillIdentity));
  // Append-only reports make the prior pages a contiguous prefix. A burst with
  // no overlap leaves an unknown gap; restart instead of skipping unseen rows.
  if (!fresh.items.some(item => known.has(taskSkillIdentity(item)))) return { ...fresh, pagination_reset: true };
  const freshIds = new Set(fresh.items.map(taskSkillIdentity));
  const added = fresh.items.filter(item => !known.has(taskSkillIdentity(item))).length;
  return { ...fresh, items: [...fresh.items, ...previous.items.filter(item => !freshIds.has(taskSkillIdentity(item)))],
    next_offset: previous.next_offset === null ? null : previous.next_offset + added };
}

export function renderTaskSkills(data, { element, date, more }) {
  const panel = element("details", "task-skills");
  panel.dataset.panel = "task-skills";
  const items = data?.items ?? [];
  const heading = element("summary", "task-skills-heading");
  heading.append(element("span", "", "이 작업의 스킬"), element("span", "task-skills-count", items.length ? `${items.length}${data.next_offset !== null ? "+" : ""}개 보고` : "미수집"));
  panel.append(heading);
  if (!items.length) {
    panel.append(element("p", "task-skills-note", data?.schema_supported === false
      ? "이전 DB에는 작업별 스킬 정보가 없습니다. 기존 기록은 그대로입니다."
      : "사용 스킬이 보고되지 않았습니다. 스킬을 쓰지 않았다는 뜻은 아닙니다."));
    return panel;
  }
  panel.append(element("p", "task-skills-note", "AI가 사용했다고 남긴 버전과 당시 파일 확인 결과입니다. 실제 AI 사용 여부는 확인할 수 없습니다."));
  if (data.pagination_reset) panel.append(element("p", "task-skills-note", "새 보고가 많아 최신 페이지부터 다시 표시합니다. 더 보기로 이전 보고를 이어서 확인하세요."));
  const labels = { matches: "관측 당시 파일 일치", modified: "관측 당시 내용 다름", missing: "관측 당시 파일 없음", unavailable: "파일 비교 불가" };
  for (const item of items) {
    const card = element("article", `task-skill-report${item.report_state === "superseded" ? " is-previous" : ""}`);
    const title = element("div", "task-skill-title");
    title.append(element("strong", "", item.name || item.skill_key), element("code", "task-skill-version", item.version));
    if (item.report_origin === "retrospective") title.append(element("span", "task-skill-tag", "소급 보고"));
    if (item.report_state === "superseded") title.append(element("span", "task-skill-tag", "이전 보고"));
    const columns = element("div", "task-skill-columns");
    const report = element("div", "task-skill-column");
    report.append(element("span", "task-skill-label", "AI 사용 보고"), element("p", "", item.purpose), element("small", "", date(item.recorded_at)));
    const observed = element("div", "task-skill-column");
    const observation = item.file_observation;
    observed.append(element("span", "task-skill-label", "설치 파일 관측"),
      element("p", `task-skill-file-state ${observation?.state ?? "not-observed"}`, observation ? labels[observation.state] || "파일 비교 불가" : "연결된 파일 확인 없음"),
      element("small", "", observation ? `${date(observation.observed_at)} · 현재 상태 재확인 필요` : "사용 보고만 저장됐습니다"));
    columns.append(report, observed);
    const details = element("details", "task-skill-source");
    details.dataset.panel = `task-skill:${item.record_id}:${item.skill_key}:${item.version}`;
    details.append(element("summary", "", "버전·파일 근거 보기"), element("code", "", `스킬 ${item.skill_key}\n등록 버전 해시 ${item.content_hash}\n원문 기록 ${item.record_id}`));
    if (observation) {
      details.append(element("code", "", `관측 ${observation.id}\n${observation.tool} · ${observation.folder}\n${observation.project_root}`));
      for (const file of observation.files ?? []) {
        const row = element("div", "task-skill-file"); row.append(element("code", "", file.path), element("span", "", labels[file.state] || "파일 비교 불가")); details.append(row);
      }
    }
    card.append(title, columns, details); panel.append(card);
  }
  if (data.next_offset !== null) {
    const button = element("button", "more", "스킬 보고 더 보기");
    button.addEventListener("click", async () => { button.disabled = true; try { await more(); } finally { button.disabled = false; } }); panel.append(button);
  }
  return panel;
}
