const decisionLabels = {current:"현재 적용",conflict:"결정 충돌",withdrawn:"철회됨",unconfirmed:"결정 대기",unknown:"확인 필요"};
const checkLabels = {current:"현재 코드와 비교됨",stale:"코드가 바뀜",conflict:"검사 결과 충돌",unknown:"판단할 근거 부족"};
const itemLabels = {pending:"대기",in_progress:"진행 중",blocked:"막힘",needs_review:"다시 확인"};

export function createCurrentKnowledge({document,request,onTask,onPlan}) {
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined&&text!==null)n.textContent=String(text);return n;};
  let dialog,project,components=[],opener,epoch=0,timer,revision,pages={},displayScope="";
  const filters={repository:"",environment:"",component:""};
  function cancel(){epoch++;clearTimeout(timer);}
  function action(label,fn){const b=node("button","knowledge-link",label);b.addEventListener("click",()=>{dialog.close();void fn();});return b;}
  function tag(text,tone=""){return node("span",`knowledge-tag ${tone}`,text);}
  function details(card,text){const d=node("details","knowledge-reference");d.append(node("summary","","연결 정보"),node("p","",text));card.append(d);}
  function card(title,scope){const a=node("article","knowledge-card");a.append(node("h4","",title));if(scope)a.append(node("p","knowledge-scope",scope));return a;}
  function scope(item){return [item.component_name,item.repository,item.environment].filter(Boolean).join(" · ");}
  function renderSection(key,title,description,render){
    const page=pages[key],section=node("section",`knowledge-column knowledge-${key}`),head=node("header","knowledge-section-head");
    head.append(node("h3","",title),node("p","",description));section.append(head);
    if(page.schema_supported===false)section.append(node("p","knowledge-empty","이 DB 버전은 이 조회를 지원하지 않습니다. 기존 기록은 그대로 있습니다."));
    else if(!page.items.length)section.append(node("p","knowledge-empty",key==="decisions"?"이 범위에 연결된 결정이 없습니다.":key==="plans"?"이 범위에 등록된 계획이 없습니다.":"이 범위에 연결된 기능이 없습니다. 연결되지 않은 검사는 포함하지 않습니다."));
    for(const item of page.items)section.append(render(item));
    if(page.response_truncated)section.append(node("p","knowledge-warning","응답 크기 때문에 일부 정보만 표시합니다. 더 보기 또는 원래 상세에서 확인하세요."));
    if(page.next_offset!==null){const more=node("button","button quiet knowledge-more","더 보기");more.addEventListener("click",()=>void load(key));section.append(more);}
    return section;
  }
  function renderDecisions(item){
    const a=card(item.title,scope(item));a.append(tag(decisionLabels[item.status]||"확인 필요",item.status));
    if(item.projection_truncated)a.append(node("p","knowledge-warning","결정 상세가 생략됐습니다. 원문 기록을 확인하세요."));
    for(const choice of item.active_choices||[]) {a.append(node("p","knowledge-choice",choice.summary));details(a,`원문 ${choice.record_id}`);}
    if(item.status==="withdrawn")a.append(node("p","knowledge-muted","철회 전 결정을 되살리지 않습니다."));
    if(item.status==="conflict")a.append(node("p","knowledge-warning","서로 다른 선택이 남아 있습니다. 정정이 필요합니다."));
    if(item.truncated||item.active_choices_truncated)a.append(node("p","knowledge-warning","결정 이력 또는 선택 일부만 표시합니다. 전체 확인이 필요합니다."));
    if(item.status==="unconfirmed")a.append(node("p","knowledge-muted","제안·과거 보고만 있어 현재 결정으로 쓰지 않습니다."));
    details(a,`주제 ${item.subject} · 마지막 기록 ${item.last_record_id}`);return a;
  }
  function renderPlans(item){
    const a=card(item.title,scope(item)),p=item.progress,selected=item.selected_progress;
    const progress=node("div","knowledge-progress");progress.append(node("strong","",`${p.percent}%`),node("span","",`필수 ${p.completed_reported}/${p.required}개 완료 보고`));
    const meter=node("progress","");meter.max=100;meter.value=p.percent;meter.setAttribute("aria-label",`${item.title} 보고된 진행률`);a.append(progress,meter);
    if(filters.component)a.append(node("p","knowledge-muted",`진행률은 계획 전체 · 선택 구성요소 필수 ${selected.remaining}개 남음`));
    if(item.projection_truncated)a.append(node("p","knowledge-warning","남은 항목 상세가 생략됐습니다. 계획에서 확인하세요."));
    for(const remaining of item.remaining_items||[]){const row=node("div","knowledge-plan-item");row.append(tag(itemLabels[remaining.state]||remaining.state),node("strong","",remaining.title));
      for(const condition of remaining.criteria||[])row.append(node("p","knowledge-condition",`완료 조건 · ${condition.text}${condition.reported_met===true?" · 충족 보고":condition.reported_met===false?" · 미충족 보고":" · 보고 없음"}`));
      if(remaining.criteria_truncated)row.append(node("small","knowledge-muted","완료 조건 일부 표시"));
      if(remaining.note)row.append(node("p","knowledge-muted",remaining.note));
      if(remaining.run_id)row.append(action("연결 작업 보기",()=>onTask(remaining.run_id)));
      a.append(row);
    }
    if(item.remaining_truncated)a.append(node("p","knowledge-warning",`남은 항목 ${item.remaining_total}개 중 8개 표시`));
    if(item.remaining_total===0)a.append(node("p","knowledge-muted","선택 범위에 남은 항목이 없습니다. 완료 보고는 검사 통과와 별개입니다."));
    a.append(action("계획·완료 조건 보기",()=>onPlan(item)));return a;
  }
  function renderChecks(item){
    const a=card(item.name),k=item.current_knowledge;
    if(!k){a.append(tag("판단할 근거 부족"),node("p","knowledge-muted","조회 일부가 생략됐습니다. 기능 상세에서 확인하세요."));}
    else {
      a.append(tag(checkLabels[k.status]||"판단할 근거 부족",k.status));
      if(k.counts.current)a.append(node("p","knowledge-check-count",`현재 코드 검사 · 통과 ${k.counts.passed} / 실패 ${k.counts.failed}`));
      if(k.counts.stale)a.append(node("p","knowledge-muted",`코드 변경 전 검사 ${k.counts.stale}건`));
      if(k.counts.unknown)a.append(node("p","knowledge-muted",`비교·결과 확인 불가 ${k.counts.unknown}건`));
      if(!k.evidence.length)a.append(node("p","knowledge-muted",item.agent_report?"AI 보고만 있습니다. 직접 수집한 검사 결과가 없습니다.":"직접 수집한 검사 결과가 없습니다."));
      for(const evidence of k.evidence){
        const row=node("div",`knowledge-check-row ${evidence.result}`);
        row.append(node("span","",`${evidence.result==="passed"?"통과":evidence.result==="failed"?"실패":"결과 미확인"} · ${evidence.status==="current"?"현재 코드":evidence.status==="stale"?"이전 코드":"코드 비교 불가"}`));
        if(evidence.counts)row.append(node("small","",`${evidence.counts.tests}개 검사 · 통과 ${evidence.counts.passed} / 실패 ${evidence.counts.failed}`));
        row.append(action("검사한 작업 보기",()=>onTask(evidence.run_id)));details(row,`실행 ${evidence.execution_id} · 판단 이유 ${evidence.reason}`);a.append(row);
      }
      if(k.truncated||k.evidence_truncated)a.append(node("p","knowledge-warning","검사 일부만 표시합니다. 이 범위를 전체 성공으로 해석하지 마세요."));
    }
    details(a,`기능 ${item.key} · 상세 검사는 연결된 작업에서 확인하세요.`);return a;
  }
  function render(){
    const body=dialog.querySelector(".knowledge-body"),scroll=body.scrollTop;
    const open=new Set([...body.querySelectorAll("details[open]")].map(n=>n.textContent));
    body.replaceChildren(renderSection("decisions","현재 결정","명시적인 정정·철회 관계 기준",renderDecisions),renderSection("plans","계획과 남은 일","AI가 보고한 진행률 · 검증과 별개",renderPlans),renderSection("checks","검사 근거","현재 코드와 검사 당시 코드 비교",renderChecks));
    for(const d of body.querySelectorAll("details"))d.open=open.has(d.textContent);body.scrollTop=scroll;
  }
  function schedule(){clearTimeout(timer);if(dialog.open)timer=setTimeout(()=>{if(!document.hidden)void load();else schedule();},15000);}
  async function load(more){
    const ticket=++epoch;clearTimeout(timer);
    const scopeKey=JSON.stringify(filters);
    if(scopeKey!==displayScope){pages={};revision=undefined;dialog.querySelector(".knowledge-body").replaceChildren(node("p","knowledge-empty","선택한 범위의 기록을 확인합니다…"));displayScope=scopeKey;}
    const params=new URLSearchParams({project:project.id});
    for(const [k,v] of Object.entries(filters))if(v)params.set(k,v);
    if(more)params.set(`${more==="checks"?"features":more}_offset`,String(pages[more].next_offset));
    dialog.querySelector(".knowledge-status").textContent="현재 기록을 확인하는 중…";
    try{
      const data=await request(`/api/current-knowledge?${params}`);if(ticket!==epoch||!dialog.open)return;
      if(more&&revision!==data.project_revision){await load();return;}
      revision=data.project_revision;
      for(const key of ["decisions","plans","checks"])pages[key]=more===key?{...data[key],items:[...pages[key].items,...data[key].items]}:more?pages[key]:data[key];
      for(const name of ["repository","environment"]){const select=dialog.querySelector(`[name=${name}]`),values=[...new Set(data.available_scopes.map(s=>s[name]))];
        select.replaceChildren();const all=node("option","",name==="repository"?"전체 저장소":"전체 환경");all.value="";select.append(all);
        for(const v of new Set([...values,...(filters[name]?[filters[name]]:[])])){const option=node("option","",v);option.value=v;select.append(option);}select.value=filters[name];
      }
      const componentSelect=dialog.querySelector('[name=component]');
      const known=new Map([...components,...(data.available_components||[])].map(c=>[c.key,c]));
      if(filters.component&&!known.has(filters.component)&&filters.component!=="unclassified")known.set(filters.component,{key:filters.component,name:filters.component});
      componentSelect.replaceChildren();
      for(const c of [{key:"",name:"전체 구성요소"},...known.values(),{key:"unclassified",name:"미분류"}]){const opt=node("option","",c.name);opt.value=c.key;componentSelect.append(opt);}componentSelect.value=filters.component;
      render();dialog.querySelector(".knowledge-status").textContent=`${new Date(data.observed_at).toLocaleTimeString("ko-KR")} 확인 · 일부씩 조회${data.scopes_truncated||data.components_truncated?" · 범위 목록 일부 표시":""}`;
    }catch(error){if(ticket===epoch&&dialog.open)dialog.querySelector(".knowledge-status").textContent=`조회 실패 · ${error.message}${Object.keys(pages).length?" · 이전 조회 결과 표시 중":""}`;}
    finally{if(ticket===epoch)schedule();}
  }
  return {async open(value,options={}){
    if(!value)throw new Error("먼저 서비스를 선택하세요.");
    if(!dialog){dialog=node("dialog","knowledge-dialog");dialog.setAttribute("aria-label","현재 지식");dialog.addEventListener("close",()=>{cancel();opener?.focus();});document.body.append(dialog);}
    cancel();project=value;components=options.components||[];pages={};revision=undefined;opener=document.activeElement;
    filters.repository="";filters.environment="";filters.component=options.component||"";displayScope="";
    const header=node("header","knowledge-header"),title=node("div","");title.append(node("p","eyebrow",project.name),node("h2","","지금, 이 프로젝트"),node("p","knowledge-subtitle","결정은 무엇이고, 어디까지 했고, 무엇을 확인했는지."));
    const actions=node("div","knowledge-actions"),refresh=node("button","button quiet","새로고침"),close=node("button","button quiet","닫기");refresh.addEventListener("click",()=>void load());close.addEventListener("click",()=>dialog.close());actions.append(refresh,close);header.append(title,actions);
    const toolbar=node("div","knowledge-toolbar");
    for(const [name,label] of [["component","구성요소"],["repository","저장소"],["environment","환경"]]){const wrapper=node("label","",label),select=node("select","");select.name=name;
      const all=node("option","",`전체 ${label}`);all.value="";select.append(all);
      if(name==="component"){for(const c of [...components,{key:"unclassified",name:"미분류"}]){const opt=node("option","",c.name);opt.value=c.key;select.append(opt);}select.value=filters.component;}
      select.addEventListener("change",()=>{filters[name]=select.value;void load();});wrapper.append(select);toolbar.append(wrapper);}
    const status=node("p","knowledge-status");status.setAttribute("role","status");toolbar.append(status);
    const body=node("div","knowledge-body"),footer=node("footer","knowledge-footer","현재 적용된 결정·완료 보고·실행 관측을 구분합니다. 최신 기록이나 코드 일치만으로 기능 전체가 검증되지는 않습니다.");
    dialog.replaceChildren(header,toolbar,body,footer);if(!dialog.open)dialog.showModal();await load();
  }};
}
