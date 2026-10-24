const labels={current:"현재 적용",conflict:"선택 충돌",withdrawn:"철회됨",unconfirmed:"결정 대기",unknown:"확인 필요"};
const eventLabels={current:"현재 선택",previous:"정정 전",withdrawn:"철회된 선택",withdrawal:"철회 기록",proposal:"AI 제안",historical:"소급·시점 미지정",unknown:"확인 필요"};
const identity=v=>JSON.stringify([v.repository,v.environment,v.subject,v.component_key||"",v.feature_key||""]);

export function createDecisionLibrary({document,request}) {
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  let dialog,project,selected=null,epoch=0,timer,opener,historyPage=0;
  function cancel(){epoch++;clearTimeout(timer);}
  function ensure(){
    if(dialog)return;
    dialog=node("dialog","decision-library");dialog.setAttribute("aria-label","결정과 변경 이력");
    dialog.addEventListener("close",()=>{cancel();opener?.focus();});document.body.append(dialog);
  }
  async function load(more=false){
    const current=++epoch;clearTimeout(timer);
    const offset=more?Number(dialog.dataset.next):0;
    try{
      const page=await request(`/api/decisions?project=${project.id}&offset=${offset}`);
      if(current!==epoch||!dialog.open)return;
      const list=dialog.querySelector(".decision-list");if(!more)list.replaceChildren();
      if(page.schema_supported===false){list.append(node("p","catalog-note","이 DB의 결정 연결 정보는 아직 준비되지 않았습니다. 기존 원문은 그대로 유지됩니다."));dialog.querySelector(".decision-content").replaceChildren(node("p","catalog-note","결정 조회는 DB v13에서 지원합니다. 화면은 DB를 갱신하지 않습니다."));return;}
      selected=page.items.find(item=>selected&&identity(item)===identity(selected))||selected||page.items[0];
      for(const item of page.items){
        const button=node("button",`decision-choice ${item.status}`);button.setAttribute("aria-pressed",String(Boolean(selected&&identity(selected)===identity(item))));
        button.append(node("span","decision-label",labels[item.status]||"확인 필요"),node("strong","",item.title),node("small","catalog-note",`${item.component_name||item.component_key||"서비스 공통"} · ${item.repository} · ${item.environment}`));
        button.addEventListener("click",()=>{selected=item;historyPage=0;void load();});list.append(button);
      }
      if(!list.children.length)list.append(node("p","catalog-note","등록된 결정이 없습니다. AI에게 사용자 발언의 출처와 함께 결정을 남기도록 요청하세요. 예전 일반 기록은 자동 분류하지 않습니다."));
      dialog.dataset.next=page.next_offset??"";dialog.querySelector(".decision-more").hidden=page.next_offset===null;
      selected=page.items.find(item=>selected&&identity(item)===identity(selected))||selected||page.items[0];
      if(selected){
        const p=new URLSearchParams({project:project.id,subject:selected.subject,repository:selected.repository,environment:selected.environment,
          component:selected.component_key||"",feature:selected.feature_key||"",history_offset:String(historyPage)});
        const detail=await request(`/api/decisions?${p}`);if(current!==epoch||!dialog.open)return;
        const item=detail.items.find(v=>identity(v)===identity(selected));
        if(item)render(item);
      }
      timer=setTimeout(()=>{if(dialog.open)void load();},15000);
    }catch(error){if(current===epoch&&dialog.open)dialog.querySelector(".decision-content").replaceChildren(node("p","decision-error",error.message||"결정을 읽지 못했습니다. 새로고침으로 다시 확인하세요."));}
  }
  function render(item){
    const content=dialog.querySelector(".decision-content"),expanded=new Set([...content.querySelectorAll("details[open]")].map(n=>n.dataset.record));
    const viewKey=JSON.stringify([identity(item),historyPage]),scrollTop=content.dataset.viewKey===viewKey?content.scrollTop:0;
    const fragment=document.createDocumentFragment();
    fragment.append(node("p","eyebrow",`${item.repository} / ${item.subject}`),node("h3","",item.title));
    const current=node("section",`decision-current ${item.status}`);
    current.append(node("span","decision-label",labels[item.status]||"확인 필요"));
    if(item.status==="conflict")current.append(node("p","","서로 다른 선택이 남아 있습니다. 하나를 최신 기록으로 덮지 않고, 명시적인 정정이나 철회를 기다립니다."));
    if(item.status==="withdrawn")current.append(node("p","","현재 적용할 선택이 없습니다. 철회 전 결정을 자동으로 되살리지 않습니다."));
    if(item.status==="unconfirmed")current.append(node("p","","AI 제안이나 과거 보고만 있습니다. 현재 적용할 사용자 결정으로 보지 않습니다."));
    if(item.status==="unknown")current.append(node("p","","조회 한도를 넘어 전체 관계를 확인하지 못했습니다. 표시된 기록만으로 결론을 내리지 마세요."));
    for(const choice of item.active_choices){const choiceNode=node("div","decision-current-choice");choiceNode.append(node("strong","",choice.summary),node("small","catalog-note",`선택 ${choice.choice_key} · ${choice.record_id}`));current.append(choiceNode);}
    if(item.active_choices_truncated)current.append(node("p","catalog-note","현재 선택 일부만 표시합니다. AI에게 전체 활성 기록 ID를 조회하도록 요청하세요."));
    fragment.append(current,node("p","decision-disclaimer","‘현재 적용’은 기록된 결정의 관계를 뜻합니다. 발언 출처는 AI가 제공한 정보이며, 사용자 인증이나 사실 검증 완료가 아닙니다."));
    const history=node("section","decision-history");history.append(node("h4","",`결정이 바뀐 흐름 · ${item.events_total}건`));
    for(const entry of item.history){
      const event=node("article",`decision-event ${entry.state}`),head=node("div","decision-event-head");
      head.append(node("span","decision-label",eventLabels[entry.state]||"확인 필요"),node("time","",new Date(entry.recorded_at).toLocaleString("ko-KR")));event.append(head,node("p","decision-body",entry.body));
      const original=node("details","decision-original");original.dataset.record=entry.record_id;original.open=expanded.has(entry.record_id);
      original.append(node("summary","","출처와 연결 정보"),node("blockquote","",entry.decision.source.quote),
        node("p","catalog-note",`${entry.decision.source.kind==="user_statement"?"사용자 발언으로 보고":"AI 제안"} · ${entry.decision.source.reference}`),
        node("p","catalog-note",`원문 기록 ${entry.record_id} · 작업 ${entry.run_id}`));
      if(entry.decision.targets.length)original.append(node("p","catalog-note",`변경한 기록 ${entry.decision.targets.join(", ")}`));
      if(entry.body_truncated)original.append(node("p","catalog-note","긴 원문 일부를 표시합니다. AI에게 이 기록 ID의 원문 조회를 요청하세요."));
      event.append(original);history.append(event);
    }
    if(item.history_next_offset!==null){const more=node("button","button quiet","이전 기록 보기");more.addEventListener("click",()=>{historyPage=item.history_next_offset;void load();});history.append(more);}
    if(historyPage){const recent=node("button","button quiet","최근 기록으로");recent.addEventListener("click",()=>{historyPage=0;void load();});history.append(recent);}
    fragment.append(history);content.replaceChildren(fragment);content.dataset.viewKey=viewKey;content.scrollTop=scrollTop;
  }
  return {async open(value){
    if(!value)throw new Error("먼저 서비스를 선택하세요.");ensure();cancel();project=value;selected=null;historyPage=0;opener=document.activeElement;
    const header=node("header","decision-header"),titles=node("div","");titles.append(node("p","eyebrow",project.name),node("h2","","결정과 변경 이력"));
    const actions=node("div","decision-actions"),refresh=node("button","button quiet","새로고침"),close=node("button","button quiet","닫기");
    refresh.addEventListener("click",()=>{void load();});close.addEventListener("click",()=>dialog.close());actions.append(refresh,close);header.append(titles,actions);
    const workspace=node("div","decision-workspace"),nav=node("nav","decision-navigation");nav.setAttribute("aria-label","결정 주제");
    const list=node("div","decision-list"),more=node("button","button quiet decision-more","주제 더 보기");more.hidden=true;more.addEventListener("click",()=>{void load(true);});nav.append(list,more);
    workspace.append(nav,node("section","decision-content"));dialog.replaceChildren(header,workspace);if(!dialog.open)dialog.showModal();await load();
  }};
}
