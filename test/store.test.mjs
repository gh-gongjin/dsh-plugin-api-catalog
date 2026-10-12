/**
 * test/store.test.mjs —— 七表仓储（lib/stores.js）+ per-record 落盘形状。
 *
 * 判据取向：这里不看"能不能读回来"这一遍流水（那是 keys/parse 的事），
 * 只看 per-record 带来的新风险：
 *   1. 一个域七张表 ⇒ 登记表只 open 一次、最后一个持有者放手才真关；
 *   2. 切行是真的切了（51 分类 = 51 个键），一轮写只碰变化的那些；
 *   3. 键是编码出来的，不是原样 slug；
 *   4. 搬家与孤儿笔记不许吃掉用户资产（migrate 同键不删、orphan 不跟删）；
 *   5. 流水同毫秒不覆盖（一轮加 30 条不会正好错开毫秒）；
 *   6. ★ S8 的两张新表（E3）：trans 的键是**原文**的哈希（换空白不摊新行），失败行也在表里但进不了 zhMap；
 *      secrets 是宿主专用表 —— 值原样存（不 trim）、任何读方法都只回摘要，所以它的判据是"值出不了这扇门"，
 *      而不是"读得到值"。这一张表的值一旦出现在快照里就是出网，这里先钉死。
 * 假设施把宿主的 per-record 键闸门重现了（见 _helpers.mjs），所以编码层回归会在这里当场炸。
 */
import { check, runAll, assert, makeFakeFacility, fixture } from './_helpers.mjs';
import { parseCatalog } from '../lib/parse.js';
import {
  TABLES, AC_DOMAIN, DOMAIN_NAME, META_KEY, PREFS_KEY, DEFAULT_PREFS,
  CHECK_INTERVALS, SOURCES, RECORD_KEY_RE, ENTRY_ROW_VERSION, NOTE_PURPOSE_MAX_LEN,
  CHANGE_ROW_KINDS, KEEP_CHANGES, TRANS_CRED_FIELDS, TRANS_CRED_MAX, TRANS_OUT_MAX, DEFAULT_TRANS_CHANNEL,
} from '../lib/domain.js';
import { categoryKey, noteKey, transKey, secretKey, KEY_RULE_VERSION } from '../lib/keys.js';
import {
  createAllStores, createEntriesStore, createMetaStore, createNotesStore,
  createPrefsStore, createChangesStore, RECORDS_ERROR,
} from '../lib/stores.js';

const README = await fixture('public-apis-README.md');
const { entries, report } = parseCatalog(README);
const NOW = 1777000000000;

const itemOf = (e, now = NOW) => ({ ...e, firstSeenAt: now, lastSeenAt: now });
const cats = [...new Set(entries.map((e) => e.category))];

function storesWith(facility) {
  return createAllStores({ getFacility: () => facility, logger: { warn: () => {}, info: () => {}, error: () => {} } });
}

/* trans / secrets 两张表的夹具（A 段就要用，所以放在最上面）。 */
const SENT = 'Weather alerts and radar imagery for Europe.';
const APPID = '20250101000000001';
const KEY = 'super-secret-key-9f3a';
const OK_ROW = (src = SENT, zh = '欧洲的天气预报与雷达图。') => ({
  src, zh, at: NOW, chars: zh.length, channel: 'baidu', ok: true, errText: undefined,
});
const FAIL_ROW = (src = SENT) => ({
  src, zh: undefined, at: NOW, chars: 0, channel: 'baidu', ok: false, errText: '54001 无效的请求参数',
});
/** 从登记表派生全部凭据字段（不手抄：加一个渠道或字段，这几条判据自己就覆盖到）。 */
const CRED_FIELDS = Object.entries(TRANS_CRED_FIELDS).flatMap(([channel, fields]) =>
  fields.map((spec) => ({ channel, field: spec.id, spec })));

/* ---------------- A. 域登记表 ---------------- */

check('七表共用一个域：各写一行只 open 一次', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.entries.write({ category: 'Animals', items: [], updatedAt: NOW });
  await s.meta.patch({ keyRule: KEY_RULE_VERSION });
  await s.notes.write({ slug: 'Animals::x', category: 'Animals', updatedAt: NOW });
  await s.prefs.patch({});
  await s.changes.append({ at: NOW, kind: 'added', slug: 'Animals::x' });
  await s.trans.put(OK_ROW());
  await s.secrets.write({ channel: 'baidu', field: 'appid', value: APPID, at: NOW });
  assert.equal(f.calls.open, 1, `域被 open 了 ${f.calls.open} 次，登记表没生效`);
  await s.closeAll();
});

check('close 只减引用：还有人用就不许真关域', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.entries.write({ category: 'Animals', items: [], updatedAt: NOW });
  await s.meta.patch({ keyRule: KEY_RULE_VERSION });
  await s.entries.close();
  assert.equal(f.calls.close, 0, '还有一个仓储在用就把域关了');
  // 剩下的仓储照样能用
  await s.meta.patch({ backoff: 0 });
  assert.equal(f.calls.open, 1);
  await s.closeAll();
  assert.equal(f.calls.close, 1);
});

check('全关之后能重开：登记表摘牌了才不会撞 already-open', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.entries.write({ category: 'Animals', items: [], updatedAt: NOW });
  await s.closeAll();
  const again = storesWith(f);
  await again.entries.write({ category: 'Anime', items: [], updatedAt: NOW });
  assert.equal(f.calls.open, 2);
  await again.closeAll();
});

