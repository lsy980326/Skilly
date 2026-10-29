export function formatAttachmentBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '확인 불가';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function attachmentPreviewKind(bytes, name) {
  const starts = signature => signature.every((value, index) => bytes[index] === value);
  const bounded=(w,h)=>w>0&&h>0&&w<=2048&&h<=2048&&w*h<=4*1024*1024;
  if (starts([137,80,78,71,13,10,26,10])&&bytes.length>=33) {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(view.getUint32(8)!==13||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR'||!bounded(view.getUint32(16),view.getUint32(20)))return null;
    for(let at=8;at+12<=bytes.length;){const size=view.getUint32(at);if(size>bytes.length-at-12)return null;
      const type=String.fromCharCode(...bytes.subarray(at+4,at+8));if(type==='acTL')return null;if(type==='IEND')return 'image/png';at+=size+12;}
    return null;
  }
  if (starts([255,216,255])) {
    // Read dimensions without decoding a compressed raster. Animated/unknown formats are download-only.
    for(let at=2;at+3<Math.min(bytes.length,65536);){if(bytes[at++]!==255)return null;while(bytes[at]===255)at++;const marker=bytes[at++];
      if(marker===0xd9||marker===0xda||at+2>bytes.length)return null;
      if(marker===0x01||marker>=0xd0&&marker<=0xd8)continue;
      const size=bytes[at]*256+bytes[at+1];if(size<2||at+size>bytes.length)return null;
      if(marker===0xc0||marker===0xc2){if(size<8)return null;return bounded(bytes[at+5]*256+bytes[at+6],bytes[at+3]*256+bytes[at+4])?'image/jpeg':null;}at+=size;
    }
    return null;
  }
  return /\.(?:md|txt|csv|json|log)$/i.test(name) ? 'text/plain' : null;
}

export function createAttachments({ document, request, headers, onUnauthorized }) {
  const node = (tag, className = '', text) => { const n=document.createElement(tag); n.className=className; if(text!==undefined)n.textContent=text; return n; };
  const root=node('section','attachments'); root.setAttribute('aria-label','작업 첨부');
  const heading=node('header','attachment-heading'),title=node('h3','','첨부 원본'),count=node('span','attachment-count','0');
  const picker=node('input');picker.type='file';picker.id='attachment-file';
  const fileLabel=node('label','attachment-picker','파일 선택');fileLabel.htmlFor=picker.id;fileLabel.append(picker);
  heading.append(title,count,fileLabel);root.append(heading);
  const usage=node('div','attachment-usage'),list=node('div','attachment-list'),form=node('div','attachment-form');
  const selected=node('p','attachment-selected','선택한 원본을 이 작업에 보관합니다.'),record=node('select'),recordLabel=node('label','','연결할 기록');
  record.setAttribute('aria-label','첨부를 연결할 기록');recordLabel.append(record);
  const save=node('button','button','원본 보관'),status=node('p','attachment-status');status.setAttribute('role','status');save.disabled=true;
  form.append(selected,recordLabel,save);form.hidden=true;
  const more=node('button','button more','첨부 더 보기');more.hidden=true;
  root.append(usage,list,more,form,status,node('p','attachment-note','원래 파일은 변경하지 않습니다. 파일당 4 MiB · 프로젝트당 원본 64 MiB · 자동 삭제 없음'));
  let project=null,run=null,key='',generation=0,recordsKey='',page={items:[],next_offset:null},loading=false,saving=false,refreshPending=false;
  let recordNames=new Map();

  function draw() {
    count.textContent=String(page.total ?? page.items.length);list.replaceChildren();usage.replaceChildren();
    if(page.usage){
      const u=page.usage,amount=node('div','attachment-amount');amount.append(node('strong','',formatAttachmentBytes(u.original_bytes)),node('span','','프로젝트 첨부 · 같은 원본은 한 번만 계산'));
      const meter=node('meter');meter.min=0;meter.max=u.limits.project_bytes;meter.value=u.original_bytes;meter.setAttribute('aria-label','프로젝트 첨부 사용량');
      const disk=node('details','attachment-disk'),summary=node('summary','',`전체 DB ${formatAttachmentBytes(u.database_total_bytes)}`);
      disk.append(summary,node('p','',`모든 프로젝트의 기록·첨부·임시 쓰기 공간을 합친 파일 크기입니다. 첨부는 이동 가능한 텍스트 인코딩으로 보관해 원본보다 공간이 더 필요합니다. 이 프로젝트 첨부 데이터 ${formatAttachmentBytes(u.encoded_bytes)}.`));
      usage.append(amount,meter,disk);
    }
    if(!page.items.length)list.append(node('p','attachment-empty','함께 볼 파일이 있다면 원본을 보관해 두세요.'));
    for(const item of page.items){
      const row=node('article','attachment-item'),label=node('div','attachment-label');
      label.append(node('strong','',item.name),node('small','',`${formatAttachmentBytes(item.bytes)} · ${item.record_id?(recordNames.get(item.record_id)||`기록 ${item.record_id.slice(0,8)}`):'작업에 연결'}`));
      const view=node('button','button quiet','원본 보기'),download=node('button','button quiet','받기');
      view.addEventListener('click',()=>{void original(item,false).catch(showFailure);});download.addEventListener('click',()=>{void original(item,true).catch(showFailure);});
      row.append(node('span','attachment-file-mark','↳'),label,view,download);list.append(row);
    }
    more.hidden=page.next_offset===null;
  }
  function showFailure(error){status.textContent=error.message||'저장 여부를 확인하지 못했습니다. 같은 파일로 다시 시도해 주세요.';status.classList.add('failed');}
  async function load(append=false) {
    if(!key)return;if(loading){refreshPending=true;return;}const ticket=generation,p=project,r=run;loading=true;
    try{
      const data=await request(`/api/attachments?${new URLSearchParams({project:p,run:r,offset:String(append?page.next_offset:0)})}`);
      if(ticket!==generation)return;
      const previous=append?page.items:[];page={...data,items:[...new Map([...previous,...data.items].map(x=>[x.id,x])).values()]};draw();
    }catch(error){if(ticket===generation)showFailure(error);}finally{if(ticket===generation){loading=false;if(refreshPending){refreshPending=false;void load();}}}
  }
  picker.addEventListener('change',()=>{
    const file=picker.files?.[0];form.hidden=!file;save.disabled=!file;saving=false;status.textContent='';status.classList.remove('failed');
    selected.textContent=file?`${file.name} · ${formatAttachmentBytes(file.size)}`:'';
    if(file&&file.size>4*1024*1024){save.disabled=true;showFailure(new Error('파일당 4 MiB까지 보관할 수 있습니다. 더 작은 파일을 선택해 주세요.'));}
  });
  save.addEventListener('click',async()=>{
    const file=picker.files?.[0];if(!file||saving)return;
    const ticket=generation,p=project,r=run,recordId=record.value;saving=true;save.disabled=true;picker.disabled=true;record.disabled=true;status.classList.remove('failed');status.textContent='원본을 보관하고 있습니다…';
    try{
      if(file.size>4*1024*1024)throw new Error('파일당 4 MiB까지 보관할 수 있습니다.');
      const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));
      const data=await request('/api/attachments',{method:'POST',body:JSON.stringify({project_id:p,run_id:r,...(recordId?{record_id:recordId}:{}),name:file.name,data_base64:btoa(binary)})});
      if(ticket!==generation)return;
      status.textContent=data.duplicate?'이미 보관한 같은 파일입니다. 중복 저장하지 않았습니다.':'원본을 보관했습니다. 파일 내용이 검증됐다는 뜻은 아닙니다.';
      picker.value='';form.hidden=true;await load();
    }catch(error){if(ticket===generation)showFailure(error);}
    finally{if(ticket===generation){saving=false;picker.disabled=false;record.disabled=false;save.disabled=!picker.files?.length;}}
  });
  more.addEventListener('click',()=>{void load(true);});
  async function original(item,download) {
    const url=`/api/attachments/${item.id}/original?${new URLSearchParams({project:item.project_id,run:item.run_id})}`;
    const response=await fetch(url,{headers:headers(),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(response.status===401)onUnauthorized();
    if(!response.ok){const e=await response.json();throw new Error(e.error||'원본을 읽지 못했습니다.');}
    const bytes=new Uint8Array(await response.arrayBuffer());
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(bytes.length!==item.bytes||hash!==item.sha256)throw new Error('보관된 원본과 크기·내용이 일치하지 않습니다. 내려받지 않았습니다.');
    const kind=attachmentPreviewKind(bytes,item.name),blob=new Blob([bytes],{type:kind||'application/octet-stream'}),objectUrl=URL.createObjectURL(blob);
    if(download){const a=node('a');a.href=objectUrl;a.download=item.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);return;}
    const dialog=node('dialog','attachment-preview'),header=node('header'),close=node('button','button','닫기'),body=node('div','attachment-preview-body');
    dialog.setAttribute('aria-label',`${item.name} 원본`);header.append(node('h2','',item.name),close);
    close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{URL.revokeObjectURL(objectUrl);dialog.remove();},{once:true});
    if(kind?.startsWith('image/')){const img=node('img');img.src=objectUrl;img.alt=item.name;body.append(img);}
    else if(kind==='text/plain'){body.append(node('pre','',new TextDecoder().decode(bytes.subarray(0,128*1024))));if(bytes.length>128*1024)body.append(node('p','','앞부분 128 KiB를 보여줍니다. 전체 원본은 받기 버튼을 사용하세요.'));}
    else body.append(node('p','','이 형식·크기는 화면 미리보기를 지원하지 않습니다. 이미지는 2048 × 2048 이하의 정적 PNG·JPEG만 표시합니다. 원본을 받아 확인해 주세요.'));
    const a=node('a','button','원본 받기');a.href=objectUrl;a.download=item.name;
    dialog.append(header,node('p','attachment-note',`${formatAttachmentBytes(item.bytes)} · 보관 당시 바이트와 일치 · 내용은 미검증`),body,a);document.body.append(dialog);dialog.showModal();
  }
  return {
    refresh(p,r){if(key===`${p}:${r}`&&!saving)void load();},
    panel(p,r,records){
      if(key!==`${p}:${r}`){project=p;run=r;key=`${p}:${r}`;generation++;loading=false;saving=false;refreshPending=false;page={items:[],next_offset:null};recordsKey='';recordNames=new Map();picker.value='';picker.disabled=false;record.disabled=false;form.hidden=true;save.disabled=true;status.textContent='';draw();void load();}
      const next=JSON.stringify(records.map(x=>[x.id,x.report?.title]));if(next!==recordsKey){recordsKey=next;const selectedId=record.value,chosen=[...record.options].find(x=>x.value===selectedId);record.replaceChildren();const all=node('option','','작업 전체');all.value='';record.append(all);
        for(const entry of records){const label=entry.report?.title||`${entry.kind} · ${entry.topic}`;recordNames.set(entry.id,label);const option=node('option','',label);option.value=entry.id;record.append(option);}
        if(selectedId&&chosen&&!records.some(x=>x.id===selectedId)){const retained=node('option','',chosen.textContent);retained.value=selectedId;record.append(retained);}
        record.value=[...record.options].some(x=>x.value===selectedId)?selectedId:'';draw();}
      return root;
    }
  };
}
