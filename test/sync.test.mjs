/**
 * test/sync.test.mjs —— 一轮同步（lib/sync.js）。
 *
 * 判据取向全部围绕 lib/sync.js 头注那六条口径，外加差分本身：
 *   A 门与写序：门不过就一行都不写、单飞是 rejected promise、退避只按档位、键规则对不上不碰库；
 *   B 差分：只重写真变了的分类行、认不出身份就判删+加、笔记搬家与 orphan 接回、行序变化不算改动；
 *   C 口径：meta 摘要与流水跟 entries 对得上、写序 entries→notes→changes→meta。
 * 真数据用两份夹具 README（英文 public-apis 2019 条 / 51 类，中文 public-apis-cn 1494 条 / 54 类 ——
 * 后者是 2026-10-07 定的抓取源，英文那份留着专测"整库换源"那一轮差分），小数据用 diffCatalog 直接单测（构造出来的歧义只有手工才有）。
 */
import { check, runAll, assert, makeFakeFacility, makeFakeFetch, fixture } from './_helpers.mjs';
import { parseCatalog } from '../lib/parse.js';
import { sha256Hex } from '../lib/fetch.js';
import {
  SOURCES, TABLES, DOMAIN_NAME, META_KEY, DEFAULT_PREFS, CHECK_INTERVALS,
  BACKOFF_STEPS, SYNC_BUSY, SYNC_NO_CHANGE, SYNC_PARSE_ERROR, SYNC_FAIL,
  KEEP_CHANGES, CHANGE_DETAIL_MAX_LEN, ENTRY_ROW_VERSION,
  CHANGE_KINDS, CHANGE_KIND_LABELS,
} from '../lib/domain.js';
import { KEY_RULE_VERSION, categoryKey } from '../lib/keys.js';
import { createAllStores } from '../lib/stores.js';
import { createSync, diffCatalog, rowFingerprint, nextBackoff, nextDelayMs, SyncBusyError } from '../lib/sync.js';

const README = await fixture('public-apis-README.md');
const CNREADME = await fixture('public-apis-cn-README.md');
const NO_INDEX = await fixture('fx-no-index.md');
const parsed = parseCatalog(README);
const cnParsed = parseCatalog(CNREADME);
const NOW = 1777000000000;

function makeLogger() {
  const lines = [];
  return { lines, warn: (m) => lines.push(String(m)), info: () => {}, error: (m) => lines.push(String(m)) };
}

/**
 * 一套假设施 + 可变正文的假 fetch。
 * `setBody(text)` 换正文（同一套库继续跑下一轮），`setAllFail()` 让登记表里每一档全断。
 */
function rig({ text = README, nowValue = NOW, facility } = {}) {
  const f = facility ?? makeFakeFacility();
  const logger = makeLogger();
  let mode = { text };
  const routes = {};
  for (const s of SOURCES) routes[s.url] = () => (mode.fail ? { fail: mode.fail } : { text: mode.text });
  const fetchImpl = makeFakeFetch(routes);
  // `nowValue` 允许是函数：真宿主走的是会走的钟，用例要能在"每次读都 +1 ms"下复核排序前提。
  const now = typeof nowValue === 'function' ? nowValue : () => nowValue;
  const stores = createAllStores({ getFacility: () => f, logger, now });
  const sync = createSync({ stores, fetchImpl, logger, now });
  return {
    f, stores, sync, logger, fetchImpl,
    setBody: (t) => { mode = { text: t }; },
    setAllFail: (why = '连接被断') => { mode = { fail: why }; },
    puts: () => f.calls.puts,
  };
}

/** 按解析结果拼一份"库里已有的分类行"（只有集成用例的起点需要）。 */
function rowsFrom(entries, at = NOW) {
  const groups = new Map();
  for (const e of entries) {
    const item = {
      slug: e.slug, name: e.name, url: e.url, host: e.host, desc: e.desc,
      auth: e.auth, https: e.https, cors: e.cors, category: e.category,
      firstSeenAt: at, lastSeenAt: at,
    };
    const list = groups.get(e.category);
    if (list) list.push(item); else groups.set(e.category, [item]);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, rowVersion: ENTRY_ROW_VERSION, updatedAt: at, items }));
}

const item = (o) => ({
  slug: 'Animals::axolotl', name: 'Axolotl', url: 'https://theaxolotlapi.netlify.app/', host: 'theaxolotlapi.netlify.app',
  desc: 'Collection of axolotl pictures', auth: 'No', https: 'Yes', cors: 'Yes', category: 'Animals',
  firstSeenAt: 1, lastSeenAt: 1, ...o,
});
const row = (category, items) => ({ category, rowVersion: ENTRY_ROW_VERSION, updatedAt: 1, items });
/** diffCatalog 的 nextItems 是刚解析的条目：没有时刻字段，还带 line/categoryLine（schema 会丢）。 */
const nextOf = (o) => {
  const merged = { ...item(o) };
  delete merged.firstSeenAt;
  delete merged.lastSeenAt;
  return { ...merged, line: 100, categoryLine: 99, authRaw: '' };
};

/**
 * 「本轮摘要」那一行的期望正文。数取 `diff.stats`、词取 `CHANGE_KIND_LABELS` ——
 * 与 `lib/sync.js` 的 `roundSummary` 同源派生，用例里不手抄一份话术（抄了就只测得到字符串）。
 */