check('没有 ctx.storageDomain：写是 rejected promise（同步 throw 会打挂宿主）', async () => {
  const s = createEntriesStore({ getFacility: () => undefined });
  let syncThrew = false;
  let p;
  try {
    p = s.write({ category: 'Animals', items: [], updatedAt: NOW });
  } catch {
    syncThrew = true;
  }
  assert.equal(syncThrew, false, '宿主半边都在定时器回调里 await，这里同步 throw 就是崩宿主');
  const e = await p.then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.UNAVAILABLE);
  assert.equal(s.available, false, '无设施时 available 位必须是 false（界面靠它说"存不了"）');
});

check('仓储关闭后再写报 CLOSED，不是 UNAVAILABLE', async () => {
  const f = makeFakeFacility();
  const s = createMetaStore({ getFacility: () => f });
  await s.patch({ keyRule: KEY_RULE_VERSION });
  await s.close();
  const e = await s.patch({ backoff: 1 }).then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.CLOSED);
});

/* ---------------- B. entries：按分类切行 ---------------- */

check('真 README 全量落库：51 个分类 = 51 行（切行是真的切了）', async () => {
  const f = makeFakeFacility();
  const s = createEntriesStore({ getFacility: () => f });
  const rows = cats.map((category) => ({
    category,
    updatedAt: NOW,
    items: entries.filter((e) => e.category === category).map((e) => itemOf(e)),
  }));
  const keys = await s.writeMany(rows);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.entries), 51);
  assert.equal(new Set(keys).size, 51);
  const flat = await s.readAllItems();
  assert.equal(flat.length, 2019);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.entries), 51, '摊平读不许顺手把行数变成 2019');
  await s.close();
});

check('行里不落 line / categoryLine / authRaw（解析现场的坐标不是快照的一部分）', async () => {
  const f = makeFakeFacility();
  const s = createEntriesStore({ getFacility: () => f });
  const raw = entries.find((e) => e.line !== undefined && e.categoryLine !== undefined);
  await s.write({ category: raw.category, items: [itemOf(raw)], updatedAt: NOW });
  const row = await s.read(raw.category);
  assert.deepEqual(Object.keys(row.items[0]).sort(),
    ['auth', 'category', 'cors', 'desc', 'firstSeenAt', 'host', 'https', 'lastSeenAt', 'name', 'slug', 'url'].sort());
  assert.equal(row.rowVersion, ENTRY_ROW_VERSION);
  await s.close();
});

check('键是编码不是原名：带空格的分类在库里是个合规键', async () => {
  const f = makeFakeFacility();
  const s = createEntriesStore({ getFacility: () => f });
  await s.write({ category: 'Art & Design', items: [], updatedAt: NOW });
  const stored = f.rawRow(DOMAIN_NAME, TABLES.entries, categoryKey('Art & Design'));
  assert.ok(stored, '按编码键读不到刚写的行');
  assert.match(categoryKey('Art & Design'), RECORD_KEY_RE);
  assert.notEqual(categoryKey('Art & Design'), 'Art & Design');
  assert.equal(stored.category, 'Art & Design', '行里存的还是原名（键只是文件名）');
  await s.close();
});

check('一轮写只碰变化的分类：put 次数等于行数不是条目数', async () => {
  const f = makeFakeFacility();
  const s = createEntriesStore({ getFacility: () => f });
  const before = f.calls.puts;
  await s.writeMany([
    { category: 'Animals', updatedAt: NOW, items: entries.filter((e) => e.category === 'Animals').map((e) => itemOf(e)) },
    { category: 'Anime', updatedAt: NOW, items: [] },
  ]);
  assert.equal(f.calls.puts - before, 2, '两个分类写了 ' + (f.calls.puts - before) + ' 次');
  await s.close();
});

check('脏条目挡在 put 之前，原行不被半份覆盖', async () => {
  const f = makeFakeFacility();
  const s = createEntriesStore({ getFacility: () => f });
  await s.write({ category: 'Animals', items: [itemOf(entries.find((e) => e.category === 'Animals'))], updatedAt: NOW });
  const rowsBefore = f.rowCount(DOMAIN_NAME, TABLES.entries);
  const dirty = { ...itemOf(entries[0]), name: undefined };
  const e = await s.write({ category: 'Animals', items: [dirty], updatedAt: NOW + 1 }).then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.INVALID);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.entries), rowsBefore);
  const row = await s.read('Animals');
  assert.equal(row.updatedAt, NOW, '被拒的写把原行的 updatedAt 抹了');
  await s.close();
});

check('空 items 允许落库（这一类被清空的中间态不是错误）', async () => {
  const f = makeFakeFacility();
  const s = createEntriesStore({ getFacility: () => f });
  const row = await s.write({ category: 'Calendar', items: [], updatedAt: NOW });
  assert.deepEqual(row.items, []);
  assert.equal((await s.readAllItems()).length, 0);
  await s.close();
});

check('没写过的分类读回来是 null，不是空行', async () => {
  const f = makeFakeFacility();
  const s = createEntriesStore({ getFacility: () => f });
  assert.equal(await s.read('Never Written'), null);
  await s.close();
});

/* ---------------- C. meta ---------------- */

check('meta 是读-并-写：后一次 patch 不许抹掉前一次的键', async () => {
  const f = makeFakeFacility();
  const s = createMetaStore({ getFacility: () => f });
  await s.patch({ keyRule: KEY_RULE_VERSION, sha: 'deadbeef' });
  await s.patch({ backoff: 2 });
  const row = await s.read();
  assert.equal(row.sha, 'deadbeef');
  assert.equal(row.backoff, 2);
  assert.equal(row.keyRule, KEY_RULE_VERSION);
  await s.close();
});

