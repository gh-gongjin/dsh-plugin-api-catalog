/* tmp/ac-live-check.mjs —— S6 真机复核：只 GET，把挂在 ~/.dsh/profiles/desktop 上那一份读回来。
   跑法：node tmp/ac-live-check.mjs [端口]（默认 19387，需要 dsh desktop 正在跑、插件已 link: 挂载、至少同步过一轮）。
   铁律：全程 GET。POST 那四发（sync / prefs / notes / notes-delete）一个字都不碰 —— 真机写坏了 KV 没有历史版本可回滚。
   SSE 那一发带 AbortController：接上读第一帧就撤，不留在宿主的连接表里。
   产物就是 stdout 读数，落 docs/design-spec.md §9.1e。 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = `http://127.0.0.1:${process.argv[2] || '19387'}`;
const PREFIX = '/api-catalog';
const STORE_DIR = join(homedir(), '.dsh', 'storages', 'api_catalog');

const fails = [];
const notes = [];
const log = (k, v) => notes.push(`${k.padEnd(22)} ${v}`);
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { fails.push(`${name}\n     ${e.message}`); console.log(`FAIL ${name}\n     ${e.message}`); }
};
const get = async (sub, expectStatus = 200) => {
  const r = await fetch(`${BASE}${PREFIX}${sub}`, { signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 原样带出 */ }
  assert.equal(r.status, expectStatus, `${sub} 返回 ${r.status}${json ? ' ' + JSON.stringify(json).slice(0, 200) : ' 原文:' + text.slice(0, 200)}`);
  return { res: r, json, text };
};
/* 真机信封：宿主把插件的 {ok,data} 再包一层还是原样吐出来，这里不假设 —— 两头都断言前先看清形状。 */
const dataOf = (json) => {
  assert.equal(typeof json, 'object', `载荷不是 JSON：${JSON.stringify(json).slice(0, 160)}`);
  assert.equal(json.ok, true, `ok 不是 true：${JSON.stringify(json).slice(0, 220)}`);
  assert.notEqual(json.data, undefined, `没有 data 段：${JSON.stringify(json).slice(0, 220)}`);
  return json.data;
};

/* ---------- 1. 盘上那一份（宿主落盘形状，离线永远看不到） ---------- */
console.log('\n=== [1] ~/.dsh/storages/api_catalog 落盘形状 ===');
assert.ok(existsSync(STORE_DIR), `目录不存在：${STORE_DIR}（插件没挂载或没同步过）`);
const tables = readdirSync(STORE_DIR).filter((n) => n !== '.DS_Store');
log('表目录', tables.join(' '));
for (const t of tables) {
  const files = readdirSync(join(STORE_DIR, t)).filter((f) => f.endsWith('.json'));
  log(`  ${t}`, `${files.length} 个文件（每键一文件）`);
}
const envelope = JSON.parse(readFileSync(join(STORE_DIR, 'meta', 'snap.json'), 'utf8'));
log('meta/snap.json 信封', Object.keys(envelope).join(','));
assert.deepEqual(Object.keys(envelope).sort(), ['record', 'version'], '宿主落盘信封不是 {version,record}，读数口径要重写');
const meta = envelope.record;
const entryFiles = readdirSync(join(STORE_DIR, 'entries'));
log('entries 行数', `${entryFiles.length}（离线 51 行 → 真机 ${entryFiles.length} 行）`);
const rows = entryFiles.map((f) => JSON.parse(readFileSync(join(STORE_DIR, 'entries', f), 'utf8')).record);
log('items 合计', rows.reduce((s, r) => s + r.items.length, 0));
assert.equal(rows.reduce((s, r) => s + r.items.length, 0), meta.total, 'entries 里的条数与 meta.total 不一致（一份真相破了）');
const maxRow = rows.slice().sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
log('最大单值(压缩)', `${JSON.stringify(maxRow).length}B @${maxRow.category} ${maxRow.items.length} 条`);
log('最大单值(盘上)', `${statSync(join(STORE_DIR, 'entries', entryFiles[rows.indexOf(maxRow)])).size}B（宿主 pretty-print 带缩进）`);

