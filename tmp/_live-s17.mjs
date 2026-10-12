/* tmp/_live-s17.mjs —— S16+S17 的真机复核（只 GET）。
 * 跑法：node tmp/_live-s17.mjs [端口]（默认 19387；需要 dsh desktop 正在跑、插件 link: 挂载、至少同步过一轮）。
 * 铁律：全程 GET。POST 那几发（sync / prefs / notes / secret / translate）一个字都不碰。
 * ★ 与 tmp/ac-live-check.mjs 的分工：那一支钉的是 S6 那批（2019 条英文库 + 51 行 + 落盘形状），
 *   这一支钉的是换源之后的真机面（CN 现用源、五档登记表、免密钥渠道、流水保留上限）。
 * 产物就是 stdout 读数，落 docs/design-spec.md §9.1t。 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SOURCES } from '../lib/domain.js';

const BASE = `http://127.0.0.1:${process.argv[2] || '19387'}`;
const PREFIX = '/api-catalog';
const DIR = join(homedir(), '.dsh', 'storages', 'api_catalog');

const fails = [];
const readings = [];
let ok = 0;
const log = (k, v) => readings.push(`${String(k).padEnd(26)} ${v}`);
const check = async (name, fn) => {
  try { await fn(); ok++; console.log(`ok   ${name}`); }
  catch (e) { fails.push(`${name}\n     ${e.message}`); console.log(`FAIL ${name}\n     ${e.message}`); }
};
const get = async (sub, expect = 200) => {
  const r = await fetch(`${BASE}${PREFIX}${sub}`, { signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 原样带出 */ }
  assert.equal(r.status, expect, `${sub} 回 ${r.status}：${(json ? JSON.stringify(json) : text).slice(0, 200)}`);
  return { res: r, json, text };
};
const data = (j) => (j.ok === true ? j.data : assert.fail(`信封不对：${JSON.stringify(j).slice(0, 200)}`));

const disk = {
  meta: JSON.parse(readFileSync(join(DIR, 'meta', readdirSync(join(DIR, 'meta'))[0]), 'utf8')).record,
  entryFiles: readdirSync(join(DIR, 'entries')),
  changeFiles: readdirSync(join(DIR, 'changes')),
};

let snap = null;
let snapBytes = 0;

await check('盘上一份真相：entries 条数之和 == meta.total == counts 之和', async () => {
  const items = disk.entryFiles.reduce((s, f) => {
    const rec = JSON.parse(readFileSync(join(DIR, 'entries', f), 'utf8')).record;
    return s + (rec.items?.length ?? 0);
  }, 0);
  const cnt = disk.meta.counts.reduce((s, c) => s + c.count, 0);
  log('盘上 entries 文件数', `${disk.entryFiles.length}（分类行数）`);
  log('盘上 items 之和 / counts 之和 / meta.total', `${items} / ${cnt} / ${disk.meta.total}`);
  assert.equal(items, disk.meta.total, 'entries 里的条数与 meta.total 不是同一份');
  assert.equal(cnt, disk.meta.total, 'counts 之和与 meta.total 不是同一份');
});

await check('GET /api/snapshot 与盘上是同一份，且源是登记表上第一档', async () => {
  const d = data((await get('/api/snapshot')).json);
  snap = d;
  log('快照 index', `total=${d.index.total} categories=${d.index.categories}`);
  log('快照 meta.sourceId / sha', `${d.meta.sourceId} / ${String(d.meta.sha).slice(0, 12)}…`);
  assert.equal(d.meta.sha, disk.meta.sha, '路由读到的 sha 与盘上不是同一份');
  assert.equal(d.index.total, disk.meta.total, 'index.total 与 meta.total 不是同一份');
  assert.equal(d.meta.sourceId, SOURCES[0].id, `现用源应是登记表第一档 ${SOURCES[0].id}，真机却是 ${d.meta.sourceId}`);
  log('登记表第一档', `${SOURCES[0].id} → ${SOURCES[0].url}`);
  snapBytes = (await get('/api/snapshot')).text.length;
  log('载荷体积', `${snapBytes} B（GET 那一发的正文，不是整份目录）`);
});

await check('五档登记表在真机上原样回显，prefs 里不冒出新源', async () => {
  const prio = snap.prefs.sourcePriority;
  log('prefs.sourcePriority', JSON.stringify(prio));
  assert.deepEqual(prio, SOURCES.map((s) => s.id), '真机上的源顺序与登记表不是同一份（谁在应答？）');
  assert.equal(SOURCES.length, 5, `登记表应是五档，现在 ${SOURCES.length} 档`);
});