const roundDetail = (stats, sourceId) =>
  `${CHANGE_KINDS.map((k) => `${CHANGE_KIND_LABELS[k]} ${Number(stats?.[k]) || 0}`).join(' · ')} · 源 ${sourceId}`;

/* ================= A. 门、写序与降级 ================= */

check('首轮建基线：51 个分类行、meta 摘要齐全、流水一行不写', async () => {
  const r = rig();
  const res = await r.sync.run();
  assert.equal(res.ok, true);
  assert.equal(res.status, 'success');
  assert.equal(res.baseline, true, '库里没有快照时首轮必须是基线轮，否则 2019 条会被记成"上游新增"');
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.entries), 51);
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.changes), 0, `基线轮写了流水：${r.f.rowCount(DOMAIN_NAME, TABLES.changes)} 行`);
  assert.equal(res.stats.added, 2019, '基线轮的计数照要给（流水不写不等于数字不算）');
  const meta = r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
  assert.equal(meta.keyRule, KEY_RULE_VERSION);
  assert.equal(meta.lastStatus, 'success');
  assert.equal(meta.total, 2019);
  assert.equal(meta.counts.length, 51);
  assert.equal(meta.counts.reduce((s, c) => s + c.count, 0), 2019, 'meta.counts 合计必须等于 total');
  assert.equal(r.f.calls.open, 1, '五张表各开一次域');
});

check('哈希门：正文一模一样就一行都不写，只推 lastCheckedAt', async () => {
  // ★ 钟必须真的往前走。S19 的变异电池（M10：把 noChange 分支里的 lastCheckedAt 整个删掉）在冻结的
  //   NOW 下全绿 —— 因为第一轮已经把它写成 NOW，第二轮不写也是那个值，断言当场分不出"推了"和"没推"。
  //   这一条的前提本来就挂在时刻上（界面页头那句「· 10/8 07:57」全靠它），所以给它一分钟一跳的钟。
  let tick = 0;
  const r = rig({ nowValue: () => NOW + (++tick) * 60_000 });
  await r.sync.run();
  const first = r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY).lastCheckedAt;
  const putsBefore = r.puts();
  const res = await r.sync.run();
  assert.equal(res.status, 'noChange');
  assert.equal(res.code, SYNC_NO_CHANGE);
  assert.equal(r.puts() - putsBefore, 1, '哈希门这一轮除 meta 那一行外不该有任何 put');
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.entries), 51);
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.changes), 0);
  const meta = r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
  assert.equal(meta.lastStatus, 'noChange');
  assert.equal(meta.lastCheckedAt, NOW + 120_000, '「查了但没变」那一轮也要把检查时刻推上去（页头那句时刻读的就是它）');
  assert.ok(meta.lastCheckedAt > first, `lastCheckedAt 没前进（${first} → ${meta.lastCheckedAt}）：界面会把"两小时前查过"念成昨天的`);
  assert.equal(meta.fetchedAt, NOW + 60_000, '源内容没变 ⇒ 快照时刻不该跟着推（那是"条目是哪一版"，不是"什么时候查过"）');
  assert.equal(meta.sha, sha256Hex(README), '没变化的那一轮不许把 sha 写歪（下一轮的哈希门全靠它）');
});

check('故障恢复后的第一次「没变化」不被读成还在故障中', async () => {
  const r = rig();
  await r.sync.run();
  r.setAllFail('线路断了');
  const bad = await r.sync.run();
  assert.equal(bad.code, SYNC_FAIL.FETCH);
  r.setBody(README);
  const back = await r.sync.run();
  assert.equal(back.status, 'noChange', '正文没变就该走没变化，不该继续报故障');
  const meta = r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
  assert.equal(meta.lastStatus, 'noChange', '界面靠 lastStatus 判断当前好坏，lastError 只是历史');
  assert.equal(meta.backoff, 0, '没变化也是"源通了"，退避要归零');
  assert.ok(String(meta.lastError).includes('都没拿到正文'), `lastError 要留下故障那句话：${meta.lastError}`);
  assert.ok(String(meta.lastError).includes('network'), `lastError 里要看得见失败种类：${meta.lastError}`);
  assert.ok(r.logger.lines.some((l) => l.includes('线路断了')), '每个源的原始报错全文要留在宿主日志里（界面只给一行）');
});

check('解析门：正文读不出时保留上一次快照，entries 一行不动', async () => {
  const r = rig();
  await r.sync.run();
  const animalsBefore = JSON.stringify(r.f.rawRow(DOMAIN_NAME, TABLES.entries, categoryKey('Animals')));
  const putsBefore = r.puts();
  r.setBody(NO_INDEX);
  const res = await r.sync.run();
  assert.equal(res.code, SYNC_PARSE_ERROR);
  assert.equal(res.ok, false);
  assert.equal(r.puts() - putsBefore, 2, '解析门只该写流水 + meta 各一行');
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.entries), 51, '旧目录被覆盖掉了');
  const meta = r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
  assert.equal(meta.lastErrorCode, SYNC_PARSE_ERROR);
  assert.equal(meta.total, 2019, '解析失败不许把 total 改成 0（界面会以为上游删光了）');
  assert.ok(String(meta.lastError).includes('## Index'), `lastError 要说清为什么读不出：${meta.lastError}`);
  assert.equal(JSON.stringify(r.f.rawRow(DOMAIN_NAME, TABLES.entries, categoryKey('Animals'))), animalsBefore, '解析门把旧行改掉了');
  const ledger = await r.stores.changes.list(5);
  assert.equal(ledger[0].kind, 'source_error');
  assert.ok(ledger[0].detail.includes('解析失败'));
});

