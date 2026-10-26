import { createViewerSession } from './session.js';

const names={begin:'작업 시작',checkpoint:'진행 기록',finish:'작업 종료','save-plan':'계획 저장','update-plan':'계획 진행','event-link':'이벤트 연결','skill-register':'스킬 등록','skill-assign':'설치 지정','skill-checkpoint':'스킬 사용 보고'};
const states={recovery_pending:['전송 대기','원문은 이 컴퓨터에 보관 중입니다.'],persistence_unknown:['저장 확인 필요','이미 저장됐을 수 있습니다. 같은 요청으로 확인합니다.'],auth_required:['인증 필요','호스트 인증을 갱신한 뒤 같은 보관함으로 다시 연결해 주세요.'],access_denied:['권한 확인 필요','현재 연결의 프로젝트 접근 권한을 확인해 주세요.'],blocked:['복구 차단','대상이나 원문이 달라 안전한 재전송을 멈췄습니다.'],saved:['저장 확인','원래 요청의 저장 영수증을 확인했습니다.']};
const node=(tag,className,text)=>{const el=document.createElement(tag);el.className=className;if(text!==undefined)el.textContent=text;return el;};
const messages={write_context_changed:'연결 계정·저장소·호스트 문맥이 바뀌었습니다.',idempotency_conflict:'같은 요청 키에 다른 내용이 있습니다.',project_write_blocked:'이전 연결의 쓰기가 차단됐습니다.',connection_failed:'서버에 연결하지 못했습니다.',connection_timeout:'응답 대기 시간이 지났습니다.',authentication_required:'유효한 인증이 필요합니다.',access_denied:'현재 연결에 필요한 권한이 없습니다.'};
export function renderRemoteRecovery(root,data,{refresh,recover,busy=false}={}){
 const expanded=new Set([...root.querySelectorAll('.remote-request details[open]')].map(d=>d.closest('.remote-request').dataset.requestId));
 root.replaceChildren();const header=node('header','remote-heading'),intro=node('div','');
 intro.append(node('span','remote-eyebrow','DELIVERY'),node('h2','','원격 저장'),node('p','remote-caption','보관한 요청의 상태 · 기록 내용의 사실 검증과는 별개'));
 const reload=node('button','button quiet','새로고침');reload.disabled=busy;reload.addEventListener('click',()=>refresh?.());header.append(intro,reload);root.append(header);
 if(!data.configured){root.append(node('p','remote-note','이 화면에 원격 보관함이 연결되지 않았습니다. 기존 로컬 기록은 그대로 사용할 수 있습니다.'));return;}
 const scope=data.scope??{};root.append(node('p','remote-scope',`${scope.repository??''} / ${scope.environment??''} · 프로젝트 ${scope.project_id??''}`));
 const totals=data.counts??{},counts=node('div','remote-totals');
 for(const [label,count,tone]of [['전송 대기',totals.recovery_pending??0,'waiting'],['확인 필요',(totals.persistence_unknown??0)+(totals.auth_required??0)+(totals.access_denied??0)+(totals.blocked??0),'attention'],['저장 확인',totals.saved??0,'saved']]){const cell=node('div',`remote-total ${tone}`);cell.append(node('strong','',String(count)),node('span','',label));counts.append(cell);}root.append(counts);
 const controls=node('div','remote-controls'),retry=node('button','button remote-primary','대기 요청 복구');retry.disabled=busy||data.busy||data.recording_enabled===false||!['recovery_pending','persistence_unknown','auth_required','access_denied'].some(key=>totals[key]>0);retry.addEventListener('click',()=>recover?.());controls.append(retry,node('span','remote-caption',data.recording_enabled===false?'기록 중단 상태 · 전송하지 않습니다.':'최대 3건 · 원래 입력과 키 유지'));root.append(controls);
 const list=node('div','remote-requests');
 for(const item of data.items??[]){
  const [label,detail]=states[item.state]??['상태 확인 필요','보관함을 확인해 주세요.'];const row=node('article','remote-request');row.dataset.state=item.state;row.dataset.requestId=item.request_id;
  const mark=node('span','remote-route');mark.setAttribute('aria-hidden','true');mark.append(node('i','',''),node('i','',''),node('i','',''));
  const content=node('div','remote-request-content'),heading=node('div','remote-request-heading');heading.append(node('strong','',names[item.operation]??'업무 요청'),node('span','remote-state',label));
  content.append(heading,node('p','remote-caption',detail));
  if(item.state!=='saved'&&item.remote_persistence==='unknown')content.append(node('p','remote-unknown','원격 저장 여부 미확인 · 다시 보내도 원래 요청의 중복을 확인합니다.'));
  if(item.last_error)content.append(node('p','remote-caption',messages[item.last_error]??'원래 요청은 보존했습니다. 호스트의 연결 상태를 확인해 주세요.'));
  const details=node('details','remote-meta');details.open=expanded.has(item.request_id);details.append(node('summary','','요청 정보'));
  details.append(node('p','',`요청 ${item.request_id}`),node('p','',`보관: ${item.created_at?new Date(item.created_at).toLocaleString('ko-KR'):'시각 미수집'}`));
  const receipt=item.receipt??{};for(const key of ['run_id','record_id','plan_key','skill_key'])if(receipt[key])details.append(node('p','',`${key}: ${receipt[key]}`));content.append(details);
  row.append(mark,content);
  if(item.state!=='saved'&&item.state!=='blocked'){const action=node('button','button quiet','다시 확인');action.disabled=busy||data.busy||data.recording_enabled===false;action.addEventListener('click',()=>recover?.([item.request_id]));row.append(action);}list.append(row);
 }
 if(!data.items?.length)list.append(node('p','remote-empty','이 페이지에 보관된 요청이 없습니다.'));root.append(list);
 if(data.next_offset!==null&&data.next_offset!==undefined){const more=node('button','button','다음 요청 보기');more.disabled=busy;more.addEventListener('click',()=>refresh?.(data.next_offset));root.append(more);}
 if(data.last_recovery){const result=node('div','remote-result');result.setAttribute('role','status');const items=data.last_recovery.results??[];result.textContent=`최근 복구: 저장 확인 ${items.filter(i=>i?.state==='saved').length}건 / 처리 ${items.length}건. 나머지는 목록의 상태를 확인해 주세요.`;root.append(result);}
 root.append(node('p','remote-note','이 화면의 조회·새로고침은 전송하지 않습니다. 보관되지 않은 요청이나 받지 못한 이벤트의 누락 개수는 알 수 없습니다. 인증키 입력·자동 로그인은 제공하지 않습니다.'));
}
export function createRemoteRecovery({api,button}){
 const dialog=node('dialog','remote-dialog'),root=node('section','remote-shell'),close=node('button','button remote-close','닫기');dialog.append(close,root);document.body.append(dialog);close.addEventListener('click',()=>dialog.close());
 let busy=false,offset=0;
 const refresh=async(next=offset)=>{if(busy)return;busy=true;offset=next;try{const data=await api(`/api/remote-recovery?offset=${offset}`);renderRemoteRecovery(root,data,{refresh,recover,busy:false});}catch(error){root.replaceChildren(node('p','remote-note',error.message));}finally{busy=false;}};
 const recover=async(ids)=>{if(busy)return;busy=true;root.querySelectorAll('button').forEach(b=>{b.disabled=true;});try{await api('/api/remote-recovery/recover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ids?{request_ids:ids}:{})});}catch(error){root.append(node('p','remote-note',error.message));}finally{busy=false;await refresh();}};
 button?.addEventListener('click',()=>{dialog.showModal();void refresh();});
 return {refresh,root,dialog};
}
const standalone=document.querySelector('#remote-recovery-page');
if(standalone){
 const session=createViewerSession({location,history,getStorage:()=>localStorage});
 const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{...options.headers,...session.headers()}});if(response.status===401)session.reject();const data=await response.json();if(!response.ok)throw Error(data.error??'연결을 확인해 주세요.');session.confirm();return data;};
 let working=false,pageOffset=0;
 const refresh=async(offset=pageOffset)=>{if(working)return;working=true;pageOffset=offset;try{const data=await api(`/api/remote-recovery?offset=${offset}`);renderRemoteRecovery(standalone,data,{refresh,recover});}catch(error){standalone.replaceChildren(node('p','remote-note',error.message));}finally{working=false;}};
 const recover=async(ids)=>{if(working)return;working=true;standalone.querySelectorAll('button').forEach(b=>{b.disabled=true;});try{await api('/api/remote-recovery/recover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ids?{request_ids:ids}:{})});}catch(error){standalone.append(node('p','remote-note',error.message));}finally{working=false;await refresh();}};
 void refresh();setInterval(()=>{if(!document.hidden&&!working)void refresh();},15000);
}
