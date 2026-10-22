// A bounded, in-memory selection. Only explicit save calls write; retries reuse exact snapshots.
export function createDocumentBatch({ request, changed = () => {} }) {
  let items = [], generation = 0, running = false, locked = false;
  const notify = () => changed();
  const errorText = error => error?.message || '연결을 확인한 뒤 다시 시도해 주세요.';
  function invalidate() {
    if (locked) return;
    for (const item of items) { item.preview = null; item.reviewed = null; item.result = null; if (item.text !== null) { item.state = 'unreviewed'; item.message = ''; } }
    notify();
  }
  async function perform(work) {
    if (running) return; running = true; notify();
    try { await work(); } finally { running = false; notify(); }
  }
  return {
    get items() { return items; }, get running() { return running; }, get locked() { return locked; },
    reset() { generation++; items = []; locked = false; notify(); },
    invalidate,
    rename(index, path) { if (running || locked) return; const item = items[index]; if (item) { item.path = path; invalidate(); } },
    async select(files) {
      if (running || locked) return;
      if (files.length > 20) throw new Error('한 번에 최대 20개까지 선택해 주세요. 선택 목록을 바꾸지 않았습니다.');
      const version = ++generation;
      items = files.map(file => ({ file, path: file.name, text: null, state: 'reading', message: '', reviewed: null, result: null })); notify();
      for (const item of items) {
        try {
          if (item.file.size > 49152) throw new Error('48 KiB 이하의 문서를 선택해 주세요.');
          const bytes = await item.file.arrayBuffer();
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          if (version !== generation) return;
          item.text = text; item.state = 'unreviewed';
        } catch (error) { if (version !== generation) return; item.state = 'read_error'; item.message = item.file.size > 49152 ? errorText(error) : 'UTF-8 문서를 읽지 못했습니다. 파일을 확인하고 다시 선택해 주세요.'; }
        notify();
      }
    },
    async preview(destination) {
      return perform(async () => {
        const seen = new Map();
        for (const item of items) {
          if (item.text === null || ['saved', 'save_error'].includes(item.state)) continue;
          item.preview = null; item.reviewed = null; item.result = null; item.state = 'previewing'; item.message = ''; notify();
          const input = { ...destination, path: item.path, text: item.text };
          try {
            const preview = await request('/api/documents/preview', { method: 'POST', body: JSON.stringify(input) });
            const identity = JSON.stringify([item.path, preview.source.sha256]);
            item.preview = preview;
            if (preview.existing?.state === 'stored') {
              item.state = 'duplicate'; item.result = preview.existing; item.message = '같은 저장 위치·문서 이름·원문이 이미 보관돼 있습니다.';
            } else if (seen.has(identity)) {
              item.state = 'selection_duplicate'; item.message = '선택 목록의 같은 문서와 중복됩니다. 한 번만 저장합니다.';
            } else {
              item.state = 'ready'; item.reviewed = { input, token: preview.preview_token };
              item.message = preview.existing?.state === 'completion_pending' ? '원문은 보관됐지만 가져오기 마감이 남았습니다. 같은 요청으로 마무리합니다.' : '';
              seen.set(identity, item);
            }
          } catch (error) { item.state = 'preview_error'; item.message = errorText(error); }
          notify();
        }
      });
    },
    async save(failedOnly = false) {
      const selected = items.filter(item => item.reviewed && (failedOnly ? item.state === 'save_error' : item.state === 'ready' || item.state === 'save_error'));
      if (!selected.length) return;
      locked = true;
      return perform(async () => {
        for (const item of selected) {
          item.state = 'saving'; item.message = ''; notify();
          try {
            item.result = await request('/api/documents/import', { method: 'POST', body: JSON.stringify({ ...item.reviewed.input, preview_token: item.reviewed.token }) });
            item.state = 'saved';
          } catch (error) { item.state = 'save_error'; item.message = '저장 확인 불가 · 일부 저장됐을 수 있습니다. 같은 요청으로 재시도하세요. ' + errorText(error); }
          notify();
        }
      });
    },
  };
}