check('meta patch 空对象 / undefined 都不炸，原行原样在', async () => {
  const f = makeFakeFacility();
  const s = createMetaStore({ getFacility: () => f });
  await s.patch({ keyRule: KEY_RULE_VERSION, total: 2019 });
  await s.patch(undefined);
  const row = await s.read();
  assert.equal(row.total, 2019);
  await s.close();
});

check('keyRule 是必填：缺它就不许落库（键规则对不上必须显式处理）', async () => {
  const f = makeFakeFacility();
  const s = createMetaStore({ getFacility: () => f });
  const e = await s.patch({ sha: 'x' }).then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.INVALID);
  assert.equal(await s.read(), null);
  await s.close();
});

check('lastError 成功轮不自动清空（界面要能回答“上次为什么失败”）', async () => {
  const f = makeFakeFacility();
  const s = createMetaStore({ getFacility: () => f });
  await s.patch({ keyRule: KEY_RULE_VERSION, lastError: 'jsDelivr 超时', lastErrorCode: 'timeout' });
  const after = await s.patch({ keyRule: KEY_RULE_VERSION, fetchedAt: NOW });
  assert.equal(after.lastError, 'jsDelivr 超时');
  await s.close();
});

/* ---------------- D. notes ---------------- */

check('批注按 slug 读写：库里的键是编码过的，行里存的还是原 slug', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  const slug = 'Art & Design::colors';
  await s.write({ slug, category: 'Art & Design', purpose: '调色板', tags: ['设计'], starred: true, updatedAt: NOW });
  const key = noteKey(slug);
  assert.match(key, RECORD_KEY_RE);
  assert.notEqual(key, slug);
  assert.ok(f.rawRow(DOMAIN_NAME, TABLES.notes, key));
  const back = await s.read(slug);
  assert.equal(back.purpose, '调色板');
  assert.deepEqual(back.tags, ['设计']);
  assert.equal(back.starred, true);
  await s.close();
});

check('批注行带 name 快照：写得进读得回；没这个键的旧行照样过 schema（加字段不升键规则）', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  await s.write({
    slug: 'Animals::breedhealthscore', category: 'Animals',
    name: 'Breed Health Score', purpose: '留着', updatedAt: NOW,
  });
  assert.equal((await s.read('Animals::breedhealthscore')).name, 'Breed Health Score');
  // ★ 旧库形状（S6 之前落的那些行）没有 name 键：optionalString 对"没填"是给 undefined、
  //   record() 再丢掉 undefined ⇒ 读回来不该凭空多一个空 name，也不该被判成脏行。
  await s.write({ slug: 'A::one', category: 'A', purpose: '旧', updatedAt: NOW });
  const back = await s.read('A::one');
  assert.equal(back.purpose, '旧');
  assert.equal('name' in back, false, '没写过的可选字段被补成空串，界面就分不清"上游本来没名字"和"旧行没这个字段"');
  await s.close();
});

check('readAll 用 slug 索引（不是编码键），界面拿得到原主键', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  await s.write({ slug: 'A::one', category: 'A', updatedAt: NOW });
  await s.write({ slug: 'B::two::zz', category: 'B', updatedAt: NOW });
  const all = await s.readAll();
  assert.equal(all.size, 2);
  assert.deepEqual([...all.keys()].sort(), ['A::one', 'B::two::zz']);
  await s.close();
});

check('上游删条目：批注转 orphan 不跟着删；重新出现接回', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  await s.write({ slug: 'X::gone', category: 'X', purpose: '留着', updatedAt: NOW });
  const orph = await s.setOrphan('X::gone', true);
  assert.equal(orph.orphan, true);
  assert.equal((await s.read('X::gone')).purpose, '留着');
  await s.setOrphan('X::gone', false);
  assert.equal((await s.read('X::gone')).orphan, false);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.notes), 1);
  await s.close();
});

check('给不存在的批注设 orphan：回 null，不凭空建一行', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  assert.equal(await s.setOrphan('Nope::nothing', true), null);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.notes), 0);
  await s.close();
});

check('搬家（上游改分类名 ⇒ slug 变）：笔记跟着走，旧键删干净', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  await s.write({ slug: 'Books::abc', category: 'Books', purpose: '书签', updatedAt: NOW });
  const moved = await s.migrate({ fromSlug: 'Books::abc', toSlug: 'Books & Magazines::abc', category: 'Books & Magazines' });
  assert.equal(moved.slug, 'Books & Magazines::abc');
  assert.equal(moved.purpose, '书签');
  assert.ok(f.rawRow(DOMAIN_NAME, TABLES.notes, noteKey('Books & Magazines::abc')));
  assert.equal(f.rawRow(DOMAIN_NAME, TABLES.notes, noteKey('Books::abc')), undefined, '旧键没删，笔记会翻倍');
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.notes), 1);
  await s.close();
});

check('两条 slug 撞进同一个键：就地改，不许先 put 后 delete 把自己删了', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  await s.write({ slug: 'Books::abc', category: 'Books', purpose: '书签', updatedAt: NOW });
  const moved = await s.migrate({ fromSlug: 'Books::abc', toSlug: 'Books::abc', category: 'Books' });
  assert.equal(moved.purpose, '书签');
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.notes), 1);
  assert.equal((await s.read('Books::abc')).purpose, '书签', '同键搬家把用户的批注删了');
  await s.close();
});

check('没有旧批注时搬家返回 null，且不产生新行', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  assert.equal(await s.migrate({ fromSlug: 'A::x', toSlug: 'B::x', category: 'B' }), null);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.notes), 0);
  await s.close();
});

