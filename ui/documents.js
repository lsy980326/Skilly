import { createDocumentBatch } from './document-batch.js';

export function createDocumentImport({ document, request, onSaved }) {
  const node = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const dialog = node('dialog', 'document-import'); dialog.setAttribute('aria-labelledby', 'document-import-title');
  const header = node('header', 'import-heading'), title = node('h2', '', '문서 가져오기'); title.id = 'document-import-title';
  const close = node('button', 'button quiet', '닫기');
  header.append(node('div', 'eyebrow', 'DOCUMENTS → MEMORY'), close, title, node('p', '', '여러 원문을 한 번에 확인하고, 파일별로 보관합니다. 원본은 그대로 둡니다.'));
  const steps = node('ol', 'import-steps');
  const stepNodes = ['파일 선택', '원문 미리보기', '소급 기록 저장'].map(text => { const n = node('li', '', text); steps.append(n); return n; });
  const grid = node('div', 'import-grid'), controls = node('div', 'import-controls'), destinationLabel = node('p', 'import-destination');
  const field = (caption, input) => { const label = node('label', 'import-field'); label.append(node('span', '', caption), input); return label; };
  const target = node('select'); target.setAttribute('aria-label', '저장할 작업 공간');
  const newScope = node('div', 'import-new-scope'); newScope.hidden = true;
  const repository = node('input'); repository.type = 'text'; repository.maxLength = 100; repository.placeholder = '예: main'; repository.setAttribute('aria-label', '새 작업 공간 저장소');
  const environment = node('input'); environment.type = 'text'; environment.maxLength = 100; environment.placeholder = '예: development'; environment.setAttribute('aria-label', '새 작업 공간 환경');
  newScope.append(field('저장소 이름', repository), field('환경 이름', environment), node('small', '', '서비스 공통으로 저장하며 폴더 연결과 기존 설정은 변경하지 않습니다.'));
  const file = node('input'); file.type = 'file'; file.multiple = true; file.accept = '.md,.markdown,text/markdown'; file.setAttribute('aria-label', 'Markdown 파일 선택');
  const path = node('input'); path.type = 'text'; path.maxLength = 300; path.setAttribute('aria-label', '문서 이름');
  const previewButton = node('button', 'button', '원문 미리보기');
  controls.append(destinationLabel, field('저장할 작업 공간', target), newScope, field('Markdown 파일 · 최대 20개 / 파일당 48 KiB', file), field('선택한 문서 이름', path),
    node('small', '', '실제 폴더 경로는 전달되지 않습니다. 같은 이름·내용·저장 위치만 중복으로 판단합니다.'), previewButton,
    node('p', 'import-caution', '소급 · 미검증으로 저장합니다. 과거 문서의 주장을 현재 기능 상태나 검사 성공으로 처리하지 않습니다.'),
    node('small', '', '저장 후 위치와 선택 목록은 고정됩니다. 이 창을 닫거나 새로고침하면 미저장 목록은 사라집니다. 자동 저장·복구 큐는 없습니다.'));
  const pane = node('section', 'import-preview'), list = node('ul', 'import-files'); list.setAttribute('aria-label', '파일별 가져오기 상태');
  const meta = node('p', 'import-preview-meta'), original = node('pre', 'import-original'); original.setAttribute('aria-label', '선택한 문서 원문'); original.tabIndex = 0;
  const itemView = node('button', 'button quiet', '이 문서 기록 보기'); itemView.hidden = true;
  pane.append(node('h3', '', '파일별 진행 상황'), list, node('h3', '', '선택한 원문'), meta, original, itemView); grid.append(controls, pane);
  const footer = node('footer', 'import-footer'), status = node('p', 'import-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const save = node('button', 'button primary', '소급 기록으로 가져오기'), retry = node('button', 'button', '저장 실패만 재시도'); retry.hidden = true;
  footer.append(status, retry, save); dialog.append(header, steps, grid, footer); document.body.append(dialog);
  let project, targets = [], active = 0, loading = false, notice = '';
  const labels = { reading: '읽는 중', read_error: '파일 읽기 실패', unreviewed: '미리보기 대기', previewing: '확인 중', ready: '저장 준비', duplicate: '이미 보관됨', selection_duplicate: '선택 중복', preview_error: '미리보기 실패', saving: '저장 중', saved: '저장 완료', save_error: '저장 확인 불가' };
  const batch = createDocumentBatch({ request, changed: render });
  function render() {
    const items = batch.items, busy = loading || batch.running, locked = batch.locked;
    target.disabled = repository.disabled = environment.disabled = file.disabled = busy || locked;
    close.disabled = busy; path.disabled = busy || locked || !items[active];
    previewButton.disabled = busy || items.some(i => i.state === 'reading') || !items.some(i => i.text !== null && !['saved', 'save_error'].includes(i.state)) || (!targets.length && target.value !== 'new');
    save.disabled = busy || !items.some(i => i.state === 'ready');
    retry.hidden = !items.some(i => i.state === 'save_error'); retry.disabled = busy;
    list.replaceChildren();
    items.forEach((item, index) => {
      const row = node('li', 'import-file'); row.dataset.state = item.state;
      const button = node('button', 'import-file-pick', item.path); button.setAttribute('aria-pressed', String(active === index));
      button.addEventListener('click', () => { active = index; render(); });
      row.append(button, node('span', 'import-file-state', labels[item.state]));
      if (item.message) row.append(node('small', '', item.message)); list.append(row);
    });
    const selected = items[active];
    path.value = selected?.path ?? ''; original.textContent = selected?.text ?? '아직 선택한 원문이 없습니다.';
    meta.textContent = selected?.preview ? `${selected.path} · ${selected.preview.source.bytes}B · ${selected.preview.parts}개 조각 · SHA-256 ${selected.preview.source.sha256}` : selected ? selected.path : '파일을 선택하고 원문을 확인해 주세요.';
    itemView.hidden = !selected?.result?.run_id; itemView.disabled = busy;
    const count = state => items.filter(i => i.state === state).length;
    status.textContent = notice || (items.length ? `총 ${items.length}개 · 저장 ${count('saved')} · 보관 중복 ${count('duplicate')} · 선택 중복 ${count('selection_duplicate')} · 저장 준비 ${count('ready')} · 확인 필요 ${count('read_error') + count('preview_error') + count('save_error')}` : '파일을 선택해 주세요. 선택·미리보기만으로 DB에 저장하지 않습니다.');
    const stage = items.some(i => ['saving', 'saved', 'save_error'].includes(i.state)) ? 2 : items.some(i => ['ready', 'duplicate', 'selection_duplicate'].includes(i.state)) ? 1 : 0;
    const finished = items.length && items.every(i => ['saved', 'duplicate', 'selection_duplicate'].includes(i.state));
    stepNodes.forEach((n, i) => { n.className = finished || i < stage ? 'done' : i === stage ? 'current' : ''; n.setAttribute('aria-current', !finished && i === stage ? 'step' : 'false'); });
  }
  function destination() {
    if (target.value === 'new') {
      if (!repository.value.trim() || !environment.value.trim()) throw new Error('새 작업 공간의 저장소와 환경 이름을 입력해 주세요.');
      return { project_id: project.id, target_scope: { repository: repository.value.trim(), environment: environment.value.trim() }, component_key: '' };
    }
    const t = targets[Number(target.value)]; if (!t) throw new Error('저장할 작업 공간을 선택해 주세요.');
    return { project_id: project.id, target_run_id: t.id, component_key: t.component_key };
  }
  async function action(work) { notice = ''; try { await work(); } catch (error) { notice = error.message || '연결을 확인해 주세요.'; } finally { render(); } }
  file.addEventListener('change', () => action(async () => { active = 0; await batch.select(Array.from(file.files ?? [])); }));
  path.addEventListener('input', () => { notice = ''; batch.rename(active, path.value); });
  for (const input of [repository, environment]) input.addEventListener('input', () => { notice = ''; batch.invalidate(); });
  target.addEventListener('change', () => { newScope.hidden = target.value !== 'new'; notice = ''; batch.invalidate(); });
  previewButton.addEventListener('click', () => action(() => batch.preview(destination())));
  save.addEventListener('click', () => action(() => batch.save())); retry.addEventListener('click', () => action(() => batch.save(true)));
  close.addEventListener('click', () => dialog.close()); dialog.addEventListener('cancel', event => { if (loading || batch.running) event.preventDefault(); });
  itemView.addEventListener('click', () => { const item = batch.items[active]; if (!loading && !batch.running && item?.result?.run_id) { dialog.close(); void onSaved(project.id, item.result.run_id); } });
  return { async open(selected) {
    if (!selected?.id || loading || batch.running) return;
    project = selected; active = 0; notice = ''; targets = []; repository.value = ''; environment.value = ''; file.value = ''; target.replaceChildren(); newScope.hidden = true; batch.reset();
    destinationLabel.textContent = `저장할 서비스 · ${project.name}`; dialog.showModal(); loading = true; render();
    await action(async () => {
      const data = await request(`/api/documents/targets?project=${project.id}`); targets = data.items;
      targets.forEach((t, i) => { const option = node('option', '', `${t.component_name} · ${t.repository} / ${t.environment}`); option.value = String(i); target.append(option); });
      if (!data.unavailable) { const option = node('option', '', '새 작업 공간 · 서비스 공통'); option.value = 'new'; target.append(option); }
      target.value = targets.length ? String(Math.max(0, targets.findIndex(t => !t.component_key))) : data.unavailable ? '' : 'new'; newScope.hidden = target.value !== 'new';
      notice = data.unavailable || (!targets.length ? '첫 문서를 저장할 작업 공간의 저장소와 환경 이름을 입력해 주세요.' : '');
      if (data.truncated) notice += ' 저장 위치는 앞의 100개만 표시합니다.';
    }); loading = false; render();
  } };
}