check('整条链全断：每一档的原因一条不少，退避走一档', async () => {
  const r = rig();
  const res = await r.sync.run();
  assert.equal(res.ok, true);
  r.setAllFail('没有路由到 host');
  const bad = await r.sync.run();
  assert.equal(bad.code, SYNC_FAIL.FETCH);
  assert.equal(bad.lastErrorCode, 'network');
  // 源的名字从登记表取，不在用例里手抄 label：换源那次就是手抄的 label 先烂的。
  assert.ok(bad.reason.includes(SOURCES[0].label), `少了真源那一档：${bad.reason}`);
  assert.ok(bad.reason.includes(SOURCES[SOURCES.length - 1].label), `少了末档：${bad.reason}`);
  const meta = r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
  assert.equal(meta.backoff, 1);
  assert.equal(bad.nextDelayMs, DEFAULT_PREFS.intervalMin * 60_000 * BACKOFF_STEPS[1]);
  const ledger = await r.stores.changes.list(3);
  assert.equal(ledger[0].kind, 'source_error');
  assert.equal(SOURCES.every((s) => ledger[0].detail.includes(s.label)), true, `流水里少了源：${ledger[0].detail}`);
  // 上一行只保证"逐档都在"，这一行钉的是没被截：截断发生时丢的正是末尾那一档。
  assert.equal(ledger[0].detail.endsWith('…'), false, `整条链那一行被截了：${ledger[0].detail}`);
});

check('退避按档位递增并封顶，成功那一轮归零', async () => {
  const r = rig();
  await r.sync.run();
  r.setAllFail('断网');
  const steps = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await r.sync.run();
    steps.push(r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY).backoff);
    assert.equal(res.nextDelayMs, DEFAULT_PREFS.intervalMin * 60_000 * BACKOFF_STEPS[steps[i]]);
  }
  assert.deepEqual(steps, [1, 2, 3, 3, 3, 3], `退避不该无限涨：${steps.join(',')}`);
  r.setBody(README);
  const ok = await r.sync.run();
  assert.equal(ok.status, 'noChange');
  assert.equal(r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY).backoff, 0);
});

check('单飞：上一轮没结束再触发是 rejected promise，不是同步 throw', async () => {
  const r = rig();
  let syncThrow = null;
  let second = null;
  const first = r.sync.run();
  assert.equal(r.sync.busy, true, '第一轮在跑，busy 得是真的');
  try {
    second = r.sync.run();
  } catch (e) {
    syncThrow = e;
  }
  assert.equal(syncThrow, null, '同步 throw 会从宿主的定时器回调里逃逸（modelwatch 血案同条）');
  assert.ok(second && typeof second.then === 'function', '占用中要返回一个 promise');
  const err = await second.then(() => null, (e) => e);
  assert.ok(err instanceof SyncBusyError);
  assert.equal(err.code, SYNC_BUSY.code);
  assert.equal(err.http, SYNC_BUSY.http);
  await first;
  assert.equal(r.sync.busy, false, '跑完没释放锁，下一轮永远触发不了');
  const again = await r.sync.run();
  assert.equal(again.status, 'noChange');
});

check('键规则对不上：一行都不写，也一次都不 fetch', async () => {
  const r = rig();
  await r.stores.entries.read();
  r.f.seed(DOMAIN_NAME, TABLES.meta, META_KEY, { keyRule: KEY_RULE_VERSION + 1, sha: '旧规则那份', total: 10 });
  const putsBefore = r.puts();
  const res = await r.sync.run();
  assert.equal(res.code, SYNC_FAIL.KEY_RULE);
  assert.equal(res.stored, false);
  assert.equal(r.puts(), putsBefore, '这一支一行库都不许碰');
  assert.equal(r.fetchImpl.seen.length, 0, '明知不能写还去抓正文，就是白挨一发限流');
  assert.ok(r.logger.lines.some((l) => l.includes('键规则')), '没 warn 就没有排查线索');
});

check('没有存储设施：run 不 reject，如实报 storage_unavailable', async () => {
  const f = makeFakeFacility();
  const r = rig({ facility: f });
  const stores = createAllStores({ getFacility: () => undefined, logger: makeLogger() });
  const sync = createSync({ stores, fetchImpl: r.fetchImpl, logger: makeLogger(), now: () => NOW });
  const res = await sync.run();
  assert.equal(res.ok, false);
  assert.equal(res.code, SYNC_FAIL.STORAGE);
  assert.equal(sync.busy, false, '这条路也要放锁');
});

check('写序是 entries → notes → changes → meta（meta 最后 = sha 是成功凭据）', async () => {
  const r = rig();
  await r.sync.run();
  const order = [];
  const spy = {};
  for (const name of ['entries', 'meta', 'notes', 'prefs', 'changes']) {
    spy[name] = new Proxy(r.stores[name], {
      get(target, prop) {
        const v = target[prop];
        if (typeof v === 'function') {
          return (...args) => { order.push(`${String(prop)}:${name}`); return v.apply(target, args); };
        }
        return v;
      },
    });
  }
  const sync = createSync({ stores: spy, fetchImpl: r.fetchImpl, logger: makeLogger(), now: () => NOW + 1 });
  const mutated = README.split('\n');
  const cells = mutated[parsed.entries[0].line - 1].split('|');
  cells[4] = ' apiKey ';
  mutated[parsed.entries[0].line - 1] = cells.join('|');
  r.setBody(mutated.join('\n'));
  const res = await sync.run();
  assert.equal(res.status, 'success');
  const first = order.indexOf('writeMany:entries');
  const last = order.lastIndexOf('patch:meta');
  assert.ok(first !== -1 && last > first, `meta 必须最后写：${order.join(' → ')}`);
  assert.ok(order.includes('readAll:entries') && order.includes('readAll:notes'));
});

