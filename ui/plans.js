const states={pending:"시작 전",in_progress:"진행중",blocked:"막힘",completed:"완료 보고",needs_review:"다시 확인"};
const knowledge={current:"현재 코드의 검사 근거",stale:"코드가 바뀐 검사",conflict:"검사 결과 충돌",unknown:"현재 코드 비교 불가"};
const taskStates={active:"미완료 기록",completed:"작업 종료 기록 있음",interrupted:"중단 보고"};
export const planIdentity=plan=>JSON.stringify([plan.repository,plan.environment,plan.plan_key]);
function progressView(progress,element) {
  const box=element("div","plan-progress");
  box.append(element("strong","",`${progress.completed_reported} / ${progress.required}`),element("span","","필수 항목 완료 보고"));
  const bar=element("progress","plan-meter");bar.max=Math.max(1,progress.required);bar.value=progress.completed_reported;
  bar.setAttribute("aria-label",`필수 ${progress.required}개 중 완료 보고 ${progress.completed_reported}개`);box.append(bar);
  return box;
}
export function renderPlanList(container,items,selected,{element,onSelect}) {
  container.replaceChildren();
  if(!items.length){container.append(element("div","empty","아직 등록한 계획이 없습니다."),element("p","catalog-note","AI에게 ‘이 MD나 대화 계획을 Skilly 계획으로 등록하고 이어서 작업해줘’라고 요청하세요. 원본 MD는 그대로 보존합니다."));return;}
  for(const item of items) {
    const button=element("button",`task-card plan-card${planIdentity(item)===selected?" selected":""}`);
    button.setAttribute("aria-pressed",String(planIdentity(item)===selected));
    button.append(element("span","eyebrow",`PLAN · v${item.version}`),element("strong","task-goal",item.title),progressView(item.progress,element),
      element("span","plan-remaining",`남은 ${item.progress.remaining}개${item.progress.blocked?` · 막힘 ${item.progress.blocked}개`:""}`),element("small","catalog-note",`${item.repository} · ${item.environment}`));
    button.addEventListener("click",()=>onSelect(item));container.append(button);
  }
}
export function renderPlanDetail(data,{element,onVersion,onTask,remainingOnly=false,onRemaining=()=>{}}) {
  const panel=element("article","plan-detail"),plan=data.plan,p=data.progress;
  panel.append(element("p","eyebrow",`PLAN / VERSION ${plan.version}`),element("h2","",plan.title),progressView(p,element),
    element("p","plan-summary",p.status==="completed_reported"?"모든 필수 항목에 완료 보고가 있습니다.":`아직 ${p.remaining}개 항목이 남아 있어요.`),
    element("p","catalog-note","진행률은 항목별 완료 조건에 대한 AI 보고입니다. 검사 통과와 기능 전체의 검증 완료를 뜻하지 않습니다."));
  if(data.linked_tasks) {
    const linked=element("section","plan-linked-tasks");linked.append(element("h3","",`연결된 작업 ${data.linked_tasks.total}개`));
    linked.append(element("p","catalog-note","이 계획 버전의 진행 기록에 연결한 작업입니다. 이전 작업도 포함하며, 상태는 저장된 기록 기준입니다."));
    const names=new Map(data.items.map(item=>[item.key,item.title]));
    for(const task of data.linked_tasks.items) {
      const button=element("button","plan-linked-task");button.append(element("strong","",task.title),
        element("span","catalog-note",[taskStates[task.state]||"상태 확인 필요",task.actor||"작성자 미수집",`연결 보고 ${task.report_count}개`].join(" · ")),
        element("span","plan-task-items",task.item_keys.map(key=>names.get(key)||key).join(" · ")));
      button.addEventListener("click",()=>onTask(task.id));linked.append(button);
    }
    if(!data.linked_tasks.total)linked.append(element("p","catalog-note","아직 진행 기록에 연결된 작업이 없습니다."));
    if(data.linked_tasks.truncated)linked.append(element("p","catalog-note",`최근 연결한 작업 ${data.linked_tasks.items.length}개만 표시합니다. 이전 작업은 작업 목록에서 확인하세요.`));
    panel.append(linked);
  }
  const controls=element("div","plan-controls"),label=element("label","","계획 버전 "),select=element("select","");select.setAttribute("aria-label","계획 버전");select.dataset.planControl="version";
  const versions=data.versions.some(v=>v.version===plan.version)?data.versions:[{version:plan.version},...data.versions];
  for(const version of versions){const option=element("option","",`v${version.version}`);option.value=String(version.version);option.selected=version.version===plan.version;select.append(option);}
  select.addEventListener("change",()=>onVersion(Number(select.value)));label.append(select);controls.append(label);
  const remaining=element("button","button","남은 항목만 보기");remaining.setAttribute("aria-pressed","false");remaining.dataset.planControl="remaining";controls.append(remaining);panel.append(controls);if(data.versions_truncated)panel.append(element("p","catalog-note","최근 버전 일부만 표시합니다. 더 오래된 버전은 AI에게 버전 번호로 조회를 요청하세요."));
  const list=element("div","plan-items");
  for(const item of data.items) {
    const card=element("section",`plan-item state-${item.state}`);card.dataset.completed=String(item.state==="completed");
    const head=element("div","plan-item-heading"),mark=element("span","plan-item-mark",item.state==="completed"?"✓":item.state==="in_progress"?"◐":item.state==="blocked"?"!":"○");mark.setAttribute("aria-hidden","true");
    head.append(mark,element("h3","",item.title),element("span","badge feature",states[item.state]||"확인 필요"));card.append(head);
    if(!item.required)card.append(element("small","catalog-note","선택 항목 · 필수 진행률에서 제외"));
    if(item.component_key||item.feature_key)card.append(element("p","catalog-note",[item.component_key,item.feature_key].filter(Boolean).join(" · ")));
    if(item.source_checked)card.append(element("p","catalog-note","원문에는 체크됨 · 작업 완료 여부와 별개"));
    if(item.note)card.append(element("p","plan-item-note",item.note));
    const conditions=element("ul","plan-conditions");
    for(const c of item.criteria){const result=item.criteria_results.find(r=>r.key===c.key);conditions.append(element("li","",`${result?.met?"충족 보고":"확인 필요"} · ${c.text}${result?.detail?` — ${result.detail}`:""}`));}card.append(conditions);
    const evidence=item.evidence;
    if(evidence?.linked){
      card.append(element("p","plan-check-caption",`직접 실행 관측 ${evidence.linked}건 · ${knowledge[evidence.status]||"판정 정보 없음"}`));
      for(const observation of evidence.observations) {
        const c=observation.counts;card.append(element("p","catalog-note",c?`수집된 검사 ${c.tests}개 · 통과 ${c.passed} · 실패 ${c.failed} · 건너뜀 ${c.skipped}`:"검사 상세 미수집 · 성공 여부를 추정하지 않습니다."));
      }
    }else card.append(element("p","catalog-note","연결한 직접 검사 근거 없음"));
    if(item.run_id){const button=element("button","button quiet plan-item-task",item.task?`진행한 작업 · ${item.task.title}`:"연결 작업 보기");button.addEventListener("click",()=>onTask(item.run_id));card.append(button);
      if(item.task)card.append(element("p","catalog-note",[taskStates[item.task.state]||"상태 확인 필요",item.task.actor||"작성자 미수집"].join(" · ")));}
    list.append(card);
  }
  const none=element("p","catalog-note","남은 항목이 없습니다. 선택한 계획 버전의 필수 완료 보고와 근거를 확인하세요.");none.hidden=true;
  const applyFilter=filter=>{onRemaining(filter);remaining.setAttribute("aria-pressed",String(filter));remaining.textContent=filter?"전체 항목 보기":"남은 항목만 보기";let visible=0;for(const item of list.children){item.hidden=filter&&item.dataset.completed==="true";if(!item.hidden)visible++;}none.hidden=visible!==0;};
  remaining.addEventListener("click",()=>applyFilter(remaining.getAttribute("aria-pressed")!=="true"));applyFilter(remainingOnly);
  panel.append(list,none);
  const source=element("details","plan-source"),summary=element("summary","","원문·출처 보기");
  source.append(summary,element("p","catalog-note",`${plan.source_kind==="markdown"?"Markdown":"대화"} · ${plan.source_ref} · 원문 경로는 작성자가 제공한 정보`),element("pre","",plan.source_body));panel.append(source);
  return panel;
}
