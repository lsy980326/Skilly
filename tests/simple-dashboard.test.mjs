import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimpleDashboard } from '../ui/simple-dashboard.js';
class Node {
  children = []; attrs = {}; listeners = {};
  constructor(tag, className = '', text = '') { this.tag = tag; this.className = className; this.text = text; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  replaceChild(fresh, old) { this.children[this.children.indexOf(old)] = fresh; }
  insertBefore(node, next) { this.children = this.children.filter(x => x !== node); const index = next ? this.children.indexOf(next) : this.children.length; this.children.splice(index, 0, node); }
  removeChild(node) { this.children = this.children.filter(x => x !== node); }
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
      return { observed_at: calls, items: path.includes('state=active') ? items : completed, next_offset: null };
    } });
  return { root, dashboard, opened, fail() { failed = true; }, reconnect() { failed = false; }, note() { items = items.map(x => ({...x, latest_report:{summary:'갱신된 요약'}})); }, complete(id) { const done = items.find(x => x.id === id); items = items.filter(x => x.id !== id); completed = [done, ...completed]; }, clear() { items = []; }, calls: () => calls, peak: () => peak };
}
test('projects and tasks use recent activity, independent state queries, and bounded concurrency', async () => {
  const f = fixture(); await f.dashboard.refresh(projects, false);
  assert.equal(f.calls(), 4); assert.equal(f.peak(), 2);
  assert.equal(f.root.find('factory')[0].find('eyebrow')[0].textContent, 'web');
  assert.match(f.root.find('factory-task')[0].textContent, /^newer/);
  assert.match(f.root.textContent, /Web.*로그인/);
  assert.match(f.root.textContent, /<script>원문<\/script>/);
  assert.equal(f.root.find('is-assembling').length, 2);
  f.root.find('factory-task')[0].listeners.click(); assert.deepEqual(f.opened, [['new', 'newer']]);
  const original = f.root.children[0]; await f.dashboard.refresh(projects, false);
  assert.equal(f.root.children[0], original, 'unchanged records preserve DOM and focus');
});
test('failed refresh preserves prior records, marks unknown, stops motion; empty state is distinct', async () => {
  const f = fixture(); await f.dashboard.refresh(projects, false); f.fail(); await f.dashboard.refresh(projects, true);
  assert.match(f.root.textContent, /갱신 실패/); assert.match(f.root.textContent, /newer/); assert.match(f.root.textContent, /프로젝트 더 보기/);
  assert.equal(f.root.find('is-assembling').length, 0);
  const empty = fixture(); empty.clear(); await empty.dashboard.refresh(projects, false);
  assert.match(empty.root.textContent, /저장된 진행중 작업 없음/); assert.equal(empty.root.find('is-assembling').length, 0);
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
  assert.equal(arrival.attrs.transform,'translate(-106.4 -11.4)');
  assert.equal(arrival.children.find(n=>n.tag==='animateTransform').attrs.begin,'1.2s');
});

test('summary changes preserve assembly SVG while updating human-readable cards', async () => {
  const f = fixture(); await f.dashboard.refresh(projects, false);
  const first = f.root.children[0], scene = first.children[2];
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
 const card=f.root.find('factory-completion')[0]; card.find('factory-task')[0].listeners.click();
 assert.ok(f.root.textContent.includes('older'));
 f.fail(); await card.find('acknowledge-task')[0].listeners.click();
 assert.ok(f.root.textContent.includes('offline')); assert.equal(card.find('acknowledge-task')[0].disabled,false);
 f.reconnect(); await card.find('acknowledge-task')[0].listeners.click();
 assert.equal(f.root.find('factory-completion').length,0);
});