check('purpose 超长是报错不是截断（用户写的东西不许悄悄改半句）', async () => {
  const f = makeFakeFacility();
  const s = createNotesStore({ getFacility: () => f });
  await s.write({ slug: 'A::ok', category: 'A', purpose: '好的', updatedAt: NOW });
  const before = f.rawRow(DOMAIN_NAME, TABLES.notes, noteKey('A::ok'));
  const e = await s.write({ slug: 'A::long', category: 'A', purpose: 'x'.repeat(NOTE_PURPOSE_MAX_LEN + 1), updatedAt: NOW })
    .then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.INVALID);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.notes), 1, '超长的那条没进去，库里还只有原来那一行');
  assert.deepEqual(f.rawRow(DOMAIN_NAME, TABLES.notes, noteKey('A::ok')), before);
  await s.close();
});

/* ---------------- E. prefs ---------------- */

check('出厂默认能整份往返（没有"存不进默认值"的字段）', async () => {
  const f = makeFakeFacility();
  const s = createPrefsStore({ getFacility: () => f });
  const saved = await s.patch({ ...DEFAULT_PREFS });
  assert.equal(saved.intervalMin, DEFAULT_PREFS.intervalMin);
  const back = await s.read();
  assert.deepEqual(back, DEFAULT_PREFS);
  assert.deepEqual(back.sourcePriority, SOURCES.map((x) => x.id));
  await s.close();
});

check('间隔不在档位里回落默认（库里存的必须是档位）', async () => {
  const warns = [];
  const f = makeFakeFacility();
  const s = createPrefsStore({ getFacility: () => f, logger: { warn: (m) => warns.push(m) } });
  const p = await s.patch({ intervalMin: 7 });
  assert.equal(p.intervalMin, DEFAULT_PREFS.intervalMin);
  assert.ok(CHECK_INTERVALS.includes(p.intervalMin));
  assert.equal(warns.length, 1, '库里存的值被改掉必须留话，不能静默回落');
  assert.match(warns[0], /\[api-catalog\]/);
  assert.equal((await s.patch({ intervalMin: 60 })).intervalMin, 60);
  await s.close();
});

check('源优先级：未知 id 丢弃，没排进去的源补在末尾 ⇒ 每轮都会把所有源试一遍', async () => {
  const f = makeFakeFacility();
  const s = createPrefsStore({ getFacility: () => f });
  const ids = SOURCES.map((x) => x.id);
  const p = await s.patch({ sourcePriority: [ids[1], 'made-up', ids[1]] });
  // 期望从登记表算：把 ids[1] 提到最前，其余照登记顺序补在末尾（源加到五档也不用回来改这条）。
  assert.deepEqual(p.sourcePriority, [ids[1], ...ids.filter((id) => id !== ids[1])]);
  assert.equal(new Set(p.sourcePriority).size, ids.length);
  await s.close();
});

check('库里的脏 prefs 行：读出来钳成可用值（宽容读不崩）', async () => {
  const f = makeFakeFacility();
  const s = createPrefsStore({ getFacility: () => f });
  await s.read();
  // 代理两格（S16）现在**是** prefs 的键了 —— 旧那句「prefs 里没有代理开关」随 CONNECT 隧道一起作废。
  // 但这两格的钳法与渠道那一格同一条律：没登记的模式回落，带密码的地址整格洗空（prefs 整份推给浏览器）。
  f.seed(DOMAIN_NAME, TABLES.prefs, PREFS_KEY, {
    intervalMin: 'abc', sourcePriority: 'jsdelivr',
    proxyMode: 'socks', proxyUrl: 'http://user:pw@127.0.0.1:7897',
    baiduKey: '不该出现的凭据', transChannel: 'no-such-channel',
  });
  const p = await s.read();
  assert.equal(p.intervalMin, DEFAULT_PREFS.intervalMin);
  assert.deepEqual(p.sourcePriority, SOURCES.map((x) => x.id));
  assert.equal(p.proxyMode, DEFAULT_PREFS.proxyMode, '没登记的代理模式被带进运行时了（它决定这一发从哪条路出去）');
  assert.equal(p.proxyUrl, '', '带 user:pass@ 的代理地址没被洗掉：它跟着 prefs 整份出到浏览器');
  assert.equal('baiduKey' in p, false, '没声明过的键穿过了 clampPrefs：凭据只要进过一次 prefs 就必然跟着首屏出去');
  assert.equal(p.transChannel, DEFAULT_TRANS_CHANNEL, '没登记的渠道被带进运行时了');
  // 干净值原样过（钳制不是"一律回落"：那样用户改的代理档位永远存不住）
  f.seed(DOMAIN_NAME, TABLES.prefs, PREFS_KEY, { intervalMin: 60, proxyMode: 'custom', proxyUrl: ' 127.0.0.1:7897 ' });
  const q = await s.read();
  assert.equal(q.proxyMode, 'custom');
  assert.equal(q.proxyUrl, '127.0.0.1:7897', '代理地址没 trim：带空格的去解析就成了"地址不合法"');
  await s.close();
});

check('strict 读把“域不可用”如实抛给装配层，宽容读回默认值', async () => {
  const strictStore = createPrefsStore({ getFacility: () => undefined });
  const e = await strictStore.read({ strict: true }).then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.UNAVAILABLE);
  const lenient = await strictStore.read();
  assert.equal(lenient.intervalMin, DEFAULT_PREFS.intervalMin);
});

check('open 失败（设施在但域打不开）：available 位与 strict 读都要指出来', async () => {
  const broken = { open: async () => { throw new Error('backend 起不来'); }, calls: { open: 0, close: 0 } };
  const s = createPrefsStore({ getFacility: () => broken });
  assert.equal(s.available, true, '有 open 方法就该报“设施在位”，失败是 open 那一刻的事');
  const e = await s.read({ strict: true }).then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.UNAVAILABLE);
  assert.match(e.message, /backend 起不来/);
  assert.equal((await s.read()).intervalMin, DEFAULT_PREFS.intervalMin);
});