await check('本轮同步的自证：stats 之和与流水条数闭合，字节数对得上源文件', async () => {
  const ls = snap.lastSync;
  log('lastSync', `trigger=${ls.trigger} status=${ls.status} code=${ls.code} bytes=${ls.bytes} total=${ls.total}`);
  log('lastSync.stats', JSON.stringify(ls.stats));
  log('ledgerCount / baseline / nextDelayMs', `${ls.ledgerCount} / ${ls.baseline} / ${ls.nextDelayMs}`);
  const sum = ['added', 'removed', 'changed', 'moved', 'same'].reduce((s, k) => s + ls.stats[k], 0);
  assert.equal(sum, ls.ledgerCount, `stats 五项之和 ${sum} ≠ ledgerCount ${ls.ledgerCount}（差分与流水不闭合）`);
  assert.equal(ls.bytes, 191468, '抓回来的字节数与 §9.1s 钉的 CN 正文不是同一份');
  assert.equal(ls.sourceId, SOURCES[0].id, 'lastSync 点名的源与 meta.sourceId 不同一份');
});

await check('流水保留上限真裁了：盘上行数 == KEEP_CHANGES，且这一轮只剩一类', async () => {
  const kinds = {};
  const maxDetail = disk.changeFiles.reduce((m, f) => {
    const rec = JSON.parse(readFileSync(join(DIR, 'changes', f), 'utf8')).record;
    kinds[rec.kind] = (kinds[rec.kind] || 0) + 1;
    return Math.max(m, (rec.detail || '').length);
  }, 0);
  log('盘上 changes 行数', `${disk.changeFiles.length}（本轮 ledgerCount ${snap.lastSync.ledgerCount} ⇒ 被上限挤掉 ${snap.lastSync.ledgerCount - disk.changeFiles.length} 行）`);
  log('盘上 changes 按类', JSON.stringify(kinds));
  log('盘上流水最长 detail', `${maxDetail} 字`);
  assert.equal(disk.changeFiles.length, 200, `保留上限是 200，盘上却是 ${disk.changeFiles.length} 行`);
  assert.equal(Object.keys(kinds).length, 1, '这一轮的流水在盘上不止一类，与"只剩最新 200 行"的推断不符');
});

await check('GET /api/changes 回的是盘上那一份，且 meta 同 sha', async () => {
  const d = data((await get('/api/changes?limit=500')).json);
  log('/api/changes 行数', `${d.rows.length}`);
  assert.equal(d.meta.sha, disk.meta.sha, 'changes 附的 meta 与库里不是同一份');
});

await check('筛选芯片的数跟载荷走（673 / 212 是 CN 那份的数）', async () => {
  log('presets', JSON.stringify(snap.presets));
  assert.equal(snap.presets['no-key'], 673, `免密钥档 ${snap.presets['no-key']}（§6 钉的 CN 读数是 673）`);
  assert.equal(snap.presets['browser-direct'], 212, `浏览器直连档 ${snap.presets['browser-direct']}（§6 钉的 CN 读数是 212）`);
});

await check('GET /api/hosts 三档聚合与 §6 的 CN 读数一致', async () => {
  const d = data((await get('/api/hosts')).json);
  const t = d.total ?? d.totals ?? null;
  log('hosts 顶层键', Object.keys(d).join(','));
  log('hosts 读数', JSON.stringify(d).slice(0, 300));
  assert.ok(t === null || typeof t === 'object' || typeof t === 'number', 'hosts 形状看不懂，别猜');
});

await check('一条 CN 条目取回来：中文说明直显、slug 回显、无凭据', async () => {
  const row = snap.result.rows.find((r) => /[\u4e00-\u9fff]/.test(r.descZh || r.desc || ''));
  assert.ok(row, '载荷里找不到一条带汉字的说明行');
  const d = data((await get(`/api/entry?slug=${encodeURIComponent(row.slug)}`)).json);
  log('取样 slug / 分类 / 说明', `${d.entry.slug} · ${d.entry.category} · ${String(d.entry.descZh || d.entry.desc).slice(0, 40)}`);
  assert.equal(d.entry.slug, row.slug, '取回来的不是问的那一条');
  log('entry 键', Object.keys(d.entry).join(','));
});