/* ================= B. 差分（真数据集成） ================= */

check('上游只改一条 ⇒ 只重写它那一个分类行', async () => {
  const r = rig();
  await r.sync.run();
  const lines = README.split('\n');
  const cells = lines[parsed.entries[0].line - 1].split('|');
  cells[4] = ' apiKey ';
  lines[parsed.entries[0].line - 1] = cells.join('|');
  r.setBody(lines.join('\n'));
  const putsBefore = r.puts();
  const res = await r.sync.run();
  assert.equal(res.status, 'success');
  assert.equal(res.stats.changed, 1);
  assert.equal(res.stats.same, 2018);
  assert.equal(res.stats.rowsWritten, 1, '改一条却重写了整个目录：分类切行就白做了');
  assert.equal(res.stats.rowsRemoved, 0);
  assert.equal(r.puts() - putsBefore, 4, '一行分类 + 一条明细流水 + 一条本轮摘要 + meta 收尾');
  const ledger = await r.stores.changes.list(5);
  assert.equal(ledger.length, 2, `一轮差分两行：明细一行 + 摘要一行，读出 ${ledger.length} 行`);
  assert.equal(ledger[0].kind, 'round', '摘要行没排在第一（同 at 下 seq 最大才排得动，界面第一行要的就是整轮读数）');
  assert.equal(ledger[0].detail, roundDetail(res.stats, SOURCES[0].id), '摘要行没把本轮的数念全');
  assert.equal(ledger[1].kind, 'changed');
  assert.ok(ledger[1].detail.includes('HTTPS'), `流水要说清动了哪一列：${ledger[1].detail}`);
});

check('上游改了显示名 ⇒ 按 url 认身份、笔记搬家、流水登记改名', async () => {
  const r = rig();
  await r.sync.run();
  const target = parsed.entries.find((e) => e.category === 'Animals');
  const lines = README.split('\n');
  const idx = target.line - 1;
  lines[idx] = lines[idx].replace(`[${target.name}]`, '[Axolotl Facts]');
  r.setBody(lines.join('\n'));
  await r.stores.notes.write({ slug: target.slug, category: 'Animals', purpose: '给它家的笔记', updatedAt: NOW });
  const res = await r.sync.run();
  assert.equal(res.stats.moved, 0);
  assert.equal(res.stats.changed, 1, `改名没认出来（应是 url 桥配对）：${JSON.stringify(res.stats)}`);
  const newSlug = parseCatalog(lines.join('\n')).entries.find((e) => e.name === 'Axolotl Facts').slug;
  assert.notEqual(newSlug, target.slug, '改名后主键没变，说明 slug 规则不是按名字算的');
  const note = await r.stores.notes.read(newSlug);
  assert.ok(note, '搬家没落到新键上（用户视角就是笔记丢了）');
  assert.equal(note.purpose, '给它家的笔记');
  assert.equal(await r.stores.notes.read(target.slug), null, '旧键没删净');
  const ledger = await r.stores.changes.list(3);
  assert.equal(ledger[0].kind, 'round');
  assert.equal(ledger[0].detail, roundDetail(res.stats, SOURCES[0].id));
  const renamed = ledger.find((x) => x.kind === 'changed');
  assert.ok(renamed, `改名没登记成明细行：${JSON.stringify(ledger.map((x) => x.kind))}`);
  assert.ok(renamed.detail.includes('名称'), renamed.detail);
});

check('上游把条目挪到别的分类 ⇒ 判 moved，笔记跟着搬家', async () => {
  const r = rig();
  await r.sync.run();
  const target = parsed.entries.find((e) => e.category === 'Animals');
  const lines = README.split('\n');
  const idx = target.line - 1;
  const moved = lines[idx];
  lines.splice(idx, 1);
  const animeLine = lines.findIndex((l) => l.trim() === '### Anime');
  lines.splice(animeLine + 2, 0, moved);
  r.setBody(lines.join('\n'));
  await r.stores.notes.write({ slug: target.slug, category: 'Animals', purpose: '挪走也要在', updatedAt: NOW });
  const res = await r.sync.run();
  assert.equal(res.stats.moved, 1, `换分类没判成 moved：${JSON.stringify(res.stats)}`);
  const movedItem = (await r.stores.entries.read('Anime')).items.find((i) => i.url === target.url);
  assert.ok(movedItem, '换分类后条目没落到新分类行里');
  const note = await r.stores.notes.read(movedItem.slug);
  assert.ok(note && note.category === 'Anime', `笔记没跟着搬家或分类名没改：${JSON.stringify(note)}`);
  assert.equal(await r.stores.notes.read(target.slug), null);
  const ledger = await r.stores.changes.list(3);
  assert.equal(ledger[0].kind, 'round');
  assert.equal(ledger[0].detail, roundDetail(res.stats, SOURCES[0].id));
  const shifted = ledger.find((x) => x.kind === 'moved');
  assert.ok(shifted, `换分类没登记成明细行：${JSON.stringify(ledger.map((x) => x.kind))}`);
  assert.ok(shifted.detail.includes('分类'), shifted.detail);
});