/* ---------------- E2. changes：追加式流水 ---------------- */

check('同毫秒连写不覆盖：id 带序号，三行都在', async () => {
  const f = makeFakeFacility();
  const s = createChangesStore({ getFacility: () => f });
  const rows = await s.appendMany([
    { at: NOW, kind: 'added', slug: 'A::one' },
    { at: NOW, kind: 'added', slug: 'A::two' },
    { at: NOW, kind: 'removed', slug: 'A::three' },
  ]);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3, '同毫秒的三行撞了同一个 id');
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.changes), 3);
  const listed = await s.list(10);
  assert.equal(listed.length, 3);
  await s.close();
});

check('源故障那一行没有 slug 也进得去（不许被 optionalString 顶成 INVALID）', async () => {
  const f = makeFakeFacility();
  const s = createChangesStore({ getFacility: () => f });
  const row = await s.append({ at: NOW, kind: 'source_error', detail: '三个源都没拿到正文' });
  assert.equal(row.kind, 'source_error');
  assert.equal('slug' in row, false, '空串该归一成没有这个键，不然界面要显示空主键');
  assert.equal('category' in row, false);
  await s.close();
});

check('越界 kind 挡在 put 之前（流水种类只认表里那几个）', async () => {
  const f = makeFakeFacility();
  const s = createChangesStore({ getFacility: () => f });
  const e = await s.append({ at: NOW, kind: 'renamed', slug: 'A::x' }).then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.INVALID);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.changes), 0);
  assert.ok(CHANGE_ROW_KINDS.includes('source_error'));
  await s.close();
});

check('list 倒序 + 按 kind 筛 + limit 钳在 [1,500]', async () => {
  const f = makeFakeFacility();
  const s = createChangesStore({ getFacility: () => f });
  await s.appendMany([
    { at: NOW, kind: 'added', slug: 'A::one' },
    { at: NOW + 1, kind: 'removed', slug: 'A::two' },
    { at: NOW + 2, kind: 'added', slug: 'A::three' },
  ]);
  const all = await s.list(10);
  assert.deepEqual(all.map((r) => r.at), [NOW + 2, NOW + 1, NOW]);
  assert.equal((await s.list(10, 'added')).length, 2);
  assert.equal((await s.list(0)).length, 3, 'limit 0 该回落默认而不是返回空');
  assert.equal((await s.list(99999)).length, 3);
  assert.equal((await s.list('abc')).length, 3);
  await s.close();
});

check('trim 只砍最旧的，keep 非法就不动', async () => {
  const f = makeFakeFacility();
  const s = createChangesStore({ getFacility: () => f });
  await s.appendMany([0, 1, 2, 3, 4].map((i) => ({ at: NOW + i, kind: 'added', slug: `A::n${i}` })));
  assert.equal(await s.trim(3), 2);
  assert.deepEqual((await s.list(10)).map((r) => r.at), [NOW + 4, NOW + 3, NOW + 2]);
  assert.equal(await s.trim(0), 0);
  assert.equal(await s.trim(undefined), 0);
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.changes), 3);
  assert.equal(KEEP_CHANGES, 200);
  await s.close();
});

/* ---------------- E3. trans 与 secrets（S8 新增的两张表） ---------------- */

check('trans 的键是原文的哈希：换空白不摊新行，改一个字就是另一行', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.trans.put(OK_ROW(SENT));
  // 同一句、空白不同：库里必须还是那一行（命中判据是"折叠空白后逐字相同"，与内置表同一条口径）
  await s.trans.put(OK_ROW(`  ${SENT.replace(/ /g, '  ')}  `));
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.trans), 1, '归一化没收在键这一层 ⇒ 同一句在库里摊了两行');
  const got = await s.trans.read(SENT);
  assert.equal(got.src, SENT, '行里存的必须是归一化后的原文，不是调用方传的那一份');
  const pad = await s.trans.read(`  ${SENT}  `);
  assert.deepEqual(pad, got, '按原文取行也得走同一个键：调用方传什么空白都一样');
  await s.trans.put(OK_ROW('Weather alerts and radar imagery for Asia.'));
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.trans), 2, '换了个词就是另一句，不许覆盖上一行');
  // 键的形状：前缀 + 哈希，既过宿主的 per-record 闸门，也看得出是编码而不是原文
  const key = transKey(SENT);
  assert.match(key, /^t-[0-9a-z]+$/u, `trans 键的形状漂了：${key}`);
  assert.ok(RECORD_KEY_RE.test(key), 'trans 键过不了宿主的键闸门，真机上是在 put 那一发才炸');
  await s.closeAll();
});

check('trans 行 schema 闸门：渠道越界 / ok 不是布尔 / 缺时刻都报错，且不动库里那一行', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.trans.put(OK_ROW());
  const before = f.rawRow(DOMAIN_NAME, TABLES.trans, transKey(SENT));
  const bad = [
    { ...OK_ROW(), channel: 'google' },
    { ...OK_ROW(), ok: 'yes' },
    { ...OK_ROW(), at: undefined },
    { ...OK_ROW(), zh: '汉'.repeat(TRANS_OUT_MAX + 1) },
    { ...FAIL_ROW(), channel: '' },
  ];
  for (const row of bad) {
    const e = await s.trans.put(row).then(() => null, (err) => err);
    assert.ok(e, `这一行该被闸门挡下：${JSON.stringify({ channel: row.channel, ok: row.ok, at: row.at })}`);
    assert.equal(e.code, RECORDS_ERROR.INVALID, `挡下的理由不该是别的东西：${e?.code}`);
  }
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.trans), 1);
  assert.deepEqual(f.rawRow(DOMAIN_NAME, TABLES.trans, transKey(SENT)), before, '被拒的那一发把原行改写了一半');
  await s.closeAll();
});

