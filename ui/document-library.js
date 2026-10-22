// Preserve all original characters; highlight the range from first to last differing line.
export function documentChangeRange(before, after) {
  const a=before.match(/[^\n]*\n|[^\n]+$/g)??[],b=after.match(/[^\n]*\n|[^\n]+$/g)??[];
  let start=0,end=0;
  while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  while(end<a.length-start&&end<b.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  const split=lines=>[lines.slice(0,start).join(''),lines.slice(start,lines.length-end).join(''),end?lines.slice(-end).join(''):''];
  return {before:split(a),after:split(b),identical:before===after};
}

export function createDocumentLibrary({document,request}) {
  const node=(tag,className='',text)=>{const n=document.createElement(tag);n.className=className;if(text!==undefined)n.textContent=text;return n;};
  const dialog=node('dialog','document-library');dialog.setAttribute('aria-labelledby','document-library-title');
  const heading=node('header','library-heading'),title=node('h2','','가져온 문서');title.id='document-library-title';
  const close=node('button','button quiet','닫기'),refresh=node('button','button','보관함 새로고침'),projectLabel=node('p','catalog-note');
  heading.append(node('div','eyebrow','SOURCE ARCHIVE'),title,projectLabel,refresh,close);
  const notice=node('p','library-notice','소급 · 미검증 자료입니다. 가장 최근 보관본도 현재 사실이나 원본 작성 순서를 뜻하지 않습니다.');
  const workspace=node('div','library-workspace'),sidebar=node('section','library-sidebar'),main=node('section','library-detail');main.setAttribute('aria-label','문서 버전과 출처 비교');
  const search=node('input');search.type='search';search.maxLength=200;search.placeholder='문서 이름·저장 위치 검색';search.setAttribute('aria-label','가져온 문서 검색');
  const searchButton=node('button','button','검색'),searchRow=node('div','library-search');searchRow.append(search,searchButton);
  const list=node('div','library-list');list.setAttribute('aria-label','가져온 문서 목록');
  const more=node('button','button','문서 더 보기');more.hidden=true;sidebar.append(searchRow,list,more);workspace.append(sidebar,main);
  const status=node('p','library-status');status.setAttribute('role','status');dialog.append(heading,notice,workspace,status);document.body.append(dialog);
  let project,items=[],next=null,query='',selected=null,data=null,versions=[],versionOffset=null,epoch=0,listRequest=0,detailRequest=0;
  const date=value=>new Date(value).toLocaleString('ko-KR',{hour12:false});
  const sourceLabel=source=>source==='viewer'?'로컬 화면 · 서비스 공통':source.startsWith('component:')?'구성요소 '+source.slice(10):'연결 출처 · '+source;
  function error(message){status.textContent=message?.message||'문서를 읽지 못했습니다. 다시 확인해 주세요.';}
  function renderList(){
    list.replaceChildren();more.hidden=next===null;
    if(!items.length)list.append(node('p','catalog-note','가져온 문서가 없습니다. 문서 가져오기에서 선택한 원문을 보관해 주세요.'));
    for(const item of items){const card=node('button','task-card'+(selected===item.id?' selected':''));card.setAttribute('aria-pressed',String(selected===item.id));
      card.append(node('strong','task-goal',item.path),node('span','library-count',`${item.version_count}개 보관본 · 소급·미검증`),node('small','catalog-note',`${item.repository} / ${item.environment}`),node('small','catalog-note',sourceLabel(item.source_root)),node('small','catalog-note',date(item.imported_at)));
      card.addEventListener('click',()=>{void loadDetail(item.id).catch(error);});list.append(card);}
  }
  async function loadList(append=false){
    if(append&&next===null)return;
    const generation=epoch,key=++listRequest,pid=project.id;
    status.textContent='보관 문서를 조회하는 중…';
    let result;
    try { result=await request(`/api/documents?${new URLSearchParams({project:pid,offset:String(append?next:0),query})}`); }
    catch(e) { if(generation===epoch&&key===listRequest)throw e;return; }
    if(generation!==epoch||key!==listRequest)return;
    items=append?[...new Map([...items,...result.items].map(i=>[i.id,i])).values()]:result.items;next=result.next_offset;
    renderList();status.textContent=result.unavailable||`문서 ${items.length}${next!==null?'+':''}개 · 보관함은 열기·새로고침 시 조회합니다.`;
    if(!selected&&items[0])await loadDetail(items[0].id);
    else if(selected&&!append)await loadDetail(selected,data?.current.id,data?.previous?.id);
  }
  async function loadDetail(id,version,compare,offset=0,append=false){
    const generation=epoch,key=++detailRequest,pid=project.id;
    const switched=selected!==id;selected=id;renderList();
    if(switched||!data){main.replaceChildren(node('p','loading','원문과 버전을 불러오는 중…'));data=null;versions=[];}
    const params=new URLSearchParams({project:pid,document:id,offset:String(offset)});if(version)params.set('version',version);if(compare)params.set('compare',compare);
    let result;
    try { result=await request('/api/document?'+params); }
    catch(e) { if(generation===epoch&&key===detailRequest){main.replaceChildren(node('p','recovery-note','원문을 표시하지 못했습니다. 조각·출처·해시 상태를 확인하고 다시 조회해 주세요.'));throw e;}return; }
    if(generation!==epoch||key!==detailRequest)return;
    data=result;versions=append?[...new Map([...versions,...result.versions.items].map(v=>[v.id,v])).values()]:result.versions.items;versionOffset=result.versions.next_offset;
    renderDetail();status.textContent='보관 원문을 읽었습니다. 내용의 정확성은 검증하지 않았습니다.';
  }
  function picker(label,entries,value,onChange){const field=node('label','import-field');field.append(node('span','',label));const select=node('select');select.setAttribute('aria-label',label);
    for(const entry of entries){const option=node('option','',entry.label);option.value=entry.id;select.append(option);}select.value=value??'';
    select.addEventListener('change',()=>{void onChange(select.value).catch(error);});field.append(select);return field;}
  function renderDetail(){
    main.replaceChildren();const current=data.current,previous=data.previous;
    main.append(node('div','eyebrow','SAVED ORIGINAL · 소급·미검증'),node('h3','library-document-title',current.path));
    const choices=[...new Map([...versions,current,...(previous&&data.comparison_kind==='same_document'?[previous]:[])].map(v=>[v.id,v])).values()];
    const controls=node('div','library-version-controls');
    controls.append(picker('볼 버전',choices.map(v=>({id:v.id,label:`${date(v.imported_at)} · ${v.sha256.slice(0,10)}`})),current.id,value=>loadDetail(selected,value,previous?.id)));
    const comparison=[...new Map([...choices,...items,...(previous?[previous]:[])].map(v=>[v.id,v])).values()];
    controls.append(picker('비교할 보관본',[{id:'',label:'이전 보관본 자동 선택'},...comparison.map(v=>({id:v.id,label:`${v.path} · ${v.repository}/${v.environment} · ${sourceLabel(v.source_root)} · ${date(v.imported_at)} · ${v.sha256.slice(0,8)}`}))],previous?.id,value=>loadDetail(selected,current.id,value||undefined)));
    main.append(controls);
    if(versionOffset!==null){const button=node('button','button','이전 버전 더 보기');button.addEventListener('click',()=>{void loadDetail(selected,current.id,previous?.id,versionOffset,true).catch(error);});main.append(button);}
    main.append(node('p','catalog-note',`이 출처의 보관본 ${data.versions.total}개 · ${choices.length}개 버전 선택지 표시. 새로고침은 선택한 버전을 유지합니다. 다른 출처는 왼쪽에 불러온 문서도 비교 대상으로 선택할 수 있습니다.`));
    main.append(node('p','library-comparison-kind',data.comparison_kind==='different_source_or_document'?'다른 출처·문서 비교 · 같은 문서의 버전 이력으로 합치지 않습니다.':previous?'같은 출처·문서의 보관본 비교':'첫 보관본 · 비교할 이전 버전이 없습니다.'));
    const metadata=node('table','library-source-table');metadata.setAttribute('aria-label','출처 비교');
    const header=node('tr');for(const label of ['출처 항목','비교 보관본','선택한 보관본'])header.append(node('th','',label));metadata.append(header);
    const fields=[['문서 이름','path'],['저장소','repository'],['환경','environment'],['출처 식별자','source_root'],['보관 시각','imported_at'],['바이트','bytes'],['내용 해시','sha256']];
    for(const [label,key]of fields){const tr=node('tr');tr.append(node('th','',label),node('td','',previous?(key==='imported_at'?date(previous[key]):String(previous[key])):'없음'),node('td','',key==='imported_at'?date(current[key]):String(current[key])));metadata.append(tr);}main.append(metadata);
    main.append(node('p','catalog-note','출처는 가져올 때 전달된 이름·식별자입니다. 실제 파일 위치와 내용의 사실 여부는 확인하지 않았습니다. 저장된 바이트와 보관 해시의 일치만 검사합니다.'));
    const range=previous?documentChangeRange(previous.text,current.text):null;
    main.append(node('p','library-diff-caption',!previous?'원문은 수정하지 않고 표시합니다.':range.identical?'두 원문이 같습니다.':'강조 영역은 첫 차이부터 마지막 차이까지입니다. 정밀한 줄 단위 변경 목록은 아닙니다.'));
    const panes=node('div','library-originals');
    const original=(label,version,segments)=>{const pane=node('section','library-original');pane.append(node('h4','',label));const pre=node('pre');pre.setAttribute('aria-label',label);pre.tabIndex=0;
      if(!version)pre.textContent='비교할 이전 보관본이 없습니다.';
      else if(segments){pre.append(document.createTextNode(segments[0]));const mark=node('mark','',segments[1]);pre.append(mark,document.createTextNode(segments[2]));}
      else pre.textContent=version.text;pane.append(pre);return pane;};
    panes.append(original('비교 보관본 원문',previous,range?.before),original('선택한 보관본 원문',current,range?.after));main.append(panes);
    const references=node('details','library-references');references.append(node('summary','','원문 기록 ID'));
    references.append(node('p','catalog-note',`선택 ${current.record_ids.join(', ')}`));if(previous)references.append(node('p','catalog-note',`비교 ${previous.record_ids.join(', ')}`));main.append(references);
  }
  close.addEventListener('click',()=>{epoch++;dialog.close();});dialog.addEventListener('cancel',()=>{epoch++;});
  function searchDocuments(){detailRequest++;query=search.value||'';items=[];next=null;selected=null;data=null;main.replaceChildren();renderList();void loadList().catch(error);}
  searchButton.addEventListener('click',searchDocuments);
  search.addEventListener('keydown',event=>{if(event.key==='Enter')searchDocuments();});
  more.addEventListener('click',()=>{void loadList(true).catch(error);});refresh.addEventListener('click',()=>{void loadList().catch(error);});
  return {async open(selectedProject){if(!selectedProject?.id)return;epoch++;project=selectedProject;items=[];next=null;query='';selected=null;data=null;versions=[];search.value='';list.replaceChildren();main.replaceChildren();projectLabel.textContent=`${project.name} · 원본 보존 · 읽기 전용`;dialog.showModal();try{await loadList();}catch(e){error(e);}}};
}