/* ---------- 2. GET 路由逐发 ---------- */
console.log('\n=== [2] GET 路由（八发里除 stream 全打，stream 单独带 abort） ===');
let snapshot;
await check('GET /api/snapshot 整份读数', async () => {
  const { res, json } = await get('/api/snapshot');
  log('snapshot 状态码/CT', `${res.status} ${res.headers.get('content-type')}`);
  snapshot = dataOf(json);
  log('snapshot 键', Object.keys(snapshot).sort().join(','));
  assert.equal(snapshot.meta.sha, meta.sha, '路由读到的 sha 与盘上 meta.sha 不是同一份');
  assert.equal(snapshot.index.total, 2019, `真机条目数 ${snapshot.index.total}（离线钉的是 2019）`);
  assert.equal(snapshot.index.total, meta.total, 'index.total 与 meta.total 不是同一份（一份真相破了）');
  log('index', JSON.stringify(snapshot.index));
  log('facets/presets', JSON.stringify(snapshot.facets).slice(0, 200) + ' | ' + JSON.stringify(snapshot.presets).slice(0, 160));
  const onDiskNotes = existsSync(join(STORE_DIR, 'notes'))
    ? readdirSync(join(STORE_DIR, 'notes')).filter((f) => f.endsWith('.json')).length : 0;
  assert.equal(snapshot.notes.total, onDiskNotes, `snapshot.notes.total=${snapshot.notes.total} 与盘上 notes 文件数 ${onDiskNotes} 不一致`);
  log('notes 汇总', `${JSON.stringify(snapshot.notes)}（盘上 ${onDiskNotes} 个文件）`);
  log('capabilities', JSON.stringify(snapshot.capabilities));
  // capabilityRows 2026-10-06 起不在快照里了（那张「解析台账」卡撤了，见 §9.1n）；
  // 探针改读 capabilities 这三个布尔，别再对着一份已经不推的数组 slice 一个 undefined。
  log('排障十格（只在接口里）', ['lastStatus', 'sha', 'sourceId', 'total', 'parseRatio', 'endAnchor', 'lastCheckedAt', 'lastError', 'backoff', 'keyRule']
    .map((k) => `${k}=${snapshot.meta?.[k] ?? '—'}`).join(' · '));
  log('lastSync', JSON.stringify(snapshot.lastSync));
  log('prefs(snapshot)', JSON.stringify(snapshot.prefs));
});
await check('GET /api/search 真查得到东西', async () => {
  const { json } = await get('/api/search?q=github&limit=7');
  const d = dataOf(json);
  log('search 键', Object.keys(d).sort().join(','));
  assert.ok(d.rows.length > 0 && d.rows.length <= 7, `limit=7 却给了 ${d.rows.length} 条`);
  assert.ok(d.rows.every((r) => /github/i.test(`${r.name}${r.desc ?? ''}`)), '结果里有完全不沾 github 的条目');
  const one = d.rows[0];
  log('search 行字段', Object.keys(one).sort().join(','));
  assert.ok(one.slug && one.name && one.category, '行里少了 slug/name/category 之一');
});
await check('GET /api/search limit 越界照样夹住', async () => {
  const { json } = await get('/api/search?q=a&limit=99999');
  assert.ok(dataOf(json).rows.length <= 200, 'limit 上限在真机上没夹住');
  const browse = dataOf((await get('/api/search')).json);
  log('浏览态（不带 q）', `rows=${browse.rows.length} total=${browse.total} truncated=${browse.truncated}`);
  assert.equal(browse.total, 2019, `不带 q 应当是整册浏览态，total 却是 ${browse.total}`);
});
await check('GET /api/hosts 同 host 聚合', async () => {
  const { json } = await get('/api/hosts?min=3');
  const d = dataOf(json);
  log('hosts 键', Object.keys(d).sort().join(','));
  const first = d.rows?.[0] ?? d.hosts?.[0];
  assert.ok(first, '一个聚合都没有，聚合口径要重看');
  log('hosts 首行', JSON.stringify(first).slice(0, 180));
  assert.ok((first.count ?? first.n ?? 0) >= 3, `min=3 却给了 ${JSON.stringify(first)}`);
});
await check('GET /api/entry 带 derived 与 note', async () => {
  const slug = snapshot.result?.rows?.[0]?.slug;
  assert.ok(slug, 'snapshot.result.rows 里没有可直接用的 slug，换个取法');
  const { json } = await get(`/api/entry?slug=${encodeURIComponent(slug)}`);
  const e = dataOf(json).entry;
  log('entry 键', Object.keys(e).sort().join(','));
  assert.equal(e.slug, slug, '取回来的不是问的那一条');
  assert.ok(e.derived, '派生句没进载荷（S1 那套字段派生白写）');
  log('entry 首条', `${e.slug} | derived=${JSON.stringify(e.derived).slice(0, 160)}`);
  const missing = await get(`/api/entry?slug=${encodeURIComponent('Nope::No-Such-Thing')}`, 404);
  log('entry 404 载荷', JSON.stringify(missing.json).slice(0, 160));
});
await check('GET /api/changes 流水（首轮要么全 added 要么空，两种都得是真话）', async () => {
  const { json } = await get('/api/changes?limit=5');
  const d = dataOf(json);
  log('changes 行数', `${d.rows.length}（limit=5 问的）`);
  log('changes 首行', JSON.stringify(d.rows[0] ?? null).slice(0, 200));
  assert.equal(d.meta.sha, meta.sha, 'changes 附带的那份 meta 与库里不是同一份');
  assert.ok(d.rows.every((r) => r.id && r.at && r.kind && r.slug), '流水行少字段');
});
await check('GET /api/notes 四视图（现在应当是空表）', async () => {
  for (const v of ['all', 'starred', 'tags', 'orphan']) {
    const { json } = await get(`/api/notes?view=${v}`);
    const d = dataOf(json);
    assert.equal(d.view, v, `view 回显不对：${d.view}`);
    assert.ok(Array.isArray(d.rows), 'rows 不是数组');
    if (v === 'all') log('notes all 行数', String(d.rows.length));
  }
  const bad = await get('/api/notes?view=nope', 400);
  log('notes 非法视图', JSON.stringify(bad.json).slice(0, 140));
});
await check('GET /api/prefs strict 读（表目录还没建也不该抛）', async () => {
  const { json } = await get('/api/prefs');
  const p = dataOf(json);
  log('prefs 载荷', JSON.stringify(p));
  assert.equal(p.intervalMin > 0, true, 'intervalMin 不是正数');
  assert.equal('proxyUrl' in p, false, 'prefs 里冒出了 proxyUrl');
  log('prefs 表目录', existsSync(join(STORE_DIR, 'prefs')) ? '已落盘（说明界面存过偏好）' : '不存在（strict 读走的是默认值，没顺手写盘）');
});

