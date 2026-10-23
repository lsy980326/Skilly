import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimpleDashboard } from '../ui/simple-dashboard.js';
class Node {
  children = []; attrs = {}; listeners = {}; style = {};
  constructor(tag, className = '', text = '') { this.tag = tag; this.className = className; this.text = text; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  replaceChild(fresh, old) { this.children[this.children.indexOf(old)] = fresh; }
  insertBefore(node, next) { this.children = this.children.filter(x => x !== node); const index = next ? this.children.indexOf(next) : this.children.length; this.children.splice(index, 0, node); }
  removeChild(node) { this.children = this.children.filter(x => x !== node); }
  matches(selector) { return selector===':focus-within' && this.focusedWithin===true; }
  focus() { this.focused=true; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(x => x.textContent).join(''); }
  find(cls) { return this.children.flatMap(x => [...(x.className.split(' ').includes(cls) ? [x] : []), ...x.find(cls)]); }
}
const element = (...args) => new Node(...args);
const projects = [
  { id: 'old', key: 'api', name: 'API', total: 2, unfinished: 1, interrupted: 1, last_activity: '2026-01-01' },
  { id: 'new', key: 'web', name: 'Web', total: 4, unfinished: 2, interrupted: 0, last_activity: '2026-02-01' },
];
const task = (id, date) => ({ id, title: id, updated_at: date, actor: 'Codex', components: [{ name: 'Web' }], features: [{ name: '로그인' }], latest_report: { summary: '<script>원문</script>' } });
function fixture() {
  const root = element('div'); let failed = false, calls = 0, peak = 0, concurrent = 0;
  let items = [task('older', '2026-01-01'), task('newer', '2026-02-01')], completed = [];
  const opened = [];
  const dashboard = createSimpleDashboard({ root, element, svgElement: (tag, attrs, text) => { const node = element(tag, attrs.class || "", text); for(const [k,v] of Object.entries(attrs)) node.setAttribute(k,v); return node; }, relativeTime: v => element('time', '', v), onOpen: (...args) => opened.push(args), onAcknowledged: () => dashboard.refresh(projects, false),
    request: async (path, options) => {
      calls++; concurrent++; peak = Math.max(peak, concurrent);
      await new Promise(setImmediate); concurrent--;
      if (failed) throw Error('offline');
      if (path === '/api/runs/acknowledge') { const id=JSON.parse(options.body).run_id; completed=completed.filter(x=>x.id!==id); return {status:'persisted'}; }
      return { filtered_total: completed.length, observed_at: calls, items: path.includes('state=active') ? items : completed, next_offset: null };
    } });
  return { root, dashboard, opened, setItems(value) { items=value; }, fail() { failed = true; }, reconnect() { failed = false; }, note() { items = items.map(x => ({...x, latest_report:{summary:'갱신된 요약'}})); }, complete(id) { const done = items.find(x => x.id === id); items = items.filter(x => x.id !== id); completed = [done, ...completed]; }, expire() { completed=[]; }, clear() { items = []; }, calls: () => calls, peak: () => peak };
}
test('projects and tasks use recent activity, independent state queries, and bounded concurrency', async () => {
  const f = fixture(); await f.dashboard.refresh(projects, false);
  assert.equal(f.calls(), 4); assert.equal(f.peak(), 2);
  assert.equal(f.root.find('factory')[0].children[0].textContent, 'Web진행중 2 · 최근 완료 0');
  assert.match(f.root.find('assembly-heading')[0].textContent, /newer/);
  assert.equal(f.root.find('is-assembling').length, 4);
  assert.equal(f.root.find('factory-inspector')[0].hidden, true);
  f.root.find('factory-task')[0].listeners.click();
  assert.match(f.root.find('factory-inspector')[0].textContent, /Web.*로그인/);
  assert.match(f.root.find('factory-inspector')[0].textContent, /<script>원문<\/script>/);
  assert.deepEqual(f.opened, [], 'part click stays in simple view');
  f.root.find('factory-open-detail')[0].listeners.click(); assert.deepEqual(f.opened, [['new', 'newer']]);
  const original = f.root.children[0]; await f.dashboard.refresh(projects, false);
  assert.equal(f.root.children[0], original, 'unchanged records preserve DOM and focus');
});
test('failed refresh preserves prior records, marks unknown, stops motion; empty state is distinct', async () => {
  const f = fixture(); await f.dashboard.refresh(projects, false); f.fail(); await f.dashboard.refresh(projects, true);
  assert.match(f.root.textContent, /연결을 확인하지 못했어요/); assert.match(f.root.textContent, /newer/); assert.match(f.root.textContent, /프로젝트 더 보기/);
  assert.equal(f.root.find('is-assembling').length, 0);
  const empty = fixture(); empty.clear(); await empty.dashboard.refresh(projects, false);
  assert.match(empty.root.textContent, /다음 작업을 기다리는 중/); assert.equal(empty.root.find('is-assembling').length, 0);
});
test('leaving while fetching prevents late writes to hidden dashboard', async () => {
  const f = fixture(); const loading = f.dashboard.refresh(projects, false); f.dashboard.cancel(); await loading;
  assert.equal(f.root.children.length, 0);
});

test('only an observed saved active-to-completed change delivers once; old completions do not', async () => {
  const f = fixture(); f.complete('older'); await f.dashboard.refresh(projects, false);
  assert.equal(f.root.find('delivery').length, 0, 'initial completion is stored statically');
  f.complete('newer'); await f.dashboard.refresh(projects, false);
  assert.equal(f.root.find('delivery').length, 2, 'one transfer per project');
  assert.equal(f.root.find('is-assembling').length, 0);
  const scene = f.root.children[0]; await f.dashboard.refresh(projects, false);
  assert.equal(f.root.children[0], scene, 'same snapshot does not replay delivery');
});
test('a reconnect gap or leaving the view does not synthesize completion travel', async () => {
  const f = fixture(); await f.dashboard.refresh(projects, false); f.fail(); await f.dashboard.refresh(projects, false);
  f.complete('newer'); f.reconnect(); await f.dashboard.refresh(projects, false);
  assert.equal(f.root.find('delivery').length, 0);
  f.dashboard.cancel(); f.complete('older'); await f.dashboard.refresh(projects, false);
  assert.equal(f.root.find('delivery').length, 0);
});

test('a saved completion carries its assembled part and clears the station before the next arrival', async () => {
  const f=fixture(); await f.dashboard.refresh(projects,false);
  f.complete('newer'); await f.dashboard.refresh(projects,false);
  const delivery=f.root.find('delivery')[0];
  assert.equal(delivery.find('world-chip').length,1);
  const arrival=f.root.find('in-assembly')[0].find('cargo')[0];
  assert.equal(arrival.attrs.transform,'translate(-106.4 0)');
  assert.equal(arrival.children.find(n=>n.tag==='animateTransform').attrs.begin,'0s', 'independent task lines do not wait for another task');
});

test('summary changes preserve assembly SVG while updating human-readable cards', async () => {
  const f = fixture(); await f.dashboard.refresh(projects, false);
  const first = f.root.children[0], scene = first.children[2];
  f.root.find('factory-task')[0].listeners.click();
  f.note(); await f.dashboard.refresh(projects, false);
  assert.equal(f.root.children[0], first);
  assert.equal(f.root.children[0].children[2], scene);
  assert.match(f.root.textContent, /갱신된 요약/);
  const shifted = projects.map(p => p.id === 'old' ? {...p, last_activity:'2026-03-01'} : p);
  await f.dashboard.refresh(shifted, false);
  assert.equal(f.root.children[1], first); assert.equal(first.children[2], scene);
});

test('acknowledge is an explicit action; opening detail does not mark read, and failure keeps the card', async () => {
 const f=fixture();f.complete('older');await f.dashboard.refresh(projects,false);
 const card=f.root.find('factory-completion')[0]; card.listeners.click();
 assert.ok(f.root.textContent.includes('older'));
 f.fail(); await f.root.find('acknowledge-task')[0].listeners.click();
 assert.ok(f.root.textContent.includes('offline')); assert.equal(f.root.find('acknowledge-task')[0].disabled,false);
 f.reconnect(); await f.root.find('acknowledge-task')[0].listeners.click();
 assert.equal(f.root.find('factory-completion').length,0);
});

test('another completion never restarts a surviving line or replaces the store trigger', async()=>{
 const f=fixture();await f.dashboard.refresh(projects,false);
 const survivor=f.root.find('assembly-line')[0],svg=survivor.find('workshop-scene')[0];
 const store=f.root.find('store-list')[0];store.open=true;const trigger=store.children[0];
 f.complete('older');await f.dashboard.refresh(projects,false);
 assert.equal(f.root.find('assembly-line')[0],survivor);assert.equal(survivor.find('workshop-scene')[0],svg);
 assert.equal(f.root.find('store-list')[0],store);assert.equal(store.children[0],trigger);assert.equal(store.open,true);
 f.root.find('factory-completion')[0].listeners.click();await f.root.find('acknowledge-task')[0].listeners.click();
 assert.equal(f.root.find('assembly-line')[0],survivor);assert.equal(f.root.find('store-list')[0],store);
});

test('summary refresh retains inspector action nodes and each task has its own bounded line',async()=>{
 const f=fixture();f.setItems(Array.from({length:8},(_,i)=>task('task-'+i,'2026-02-'+String(i+1).padStart(2,'0'))));
 await f.dashboard.refresh(projects,false);assert.equal(f.root.children[0].find('assembly-line').length,6);
 assert.match(f.root.textContent,/나머지 진행중 작업 보기/);
 const panel=f.root.find('factory-inspector')[0];assert.equal(panel.hidden,true);
 f.root.find('factory-task')[0].listeners.click();const detail=f.root.find('factory-open-detail')[0];
 f.note();await f.dashboard.refresh(projects,false);assert.equal(f.root.find('factory-open-detail')[0],detail);
 assert.match(panel.textContent,/갱신된 요약/);detail.listeners.click();assert.deepEqual(f.opened,[['new','task-7']]);
 panel.find('factory-inspector-heading')[0].children[1].listeners.click();assert.equal(panel.hidden,true);
 f.root.find('factory-task')[0].listeners.click();assert.equal(panel.hidden,false,'same part reopens after summary refresh and close');
});


test('belt texture ends each cycle at the next roller without a visual jump', async () => {
 const f=fixture();await f.dashboard.refresh(projects,false);
 const rollers=f.root.find('world-rollers')[0];
 const animation=rollers.children.find(n=>n.tag==='animateTransform');
 const displacement=animation.attrs.to.split(' ').map(Number);
 const lines=rollers.find('world-roller');
 const endpoints=line=>line.attrs.points.split(' ').map(point=>point.split(',').map(Number));
 for(let i=0;i<lines.length-1;i++){
  const a=endpoints(lines[i]),b=endpoints(lines[i+1]);
  a.forEach((point,j)=>point.forEach((value,axis)=>assert.ok(Math.abs(value+displacement[axis]-b[j][axis])<.02)));
 }
 const belt=f.root.find('world-belt')[0].find('world-top')[0].attrs.points.split(' ').map(p=>Number(p.split(',')[0]));
 assert.ok(Math.min(...endpoints(lines[0]).map(p=>p[0]))+displacement[0]<=Math.min(...belt));
 assert.ok(Math.max(...endpoints(lines.at(-1)).map(p=>p[0]))>=Math.max(...belt));
});


test('active and delivered parts use block-sized bounds and completed slots open the same inspector without acknowledgement',async()=>{
 const f=fixture();await f.dashboard.refresh(projects,false);
 const part=f.root.find('workshop-part')[0];
 const values=Object.fromEntries(Object.entries(part.style).map(([k,v])=>[k,Number.parseFloat(v)]));
 assert.ok(values.width>10&&values.width<15);assert.ok(values.height>10&&values.height<17,'visible bounds follow cargo instead of the old 30% panel');
 f.complete('newer');await f.dashboard.refresh(projects,false);
 const delivered=f.root.find('completed-part')[0];assert.match(delivered.attrs['aria-label'],/newer 완료 내용 보기/);
 delivered.listeners.click();assert.match(f.root.find('factory-inspector')[0].textContent,/newer/);
 const slot=f.root.find('store-package').find(n=>n.tag==='button');assert.equal(slot.attrs['aria-label'],'newer 완료 내용 보기');
 slot.listeners.click();assert.match(f.root.find('factory-inspector')[0].textContent,/완료 · 아직 확인하지 않음/);
 assert.equal(f.root.find('factory-completion').length,2,'reading a completed part never acknowledges it');
 assert.match(f.root.find('factory')[0].children[0].textContent,/최근 완료 1/);
});


test('expiring a selected completion returns keyboard focus and announces the list change',async()=>{
 const f=fixture();f.complete('older');await f.dashboard.refresh(projects,false);
 f.root.find('store-package').find(n=>n.tag==='button').listeners.click();
 const panel=f.root.find('factory-inspector')[0];panel.focusedWithin=true;
 f.expire();await f.dashboard.refresh(projects,false);
 assert.equal(panel.hidden,true);
 assert.equal(f.root.find('store-list')[0].children[0].focused,true);
 assert.match(f.root.find('factory-selection-message')[0].textContent,/현재 목록에서 빠졌습니다/);
 assert.match(f.root.find('store-list')[0].textContent,/0개.*최근 1시간/);
});