check('zhMap 只认真译成的行：失败行与"顶着中文标签的英文"都进不了读侧', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.trans.put(OK_ROW(SENT, '欧洲的天气预报与雷达图。'));
  await s.trans.put(FAIL_ROW('Failed sentence for the map.'));
  // 脏行只有绕过 put 才进得来（模拟别的版本写下的"译文就是英文原文"）
  f.seed(DOMAIN_NAME, TABLES.trans, transKey('Legacy English Row.'), {
    src: 'Legacy English Row.', zh: 'Legacy English Row.', at: NOW, chars: 19, channel: 'host_llm', ok: true,
  });
  const map = await s.trans.zhMap();
  assert.equal(map.size, 1, `读侧映射收了不该收的行：${[...map.keys()].join(' / ')}`);
  assert.equal(map.get(SENT).zh, '欧洲的天气预报与雷达图。');
  assert.equal(map.get(SENT).channel, 'baidu', '落款要的渠道得从行里取，不是当前偏好');
  assert.equal(map.has('Legacy English Row.'), false, 'ok:true 但没有汉字 = 界面会给英文原文挂个中文标签');
  const counts = await s.trans.counts();
  assert.deepEqual(counts, { rows: 3, ok: 2, failed: 1 },
    '设置页那句「已存 N 条 · 失败 M 条」数的就是这个；把失败行算进 rows 就报不出还剩几句');
  await s.closeAll();
});

check('putMany 走的是与 put 同一条键规则；坏行在批里也报 INVALID，且不落半份', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  const rows = [
    OK_ROW('First sentence.', '第一句。'),
    OK_ROW('Second sentence.', '第二句。'),
    OK_ROW('Third sentence.', '第三句。'),
  ];
  const keys = await s.trans.putMany(rows);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, rows.map((r) => transKey(r.src)), '批量写的键与单条写不是同一条编码');
  for (const r of rows) {
    const back = await s.trans.read(r.src);
    assert.equal(back.zh, r.zh, `${r.src} 批量写进去了但读不回来`);
  }
  const e = await s.trans.putMany([OK_ROW('Fourth.', '第四句。'), { ...OK_ROW('Fifth.'), channel: 'deepl' }])
    .then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.INVALID);
  assert.equal(f.rawRow(DOMAIN_NAME, TABLES.trans, transKey('Fifth.')), undefined, '坏行被挡下了却还是在库里留了半份');
  await s.closeAll();
});

check('secrets：只有登记过的 渠道+字段 能写；脏组合一律 rejected promise（不同步 throw）', async () => {
  assert.ok(CRED_FIELDS.length >= 10, `派生出来的凭据字段清单只有 ${CRED_FIELDS.length} 项 ⇒ 登记表漂了或这段判据等于没扫`);
  const f = makeFakeFacility();
  const s = storesWith(f);
  const dirty = [
    { channel: 'google', field: 'key' },
    { channel: '', field: 'key' },
    { channel: 'baidu', field: 'token' },
    { channel: 'baidu', field: '' },
    { channel: 'BAIDU', field: 'appid' },
    { channel: 'host_llm', field: 'key' },
  ];
  for (const d of dirty) {
    // read / write / remove 三条口子都必须走 rejected：调用侧都在 await，同步 throw 会从栈里漏出去
    for (const [name, call] of [['write', () => s.secrets.write({ ...d, value: 'x', at: NOW })],
      ['read', () => s.secrets.read(d.channel, d.field)],
      ['remove', () => s.secrets.remove(d.channel, d.field)]]) {
      let syncThrew = null;
      let p;
      try { p = call(); } catch (e) { syncThrew = e; }
      assert.equal(syncThrew, null, `secrets.${name} 对脏组合同步 throw 了：${syncThrew?.message}`);
      const e = await p.then(() => null, (err) => err);
      assert.equal(e?.code, RECORDS_ERROR.INVALID, `secrets.${name} 没把脏组合当参数错：${e?.code}`);
    }
  }
  // 域压根没被打开过（-1 = 域不在登记表里）：脏组合挡在写侧最外层，连设施都不该去碰
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.secrets), -1, '脏组合一路走到了开域那一步');
  assert.equal(f.calls.puts, 0, '被拒的凭据在库里留了行');
  await s.closeAll();
});

check('secrets 存的是原样：值不 trim 不折叠（规范化一把钥匙等于换了把钥匙还自称存原样）', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  const value = '  aB_ 9f3a  ';
  await s.secrets.write({ channel: 'baidu', field: 'key', value, at: NOW });
  const raw = f.rawRow(DOMAIN_NAME, TABLES.secrets, secretKey('baidu', 'key'));
  assert.equal(raw.value, value, '落库的值被修剪过了：下次签名用的就不是用户填的那一把');
  assert.equal(raw.chars, value.length, '位数按修剪后的串算，界面上那个"N 位"就是假读数');
  const back = await s.secrets.read('baidu', 'key');
  assert.equal(back.value, value);
  // 键是人能看懂的那一种（这些文件用户会翻），同时仍过宿主闸门
  assert.equal(secretKey('baidu', 'key'), 'sec-baidu_key');
  assert.ok(RECORD_KEY_RE.test(secretKey('tencent', 'secret_id')));
  await s.closeAll();
});

