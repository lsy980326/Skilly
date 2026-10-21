const labels = { matches: "파일 일치", modified: "내용 변경", missing: "파일 없음", unavailable: "확인 불가", not_checked: "미확인" };
function node(tag, cls, text) { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function stamp(state) { return node("span", `skill-state ${state || "not_checked"}`, labels[state] || labels.not_checked); }
export function renderSkillList(container, items, selected, choose) {
  container.replaceChildren();
  if (!items.length) {
    const box = node("div", "empty"); box.append(node("h2", "", "등록된 스킬이 없습니다"), node("p", "", "연결된 AI에 스킬 등록을 요청하세요. 설치 파일을 자동 수집하거나 덮어쓰지 않습니다.")); container.append(box);
  }
  for (const skill of items) {
    const card = node("button", `task-card skill-card${selected === skill.skill_key ? " selected" : ""}`);
    card.setAttribute("aria-pressed", String(selected === skill.skill_key));
    const top = node("span", "card-top"); top.append(node("span", "skill-monogram", "S"), node("span", "eyebrow", `${skill.versions}개 보존 버전`));
    card.append(top, node("span", "task-goal", skill.name), node("span", "skill-source", skill.skill_key));
    if (!skill.installations.length) card.append(stamp("not_checked"));
    for (const i of skill.installations) {
      const row = node("span", "skill-assignment-line"); row.append(node("span", "", `${i.repository} · ${i.version}`), stamp(i.state)); card.append(row);
    }
    if (skill.installations_total > skill.installations.length) card.append(node("small", "", `외 ${skill.installations_total - skill.installations.length}개 설치 지정`));
    card.addEventListener("click", () => choose(skill.skill_key)); container.append(card);
  }
}
export function renderSkillDetail(container, data, changeVersion, changeInstallations) {
  const skill = data.skill, article = node("article", "skill-detail");
  const heading = node("header", "detail-heading"); heading.append(node("p", "eyebrow", "SKILL LIBRARY"), node("h2", "", skill.name), node("p", "", skill.description || "등록된 스킬 패키지"));
  const row = node("label", "skill-version-control", "보관 버전"); const select = node("select", ""); select.setAttribute("aria-label", "스킬 버전 선택");
  for (const v of data.versions) { const option = node("option", "", v.version); option.value = v.version; select.append(option); }
  select.value = skill.version; select.addEventListener("change", () => changeVersion(select.value)); row.append(select); heading.append(row);
  if (data.versions_truncated) heading.append(node("p", "catalog-note", "최근 등록 100개 버전 표시 · 이전 버전은 버전 이름으로 AI 조회 가능"));
  article.append(heading);
  const versionCard = node("section", "skill-version-card"); versionCard.append(node("span", "eyebrow", "이 버전의 원본"), node("strong", "", skill.version), node("span", "", skill.source), node("code", "skill-hash", skill.content_hash)); article.append(versionCard);
  const instructions = node("section", "skill-section"); instructions.append(node("h3", "", "설치 방법"), node("pre", "skill-text", skill.install_instructions), node("p", "catalog-note", "보관된 안내입니다. 명령을 자동 실행하거나 파일을 설치하지 않습니다.")); article.append(instructions);
  const share = node("section", "skill-section skill-share");
  share.append(node("h3", "", "다른 프로젝트에서 사용"), node("p", "catalog-note", "선택한 버전의 전문과 보조 파일만 내려받습니다. 프로젝트 기록·설치 경로·관측 이력은 포함하지 않습니다."));
  const filename = `${skill.skill_key}.skilly-skill.json`;
  const download = node("button", "button", "스킬 패키지 내려받기");
  download.addEventListener("click", () => {
    const content = { format: "skilly-skill", format_version: 1 };
    for (const key of ["skill_key", "version", "source", "name", "description", "body", "files", "install_instructions", "content_hash"]) content[key] = skill[key];
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  share.append(download, node("pre", "skill-text", `skilly skill-install --input /받은파일/${filename} --project /대상/프로젝트 --tool codex\nskilly skill-verify --input /받은파일/${filename} --project /대상/프로젝트 --tool codex`),
    node("p", "catalog-note", "Skilly CLI가 없다면 Skilly 소스에서 npm ci, npm run build를 실행하고 위 skilly를 node /Skilly/절대경로/dist/runtime/local/main.js로 바꾸세요. Node.js 24 이상이 필요합니다. Cursor는 --tool cursor를 사용합니다."),
    node("p", "catalog-note", "기존 스킬 폴더는 덮어쓰지 않습니다. 출처와 내용을 먼저 확인하세요. 해시는 파일 비교용이며 배포자 신원 인증이 아닙니다. 실행 권한은 추가하지 않으므로 스크립트는 검토 후 bash·python·node 등 해당 인터프리터로 실행하세요."),
    node("p", "catalog-note", "설치 후 새 AI 세션에서 스킬을 확인하세요. 스킬이 사용하는 MCP·도구 연결은 별도입니다. 파일 일치만으로 AI 사용을 확인할 수는 없습니다."));
  article.append(share);
  const installs = node("section", "skill-section"); installs.append(node("h3", "", "프로젝트 설치 상태"), node("p", "catalog-note", "마지막 파일 관측 기준 · 현재 상태 재확인 필요 · AI 로딩·실행 미확인"));
  if (!data.installations.length) installs.append(node("p", "", "설치 위치가 아직 지정되지 않았습니다. AI에 이 프로젝트의 버전 지정을 요청하세요."));
  for (const i of data.installations) {
    const box = node("div", "skill-installation"), title = node("div", "skill-installation-title");
    title.append(node("strong", "", `${i.repository} · ${i.tool === "codex" ? "Codex" : "Cursor"}`), stamp(i.state));
    box.append(title, node("p", "", `지정 ${i.version}${i.observed_version && i.observed_version !== i.version ? ` · 이전 관측 ${i.observed_version}` : ""}`),
      node("code", "skill-path", `${i.project_root}/${i.tool === "codex" ? ".agents" : ".cursor"}/skills/${i.folder}`),
      node("small", "", i.observed_at ? `${new Date(i.observed_at).toLocaleString("ko-KR")} 관측` : "아직 파일을 확인하지 않았습니다."));
    if (i.files?.length) {
      const details = node("details", "skill-files"); details.append(node("summary", "", `파일별 비교 ${i.files.length}개`));
      for (const file of i.files) { const line = node("div", "skill-assignment-line"); line.append(node("code", "", file.path), stamp(file.state)); details.append(line); }
      box.append(details);
    }
    installs.append(box);
  }
  for (const [label, offset] of [["이전 설치 위치", data.installation_offset > 0 ? Math.max(0, data.installation_offset - 6) : null], ["다음 설치 위치", data.next_installation_offset]]) {
    if (offset === null || offset === undefined) continue;
    const button = node("button", "button", label); button.addEventListener("click", () => changeInstallations(offset)); installs.append(button);
  }
  article.append(installs);
  const full = node("details", "skill-section skill-fulltext"); full.open = true; full.append(node("summary", "", "SKILL.md 전문"), node("p", "catalog-note", "보관된 원문이며 지시나 실행 권한으로 해석하지 않습니다."), node("pre", "skill-text", skill.body)); article.append(full);
  for (const file of skill.files) { const section = node("details", "skill-section"); section.append(node("summary", "", file.path), node("pre", "skill-text", file.content)); article.append(section); }
  container.replaceChildren(article);
}