/* ---------- 3. SSE 首帧 ---------- */
console.log('\n=== [3] GET /api/stream 第一帧（AbortController 3s 内撤） ===');
await check('stream 接上就发整份快照', async () => {
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 4000);
  let head = '';
  let ct = null;
  let chunks = 0;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`read 超时 ${ms}ms`)), ms))]);
  try {
    const r = await fetch(`${BASE}${PREFIX}/api/stream`, { signal: ac.signal });
    ct = r.headers.get('content-type');
    const reader = r.body.getReader();
    while (head.length < 400 || !head.includes('\n\n')) {
      const { done, value } = await withTimeout(reader.read(), 2500);
      if (done) break;
      chunks += 1;
      head += new TextDecoder().decode(value);
      if (head.length > 4000) break;
    }
    try { await withTimeout(reader.cancel(), 500); } catch { /* 撤了就撤了 */ }
  } catch (e) {
    log('stream 中断', `${e.name || ''} ${e.message}`.slice(0, 120));
  } finally { clearTimeout(kill); ac.abort(); }
  log('stream CT', `${ct} 收到 ${chunks} 块 ${head.length}B`);
  assert.ok(head.length > 0, '一帧都没收到');
  assert.ok(/text\/event-stream/.test(ct ?? ''), `不是 event-stream：${ct}`);
  assert.ok(head.includes('snapshot'), `第一帧里没有 snapshot 事件：${head.slice(0, 240)}`);
  log('stream 首帧头', head.slice(0, 160).replace(/\n/g, '\\n'));
});

/* ---------- 3b. 页面路径（面板不走这条通道，但 404 的**信封**能证明路由表挂在宿主上） ---------- */
console.log('\n=== [3b] GET /api-catalog/ （页面路径应当由我们的路由表说"没有这个接口"） ===');
await check('未注册的路径回的是插件自己的错误信封', async () => {
  const r = await get('/', 404);
  const body = r.json;
  assert.equal(body.ok, false, `页面路径却回了 ok:true：${JSON.stringify(body).slice(0, 160)}`);
  assert.equal(body.error?.code, 'NOT_FOUND', `错误码不是 NOT_FOUND：${JSON.stringify(body).slice(0, 160)}`);
  log('页面路径 404', `${r.res.status} ${JSON.stringify(body).slice(0, 150)}`);
});

/* ---------- 4. 汇总 ---------- */
console.log('\n=== [4] 读数台账 ===');
console.log(notes.join('\n'));
console.log(`\n[live-check] fail ${fails.length}`);
if (fails.length) console.log(fails.join('\n'));
process.exitCode = fails.length ? 1 : 0;
/* SSE 那条连接撤了也可能留下 socket 让进程不退出：探针脚本读数的目的已达到，直接收。 */
process.exit(process.exitCode);