check('换源那一轮（英文正文 → 中文正文）：中文分类名整批落库，笔记按 url 桥搬家不丢', async () => {
  // 2026-10-07 的裁定：抓取源从 public-apis 换成 llf007/public-apis-cn。这一轮对差分是最狠的一次输入 ——
  // 51 个英文分类整批换成 54 个中文分类、条目从 2019 收到 1494，而**用户笔记的主键里带分类名**。
  // 所以这一条不只看"跑通了"，要钉三件：中文分类行真的落库、同 url 的笔记搬到了新键、旧键删净。
  const r = rig({ text: README });
  await r.sync.run();
  const target = parsed.entries.find((e) => e.category === 'Animals');
  const cnTarget = cnParsed.entries.find((e) => e.url === target.url);
  assert.ok(cnTarget, '夹具里那条在 CN 源没有 ⇒ 搬家这条判据没了样本，换一个共享 url 重测');
  assert.equal(cnTarget.category, '动物');
  assert.notEqual(cnTarget.slug, target.slug, '分类名进了主键，换源必然换主键（这正是这一条要防的）');
  await r.stores.notes.write({ slug: target.slug, category: target.category, purpose: '换源也得在', updatedAt: NOW });
  r.setBody(CNREADME);
  const res = await r.sync.run();
  assert.equal(res.ok, true);
  assert.equal(res.status, 'success');
  // 换源那天的账（2026-10-07）：旧库 2019 条 → 新源 1494 条，url 桥上认出 1379 条、判成全量搬家。
  // 钉这两条恒等式而不只钉数字：配对要是漏了一批，added/moved 会各自"看着正常"，但合不平总数。
  assert.equal(res.stats.total, 1494);
  assert.equal(res.stats.categories, 54);
  assert.equal(res.stats.moved, 1379);
  assert.equal(res.stats.added + res.stats.moved, res.stats.total, '新源条目没被 added/moved 全覆盖');
  assert.equal(res.stats.removed + res.stats.moved, 2019, '旧库条目没被 removed/moved 全覆盖（丢了就没人报）');
  assert.equal(res.stats.rowsRemoved, 51, '51 个英文分类行整批撤掉');
  assert.equal(res.stats.rowsWritten, 54);
  const cats = await r.stores.entries.readAllItems().then((xs) => [...new Set(xs.map((x) => x.category))]);
  assert.ok(cats.includes('动物') && cats.includes('AI模型'), `中文分类名没落库：${cats.slice(0, 6)}`);
  const row = await r.stores.entries.read('动物');
  assert.ok(row && row.items.some((i) => i.url === target.url), '条目没落到改名后的分类行里');
  const note = await r.stores.notes.read(cnTarget.slug);
  assert.ok(note, '换源那轮笔记没搬到新键 ⇒ 用户视角是整库笔记全丢');
  assert.equal(note.purpose, '换源也得在');
  assert.equal(note.category, '动物');
  assert.equal(await r.stores.notes.read(target.slug), null, '旧键没删净');
  // ★ 这一轮正是 U-17 的现场：明细 2000+ 行，trim 只留 KEEP_CHANGES 条，残片全是「源里删掉了」。
  //   整轮的真相（新增/搬家各多少、走的哪一档源）必须还活着并排在第一。
  const round = (await r.stores.changes.list(1))[0];
  assert.equal(round.kind, 'round', '换源那轮 trim 之后没有本轮摘要行');
  assert.equal(round.detail, roundDetail(res.stats, SOURCES[0].id), `摘要行的数与 stats 对不上：${round.detail}`);
});

check('上游删了一条 ⇒ 笔记转 orphan 不跟着删；重新出现就接回', async () => {
  const r = rig();
  await r.sync.run();
  const target = parsed.entries.find((e) => e.category === 'Animals');
  await r.stores.notes.write({ slug: target.slug, category: 'Animals', purpose: '删了也别丢', updatedAt: NOW });
  const lines = README.split('\n');
  lines.splice(target.line - 1, 1);
  r.setBody(lines.join('\n'));
  const res = await r.sync.run();
  assert.equal(res.stats.removed, 1);
  const note = await r.stores.notes.read(target.slug);
  assert.ok(note, '上游删条目就把用户的批注删了');
  assert.equal(note.orphan, true);
  assert.equal(note.purpose, '删了也别丢');
  r.setBody(README);
  const back = await r.sync.run();
  assert.equal(back.stats.added, 1);
  const revived = await r.stores.notes.read(target.slug);
  assert.equal(revived.orphan, false, '条目回来了但笔记还挂着 orphan，界面会继续显示成"上游已删"');
});

check('整类消失 ⇒ 那个分类行被删掉，别的行不动', async () => {
  const r = rig();
  await r.sync.run();
  const lines = README.split('\n');
  const head = lines.findIndex((l) => l.trim() === '### Animals');
  let end = head + 1;
  while (end < lines.length && !lines[end].startsWith('###')) end += 1;
  lines.splice(head, end - head);
  r.setBody(lines.join('\n'));
  const putsBefore = r.puts();
  const res = await r.sync.run();
  assert.equal(res.stats.rowsRemoved, 1, '分类没了但那一行还留在库里');
  assert.equal(res.stats.removed, 24, `Animals 应有 24 条被登记删除：${res.stats.removed}`);
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.entries), 50);
  assert.equal(await r.stores.entries.read('Animals'), null);
  assert.equal(res.stats.rowsWritten, 0, '别的分类没动却被重写了');
  assert.equal(r.puts() - putsBefore, 24 + 1 + 1, '删行不产生 put：只该有流水 24 条 + 本轮摘要 1 条 + meta 一行');
  const meta = r.f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
  assert.equal(meta.total, 2019 - 24);
  assert.equal(meta.counts.some((c) => c.name === 'Animals'), false);
});