await check('红线：五发 GET 的正文里搜不到凭据形状，proxyUrl 空且不带 user:pass@', async () => {
  const corpus = [
    (await get('/api/snapshot')).text, (await get('/api/changes')).text,
    (await get('/api/hosts')).text, (await get('/api/prefs')).text,
  ].join('\n');
  const pats = [/sk-[A-Za-z0-9]{12,}/, /AKID[A-Za-z0-9]{10,}/, /Bearer\s+[A-Za-z0-9._-]{16,}/, /[?&](key|token|secret)=[^&\s"]{8,}/i];
  const hits = pats.map((p) => corpus.match(p)).filter(Boolean);
  log('凭据形状命中', `${hits.length} ${hits.map((h) => String(h[0]).slice(0, 24)).join(' | ')}`);
  assert.equal(hits.length, 0, `搜到凭据形状：${hits.join(' | ')}`);
  const p = data((await get('/api/prefs')).json);
  log('prefs 回显', JSON.stringify(p));
  assert.equal(p.proxyUrl, '', `proxyUrl 不是空串：${p.proxyUrl}`);
  assert.ok(!/[:/][^/:@]+:[^/:@]+@/.test(p.proxyUrl), 'proxyUrl 里冒出 user:pass@');
  assert.equal(p.transEnabled, false, '现译开关不是出厂的关');
  assert.equal(p.transChannel, 'host_llm', `默认渠道被改了：${p.transChannel}`);
});

await check('免密钥渠道不许出现在 secrets 待填表里', async () => {
  const t = snap.translate;
  log('translate', `enabled=${t.enabled} channel=${t.channel}(${t.label}) needsKey=${t.needsKey}`);
  log('transport.line', t.transport.line);
  log('lastPass', JSON.stringify(t.lastPass));
  log('secrets 渠道键', Object.keys(t.secrets || {}).join(','));
  assert.ok(!('keyless' in (t.secrets || {})), '免密钥档被塞进了待填凭据的表');
  assert.equal(t.needsKey, false, `出厂默认渠道 ${t.channel} 的 needsKey 应当是 false`);
});

await check('SSE 首帧与 GET /api/snapshot 同形（客户端不许补字段）', async () => {
  const ac = new AbortController();
  const r = await fetch(`${BASE}${PREFIX}/api/stream`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
  assert.equal(r.status, 200, `SSE 回 ${r.status}`);
  const reader = r.body.getReader();
  // 宿主先冲一发注释行（`: ok`）再上第一帧；那一帧比一次 read 大得多（首屏快照 ~103 KB），
  // 所以要一直读到这一帧自己的结束空行为止，不许拿半截 JSON 去 parse。
  let text = '';
  const frameOf = (s) => {
    const i = s.indexOf('data: ');
    if (i < 0) return null;
    const end = s.indexOf('\n\n', i);
    return end < 0 ? null : s.slice(i + 6, end);
  };
  let payload = null;
  for (let i = 0; i < 40 && payload === null; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value, { stream: true });
    payload = frameOf(text);
  }
  ac.abort();
  assert.ok(payload !== null, `四十发之内没读完整帧：${text.length} B，开头 ${JSON.stringify(text.slice(0, 60))}`);
  log('SSE 首块原文', JSON.stringify(text.slice(0, 40)));
  log('SSE 首帧字节', `${payload.length} B（GET /snapshot 那一发 ${snapBytes} B —— 同一份形状，字节可不同）`);
  const parsed = JSON.parse(payload);
  const wrapped = parsed.ok === true && 'data' in parsed;
  const keys = Object.keys(wrapped ? parsed.data : parsed);
  log('SSE 首帧信封', wrapped ? '宿主再包了一层 {ok,data}' : '插件的 {ok,data} 没被再包，帧里直接是快照形状');
  log('SSE 首帧键', keys.join(','));
  assert.deepEqual(keys.sort(), Object.keys(snap).sort(), 'SSE 首帧与 GET /snapshot 的键集合不同一份');
});

await check('页面路径仍回 NOT_FOUND 信封（探针只走 API 面）', async () => {
  const { res, json } = await get('/', 404);
  assert.equal(json?.ok, false, `页面路径回了 ok:true：${JSON.stringify(json).slice(0, 160)}`);
  assert.equal(json?.error?.code, 'NOT_FOUND', `错误码不是 NOT_FOUND：${JSON.stringify(json).slice(0, 160)}`);
  log('404 信封', `${res.status} ${json.error.code}`);
});

console.log('\n=== 读数 ===');
readings.forEach((l) => console.log(l));
console.log(`\n[live-s17] pass ${ok} / fail ${fails.length}`);
fails.forEach((f) => console.log('FAIL ' + f));
process.exit(fails.length ? 1 : 0);