check('secrets 的长度闸门取「字段上限」与「总上限」里更小的那个：逐字段边界各试一次', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  for (const { channel, field, spec } of CRED_FIELDS) {
    const max = Math.min(Number(spec.max) || TRANS_CRED_MAX, TRANS_CRED_MAX);
    const ok = await s.secrets.write({ channel, field, value: 'k'.repeat(max), at: NOW });
    assert.deepEqual(ok, { channel, field, configured: true, chars: max, at: NOW });
    const e = await s.secrets.write({ channel, field, value: 'k'.repeat(max + 1), at: NOW }).then(() => null, (err) => err);
    assert.equal(e?.code, RECORDS_ERROR.INVALID, `${channel}.${field} 超限却写进去了（上限 ${max}）`);
    assert.match(e.message, /上限/u, `报错没把上限说清楚：${e?.message}`);
    // 空串不是"清除"：它必须报错，否则设置页留空点保存会把已配的密钥清掉
    const empty = await s.secrets.write({ channel, field, value: '', at: NOW }).then(() => null, (err) => err);
    assert.equal(empty?.code, RECORDS_ERROR.INVALID);
  }
  await s.closeAll();
});

check('describe 只回形状：每个登记字段都在，值一个字都不出这扇门', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  const SECRET = 'super-secret-value-9f3a';
  const APPIDV = '20250101000000001';
  await s.secrets.write({ channel: 'baidu', field: 'appid', value: APPIDV, at: NOW });
  await s.secrets.write({ channel: 'baidu', field: 'key', value: SECRET, at: NOW + 5 });
  // 库里躺着一行未登记的字段（手工改过的库）：它不许出现在界面上，也不许把 describe 撑爆
  f.seed(DOMAIN_NAME, TABLES.secrets, 'sec-baidu_weird', {
    channel: 'baidu', field: 'weird', value: SECRET, at: NOW, chars: SECRET.length,
  });
  const d = await s.secrets.describe();
  assert.deepEqual(Object.keys(d).sort(), Object.keys(TRANS_CRED_FIELDS).sort());
  assert.deepEqual(Object.keys(d.baidu).sort(), TRANS_CRED_FIELDS.baidu.map((x) => x.id).sort(),
    'baidu 那一格多了/少了字段 ⇒ 设置页会照着清单渲染出个没人认识的输入框');
  assert.equal(d.baidu.weird, undefined);
  assert.deepEqual(d.baidu.appid, { configured: true, chars: APPIDV.length, at: NOW });
  assert.deepEqual(d.baidu.key, { configured: true, chars: SECRET.length, at: NOW + 5 });
  assert.deepEqual(d.tencent.secret_id, { configured: false, chars: 0, at: 0 }, '没配的字段也要有一格，界面才说得清"缺哪一个"');
  const dumped = JSON.stringify(d);
  assert.equal(dumped.includes(SECRET), false, 'describe 把值带出去了：这一份是要进快照、要过网络回浏览器的');
  assert.equal(dumped.includes(APPIDV), false, 'AppID 也算凭据：它能和密钥配成一对去签名');
  // 摘要有值就必有时刻；hasAll 用的也是这一份形状（界面无需自己数）
  assert.equal(await s.secrets.hasAll('baidu'), true);
  await s.closeAll();
});

check('hasAll：缺任一字段就是 false；未登记的渠道与没字段的渠道同样 false（不抛）', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  assert.equal(await s.secrets.hasAll('baidu'), false);
  await s.secrets.write({ channel: 'baidu', field: 'appid', value: APPID, at: NOW });
  assert.equal(await s.secrets.hasAll('baidu'), false, '只填了 AppID 就报告"能发" ⇒ 每一发都带 54001 回来');
  await s.secrets.write({ channel: 'baidu', field: 'key', value: KEY, at: NOW });
  assert.equal(await s.secrets.hasAll('baidu'), true);
  assert.equal(await s.secrets.hasAll('google'), false);
  assert.equal(await s.secrets.hasAll(''), false);
  assert.equal(await s.secrets.hasAll(undefined), false);
  await s.closeAll();
});

check('hasAll 跳过 optional 字段：填齐"必须的那几栏"就放行（腾讯的地域留空由发送侧回落默认值）', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  const optional = [];
  const perChannel = [];
  for (const [channel, fields] of Object.entries(TRANS_CRED_FIELDS)) {
    optional.push(...fields.filter((x) => x.optional === true).map((x) => [channel, x]));
    perChannel.push([channel, fields.filter((x) => x.optional !== true)]);
  }
  assert.ok(optional.length >= 1, '登记表里一个 optional 字段都没有 ⇒ hasAll 那条跳过分支是死码，这一条也没测到东西');
  for (const [channel, spec] of optional) {
    assert.ok(spec.hint && spec.hint.length > 0, `${channel}.${spec.id} 是可选的，却没给界面一句"留空会怎样"的话术`);
  }
  for (const [channel, required] of perChannel) {
    assert.equal(await s.secrets.hasAll(channel), false, `${channel} 一栏都没填却报告"能发"`);
    for (const x of required) await s.secrets.write({ channel, field: x.id, value: `v-${x.id}-value`, at: NOW });
    assert.equal(await s.secrets.hasAll(channel), true,
      `${channel} 把必须的那几栏都填齐了，闸门还挡着（optional 的那栏不该挡）`);
    assert.equal(await s.secrets.hasAll(`${channel}-nope`), false);
  }
  await s.closeAll();
});