check('上游只调了行序 ⇒ 不算改动，一行都不重写', async () => {
  const r = rig();
  await r.sync.run();
  const lines = README.split('\n');
  const a = parsed.entries[0].line - 1;
  const b = parsed.entries[1].line - 1;
  const t = lines[a]; lines[a] = lines[b]; lines[b] = t;
  r.setBody(lines.join('\n'));
  const putsBefore = r.puts();
  const res = await r.sync.run();
  assert.equal(res.status, 'success', '行序变了但内容没变，sha 门拦不住（正文确实不同了），差分必须拦住');
  assert.equal(res.stats.rowsWritten, 0, '行序变化被当成了改动，于是整分类重写');
  assert.equal(res.stats.same, 2019);
  assert.equal(res.ledgerCount, 0);
  assert.equal(r.puts() - putsBefore, 1, '只该有 meta 那一行 put（明细为空时摘要行也不写）');
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.changes), 0, '没有明细的一轮不该只留一条摘要行充数');
});

check('流水按 KEEP_CHANGES 封顶，多出来的是最旧的那些被砍（本轮摘要行必留）', async () => {
  const r = rig();
  await r.sync.run();
  const lines = README.split('\n');
  for (const e of parsed.entries.slice(0, KEEP_CHANGES + 50)) {
    const cells = lines[e.line - 1].split('|');
    cells[4] = ' apiKey ';
    lines[e.line - 1] = cells.join('|');
  }
  r.setBody(lines.join('\n'));
  const res = await r.sync.run();
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.changes), KEEP_CHANGES, '每轮 trim 没生效');
  const rows = await r.stores.changes.list(500);
  assert.ok(rows.length <= KEEP_CHANGES);
  assert.ok(rows[0].at >= rows[rows.length - 1].at, '流水倒序都没了');
  // ★ U-17 的要害：KEEP_CHANGES+50 条明细被挤到只剩 200 行，界面上要是连"这一轮改了多少"都没了，
  //   残片就会被读成整轮的真相（真机读数：2154 行只剩 200 行「源里删掉了」，§9.1t）。
  assert.equal(rows[0].kind, 'round', 'trim 之后本轮摘要不在第一 ⇒ 整轮读数被保留上限挤掉');
  assert.equal(rows[0].detail, roundDetail(res.stats, SOURCES[0].id));
  // ★ 前提钉住：一轮的所有流水行共用同一个 `at`（真时钟下若逐行现取时刻，摘要就排到最旧那头，上一条必红）。
  assert.equal(new Set(rows.map((r) => r.at)).size, 1, '一轮的流水行 at 不唯一 ⇒ seq 说不上话');
});

check('会走的钟下摘要行仍排第一：流水时刻由这一轮给定，不由 stores 逐行现取', async () => {
  // 上面那条的假时钟是冻结的（`now` 恒为 NOW），一轮里所有行天然同刻 ⇒ 那条测不出"逐行现取"这个错。
  // 真宿主用的就是会走的钟（client cl-27 是真装配、真 Date.now）—— 这里把同一件事在离线面钉住：
  // 每读一次 +1 ms，明细行若自己找 stores 取时刻就会比摘要行晚，排序与保留全反。
  let tick = NOW;
  const r = rig({ nowValue: () => ++tick });
  await r.sync.run();
  const lines = README.split('\n');
  const cells = lines[parsed.entries[0].line - 1].split('|');
  cells[4] = ' apiKey ';
  lines[parsed.entries[0].line - 1] = cells.join('|');
  r.setBody(lines.join('\n'));
  await r.sync.run();
  const rows = await r.stores.changes.list(10);
  assert.equal(rows.length, 2, `明细一行 + 摘要一行，读出 ${rows.length} 行`);
  assert.equal(rows[0].kind, 'round', '会走的钟下摘要行不在第一 ⇒ 整轮读数会被保留上限挤到最旧那头');
  assert.equal(new Set(rows.map((x) => x.at)).size, 1, `这一轮的流水行时刻不唯一：${rows.map((x) => x.at)}`);
});

/* ================= C. diffCatalog 单元（歧义与上限只有手工构造才有） ================= */

check('认不出身份就判删+加：url 与名字都变了不猜', async () => {
  const diff = diffCatalog({
    prevRows: [row('Animals', [item({})])],
    nextItems: [nextOf({ slug: 'Animals::petapi', name: 'PetAPI', url: 'https://petapi.example/', desc: '完全不同的东西' })],
    at: NOW,
  });
  assert.equal(diff.stats.removed, 1);
  assert.equal(diff.stats.added, 1);
  assert.equal(diff.stats.changed, 0);
  assert.equal(diff.noteMigrations.length, 0);
  assert.equal(diff.ledger.filter((l) => l.kind === 'removed').length, 1);
});

check('url 桥有歧义就不配：两条旧记录共用同一地址 ⇒ 判删+加', async () => {
  const prevRows = [row('Animals', [
    item({ slug: 'Animals::a', name: 'A', url: 'https://same.example/' }),
    item({ slug: 'Animals::b', name: 'B', url: 'https://same.example/' }),
  ])];
  const diff = diffCatalog({ prevRows, nextItems: [nextOf({ slug: 'Animals::a', name: 'A', url: 'https://same.example/' })], at: NOW });
  assert.equal(diff.stats.same, 1, '同 slug 那条仍走桥 1');
  assert.equal(diff.stats.removed, 1);
  const diff2 = diffCatalog({
    prevRows,
    nextItems: [
      nextOf({ slug: 'Animals::c', name: 'C', url: 'https://same.example/' }),
      nextOf({ slug: 'Animals::d', name: 'D', url: 'https://same.example/' }),
    ],
    at: NOW,
  });
  assert.equal(diff2.stats.changed, 0, '两条同 url 的新条目不许被随便配到旧条目上');
  assert.equal(diff2.stats.added, 2);
  assert.equal(diff2.stats.removed, 2);
  // 新侧唯一、旧侧歧义是另一回事：桥只看新侧就会把新条目随便认到 prevList[0] 上，
  // 于是那条 API 的批注挂到了另一条 API 身上（这才是"不猜"要防的那件事）。
  const diff3 = diffCatalog({
    prevRows,
    nextItems: [nextOf({ slug: 'Animals::z', name: 'Z', url: 'https://same.example/' })],
    at: NOW,
  });
  assert.equal(diff3.stats.changed, 0, '旧侧有两条同地址 ⇒ 新那条不许被配到其中一条上');
  assert.equal(diff3.stats.added, 1);
  assert.equal(diff3.stats.removed, 2);
});

check('桥 3：同分类同名换了地址 ⇒ 判 changed，笔记不动键', async () => {
  const notes = new Map([['Animals::axolotl', { slug: 'Animals::axolotl', category: 'Animals', purpose: 'p', updatedAt: 1 }]]);
  const diff = diffCatalog({
    prevRows: [row('Animals', [item({ url: 'https://old.example/' })])],
    nextItems: [nextOf({ url: 'https://new.example/' })],
    notes, at: NOW,
  });
  assert.equal(diff.stats.changed, 1);
  assert.ok(diff.ledger[0].detail.includes('地址'), diff.ledger[0].detail);
  assert.equal(diff.noteMigrations.length, 0, '主键没变就不该搬家（搬了是把笔记删了再写一遍）');
});

check('改名换分类 ⇒ moved，且只有库里真有笔记才生成搬家', async () => {
  const prevRows = [row('Animals', [item({})])];
  const nextItems = [nextOf({ slug: 'Pets::axolotl', name: 'Axolotl API', category: 'Pets' })];
  const bare = diffCatalog({ prevRows, nextItems, at: NOW });
  assert.equal(bare.stats.moved, 1);
  assert.equal(bare.noteMigrations.length, 0, '没笔记也生成搬家流水 ⇒ 白排一次队');
  const notes = new Map([['Animals::axolotl', { slug: 'Animals::axolotl', category: 'Animals', purpose: 'p', updatedAt: 1 }]]);
  const withNote = diffCatalog({ prevRows, nextItems, notes, at: NOW });
  assert.deepEqual(withNote.noteMigrations, [{ fromSlug: 'Animals::axolotl', toSlug: 'Pets::axolotl', category: 'Pets' }]);
});

check('内容没变但主键变了（去重后缀收回去）也要登记并搬家', async () => {
  const prevRows = [row('Animals', [
    item({ slug: 'Animals::axolotl', name: 'Axolotl' }),
    item({ slug: 'Animals::axolotl#2', name: 'Axolotl', url: 'https://other.example/' }),
  ])];
  const nextItems = [nextOf({ slug: 'Animals::axolotl', name: 'Axolotl' })];
  const notes = new Map([['Animals::axolotl#2', { slug: 'Animals::axolotl#2', category: 'Animals', purpose: 'p', updatedAt: 1 }]]);
  const diff = diffCatalog({ prevRows, nextItems, notes, at: NOW });
  assert.equal(diff.stats.same, 1, '同 slug 那条走桥 1，内容一样就是 same');
  assert.equal(diff.stats.removed, 1);
  assert.equal(diff.noteOrphans.length, 1, '被删那条的笔记要转 orphan');
});

check('rowFingerprint 与行序无关，但任何一列变了就变', async () => {
  const a = [item({ slug: 'Animals::x', name: 'X' }), item({ slug: 'Animals::y', name: 'Y' })];
  const b = [a[1], a[0]];
  assert.equal(rowFingerprint(a), rowFingerprint(b));
  assert.notEqual(rowFingerprint(a), rowFingerprint([a[0], { ...a[1], desc: '改了用途' }]));
  assert.equal(rowFingerprint(a), rowFingerprint(a.map((i) => ({ ...i, lastSeenAt: i.lastSeenAt + 1000 }))), '时刻进了指纹 ⇒ 每轮全重写');
  assert.equal(rowFingerprint([]), '');
});