check('清除走 remove：read 回 null、describe 那一格回到未配置，别的字段不动', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.secrets.write({ channel: 'baidu', field: 'appid', value: APPID, at: NOW });
  await s.secrets.write({ channel: 'baidu', field: 'key', value: KEY, at: NOW });
  const r = await s.secrets.remove('baidu', 'key');
  assert.deepEqual(r, { channel: 'baidu', field: 'key', configured: false, chars: 0, at: 0 });
  assert.equal(await s.secrets.read('baidu', 'key'), null);
  const d = await s.secrets.describe();
  assert.deepEqual(d.baidu.key, { configured: false, chars: 0, at: 0 });
  assert.equal(d.baidu.appid.configured, true, '清除一个字段把邻居也清了');
  assert.equal(f.rowCount(DOMAIN_NAME, TABLES.secrets), 1);
  // 关掉之后再写：CLOSED 而不是 UNAVAILABLE（设施在，只是这张表的句柄没了）
  await s.secrets.close();
  const e = await s.secrets.write({ channel: 'baidu', field: 'key', value: KEY, at: NOW }).then(() => null, (err) => err);
  assert.equal(e?.code, RECORDS_ERROR.CLOSED);
  await s.closeAll();   // 已经关过的那张再关一次是 no-op（从没 acquire 过就不去减别人的 refs）
});

check('没有设施时 trans 与 secrets 都是 rejected promise，available 位如实说"存不了"', async () => {
  const s = createAllStores({ getFacility: () => undefined });
  assert.equal(s.trans.available, false);
  assert.equal(s.secrets.available, false);
  const a = await s.trans.put(OK_ROW()).then(() => null, (e) => e);
  assert.equal(a?.code, RECORDS_ERROR.UNAVAILABLE);
  const b = await s.secrets.write({ channel: 'baidu', field: 'key', value: KEY, at: NOW }).then(() => null, (e) => e);
  assert.equal(b?.code, RECORDS_ERROR.UNAVAILABLE);
  // 读侧也是 rejected（不是返回空 Map）：把"库打不开"伪装成"库里没译文"，界面就会说"一句都没译过"。
  // 降级成"没有中文"那一层在 lib/query.js，判据在 test/query.test.mjs。
  const e2 = await s.trans.zhMap().then(() => null, (err) => err);
  assert.equal(e2?.code, RECORDS_ERROR.UNAVAILABLE);
  const e3 = await s.secrets.describe().then(() => null, (err) => err);
  assert.equal(e3?.code, RECORDS_ERROR.UNAVAILABLE);
});

/* ---------------- F. 一份真相 ---------------- */

check('表名与域名字面量只从 domain.js 出（stores 里不许再写一遍）', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync('lib/stores.js', 'utf8'));
  // 扫描面从 TABLES 派生，不手抄：加一张表时这条判据要自己就覆盖到它（手抄的五张表清单会悄悄变旧，
  // 而"变旧的清单"正是这条判据要防的那种东西 —— 它绿着，却已经不看新表）。
  const literals = [...Object.values(TABLES), DOMAIN_NAME].map((v) => `'${v}'`);
  assert.ok(literals.length === Object.keys(TABLES).length + 1, '派生出来的清单空了就等于没扫');
  for (const bare of literals) {
    assert.equal(src.includes(bare), false, `stores.js 里出现了裸字面量 ${bare}`);
  }
  assert.equal(AC_DOMAIN.name, DOMAIN_NAME);
  assert.deepEqual(Object.keys(AC_DOMAIN.tables), Object.values(TABLES), '域的表清单与 TABLES 必须同集合同顺序');
});

await check('同毫秒的流水按写入顺序排，trim 砍掉的是最旧那批', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  const batch = [];
  for (let i = 0; i < 25; i += 1) batch.push({ at: NOW, kind: 'added', slug: `Animals::a${i}` });
  await s.changes.appendMany(batch);
  const list = await s.changes.list(500);
  assert.equal(list.length, 25);
  assert.equal(list[0].slug, 'Animals::a24', `倒序的第一条不是最新写入的那条：${list[0].slug}`);
  assert.equal(list[24].slug, 'Animals::a0');
  await s.changes.trim(10);
  const left = await s.changes.list(500);
  assert.equal(left.length, 10);
  assert.equal(left[0].slug, 'Animals::a24');
  assert.equal(left[9].slug, 'Animals::a15', `trim 砍错了批次：${left.map((r) => r.slug).join(',')}`);
  // 单条 append 走的是另一行发号代码，它也得补零：list 的次序是字典序，
  // "…-9" 排在 "…-10" 之后 = 界面把十毫秒前的更新摆在最新上面，trim 也会砍错批次。
  for (let i = 0; i < 12; i += 1) await s.changes.append({ at: NOW + 1, kind: 'added', slug: `Animals::b${i}` });
  const mixed = await s.changes.list(500);
  assert.equal(mixed.length, 22);
  assert.equal(mixed[0].slug, 'Animals::b11', `逐条 append 的最新一行没排在最前：${mixed[0].slug}`);
  for (const r of mixed) assert.match(r.id, /^c-\d+-\d{4}$/u, `流水 id 的同毫秒序号没补零：${r.id}`);
  await s.closeAll();
});

check('meta.lastStatus 越界挡在 put 之前（状态字段是界面直接渲染的那一个）', async () => {
  const f = makeFakeFacility();
  const s = storesWith(f);
  await s.meta.patch({ keyRule: KEY_RULE_VERSION, lastStatus: 'success' });
  const err = await s.meta.patch({ lastStatus: 'probably-fine' }).then(() => null, (e) => e);
  assert.ok(err, '枚举外的状态值必须报错，不能被当成"界面自己会兜"');
  assert.equal(err.code, RECORDS_ERROR.INVALID);
  const row = await s.meta.read();
  assert.equal(row.lastStatus, 'success', '被拒的那一次不许把脏值留在库里');
  await s.closeAll();
});
runAll('store');