check('流水 detail 截到上限，超长句子不会把 schema 挡在写库前', async () => {
  const longName = '很'.repeat(300);
  // 七个可比字段一次全变：每段各带两个 40 字的截短值，句子本身就奔着 600 字去了 ——
  // 只改两列的话句子还在上限以内，"截断"这一条判据等于没测到（变异电池第一轮就漏在这）。
  const prevItem = item({
    name: longName, desc: 'x'.repeat(200), url: `https://old.example/${'a'.repeat(60)}`,
    auth: 'No', https: 'Yes', cors: 'Yes', host: 'old.example',
  });
  const diff = diffCatalog({
    prevRows: [row('Animals', [prevItem])],
    nextItems: [nextOf({
      slug: prevItem.slug, category: 'Animals',
      name: `${longName}改`, desc: 'y'.repeat(200), url: `https://new.example/${'b'.repeat(60)}`,
      auth: 'apiKey', https: 'No', cors: 'No', host: 'new.example',
    })],
    at: NOW,
  });
  const detail = diff.ledger[0].detail;
  assert.ok(detail.length <= CHANGE_DETAIL_MAX_LEN, `detail ${detail.length} 字，超上限`);
  assert.ok(detail.endsWith('…'), '截断要留下截断的痕迹');
});

check('baseline 只影响流水，不影响该写的行与计数', async () => {
  const rows = rowsFrom(parsed.entries);
  const diff = diffCatalog({ prevRows: rows, nextItems: parsed.entries, at: NOW, baseline: true });
  assert.equal(diff.ledger.length, 0);
  assert.equal(diff.stats.same, 2019, '基线位不该把差分本身关掉');
  assert.equal(diff.rowsToWrite.length, 0);
  const fresh = diffCatalog({ prevRows: [], nextItems: parsed.entries, at: NOW, baseline: true });
  assert.equal(fresh.rowsToWrite.length, 51);
  assert.equal(fresh.ledger.length, 0);
  assert.equal(fresh.counts.reduce((s, c) => s + c.count, 0), 2019);
});

check('差分落库的条目不带 line/categoryLine/authRaw，且键合规', async () => {
  const r = rig();
  await r.sync.run();
  const rows = await r.stores.entries.readAll();
  const all = rows.flatMap((row2) => row2.items);
  assert.equal(all.length, 2019);
  for (const i of all.slice(0, 5)) assert.equal('line' in i || 'authRaw' in i || 'categoryLine' in i, false);
  const keys = rows.map((x) => x.category);
  assert.equal(new Set(keys).size, 51);
  assert.ok(Math.max(...all.map((i) => i.firstSeenAt)) <= NOW);
});

check('firstSeenAt 继承老值，lastSeenAt 每轮推到当下', async () => {
  const r = rig();
  await r.sync.run();
  const animals = await r.stores.entries.read('Animals');
  assert.ok(animals.items.every((i) => i.firstSeenAt === NOW && i.lastSeenAt === NOW));
  const lines = README.split('\n');
  const cells = lines[parsed.entries[0].line - 1].split('|');
  cells[4] = ' apiKey ';
  lines[parsed.entries[0].line - 1] = cells.join('|');
  r.setBody(lines.join('\n'));
  const late = createSync({
    stores: r.stores,
    fetchImpl: r.fetchImpl,
    logger: makeLogger(),
    now: () => NOW + 60_000,
  });
  await late.run();
  const after = await r.stores.entries.read('Animals');
  const axolotl = after.items.find((i) => i.slug === parsed.entries[0].slug);
  assert.equal(axolotl.firstSeenAt, NOW, '改了内容就把首次见到时间抹了，界面"新收录"的排序会乱');
  assert.equal(axolotl.lastSeenAt, NOW + 60_000);
});

/* ================= D. 节拍 ================= */

check('nextDelayMs：档位倍率、非档位回落默认', async () => {
  assert.equal(nextDelayMs({ intervalMin: 60 }, { backoff: 0 }), 3600_000);
  assert.equal(nextDelayMs({ intervalMin: 1440 }, { backoff: 2 }), 1440 * 60_000 * 4);
  assert.equal(nextDelayMs({ intervalMin: 7 }, { backoff: 0 }), DEFAULT_PREFS.intervalMin * 60_000);
  assert.equal(nextDelayMs(null, null), DEFAULT_PREFS.intervalMin * 60_000);
  assert.equal(nextDelayMs({ intervalMin: 60 }, { backoff: 99 }), 3600_000 * BACKOFF_STEPS[BACKOFF_STEPS.length - 1]);
  assert.equal(nextDelayMs({ intervalMin: 60 }, { backoff: -3 }), 3600_000);
  assert.equal(CHECK_INTERVALS.includes(DEFAULT_PREFS.intervalMin), true);
});

check('nextBackoff 只看档位，不看失败次数', async () => {
  assert.equal(nextBackoff(null), 1);
  assert.equal(nextBackoff({ backoff: 2 }), 3);
  assert.equal(nextBackoff({ backoff: 3 }), 3);
  assert.equal(nextBackoff({ backoff: 'x' }), 1);
});

check('下一轮的等待只由本轮结果给出：sync 不再另开一个问节拍的口子', async () => {
  // 装配层用 round() 返回的 nextDelayMs；另开一个 schedule() 就是第二个真相（而且它拿 meta 当 {backoff} 传，必然算错）。
  const r = rig();
  const res = await r.sync.run();
  assert.equal(Number.isFinite(res.nextDelayMs), true);
  await r.stores.prefs.patch({ intervalMin: 60 });
  const res2 = await r.sync.run();
  assert.equal(res2.nextDelayMs, 3600_000);
  assert.equal('schedule' in r.sync, false, '节拍只有一个出处：一轮跑完结果里那一个');
});

runAll('sync');
