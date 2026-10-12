/**
 * test/api.test.mjs —— 路由层（lib/api.js，spec §6 与 §8）。
 *
 * ★ 全篇一条前提：**POST 的 body 一律从流里喂**，一次都不直接给 handler 第三个参数。
 *   宿主只传 (req, res)，喂 bodyArg 会把这条坑圆掉（sysops、appearance 各踩过一次，离线全绿真机拿不到 body）。
 *   唯一用 bodyArg 的用例是"确认它存在时不必读流"那一条（宿主某些版本已解析过，第二发会读到空流）。
 *
 * 判据取向：
 *   A 读路径：信封形状、参数解析（facet 多选 / limit 钳制 / 非法值）、404 与 405。
 *   B 写路径：入参校验（档位、源 id、批注长度与标签）、读-合并-写、服务端定 updatedAt。
 *   C 门：每条 POST 声明回环、非本机 403 且**不消费请求流**、坏 JSON 400。
 *   D SSE：帧语义、update 帧 = GET /snapshot 的形状、断开与写失败都摘牌、没人看就不读库。
 *   E 降级：存储不可用报 503，不许伪装成"目录是空的"。
 *   F 现译路由（S8）：凭据只走 POST + 回环，回包里只有摘要；GET 那侧从路由表逐条扫，一条都不许提 secrets。
 */
import { check, runAll, assert, makeFakeFacility, makeReq, makeRes, flush } from './_helpers.mjs';
import {
  ROUTE_PREFIX, GLOBAL_KEY, SYNC_BUSY, NOTE_PURPOSE_MAX_LEN, TAG_MAX_COUNT, TAG_MAX_LEN,
  SEARCH_LIMIT_MAX, DEFAULT_PREFS, TRANS_CRED_MAX, TRANS_CHANNEL_IDS, TRANS_CRED_FIELDS,
  PROXY_MODES, PROXY_URL_MAX, PROXY_URL_BOUNDARY,
} from '../lib/domain.js';
import { createAllStores } from '../lib/stores.js';
import { createQueryEngine } from '../lib/query.js';
import {
  createApiHandler, API_ROUTES, readBody, isLoopback, openSse, createHub, statusFor, transportView,
} from '../lib/api.js';
import { createTranslateService } from '../lib/translate.js';
import { parseProxyUrl, createNetTransport } from '../lib/net.js';
import { KEY_RULE_VERSION } from '../lib/keys.js';
import { USAGE } from '../lib/usage.js';

const NOW = 1777000000000;

function item(slug, over = {}) {
  return {
    slug, name: slug.split('::')[1] || slug, desc: 'a feed', host: `${(slug.split('::')[1] || 'x').toLowerCase()}.example`,
    url: `https://api.example/${slug}`, auth: 'No', https: 'Yes', cors: 'Yes',
    category: slug.split('::')[0], firstSeenAt: NOW, lastSeenAt: NOW, ...over,
  };
}

// 4 条里：auth=No 三条（Beta 是 apiKey）、CORS+HTTPS 全 Yes 的两条（Delta 的 cors 是 unknown）、
// host=github.com 两条（Gamma / Delta）—— 下面 snapshot / hosts 那几条判据数的就是这三个数。
const SEED = [
  { category: 'Weather', updatedAt: NOW, items: [item('Weather::Alpha'), item('Weather::Beta', { auth: 'apiKey', cors: 'No' }), item('Weather::Gamma', { host: 'github.com' })] },
  { category: 'Books', updatedAt: NOW, items: [item('Books::Delta', { desc: 'weather books', host: 'github.com', cors: 'unknown' })] },
];

function rig({ seed = SEED, withMeta = true, trigger, facility, sseBroken, translate } = {}) {
  const f = facility ?? makeFakeFacility();
  const events = [];
  const stores = createAllStores({ getFacility: () => f, now: () => NOW });
  const engine = createQueryEngine({ stores });
  const caps = { read: () => ({ storageDomain: true, timer: true, webServer: true }), rows: () => [{ key: 'storageDomain', ok: true }] };
  const beats = [];
  const handler = createApiHandler({
    engine,
    stores,
    caps,
    now: () => NOW,
    trigger: trigger ?? (async (t) => { events.push(t); return { ok: true, status: 'success', code: 'updated', trigger: t }; }),
    lastSync: () => ({ trigger: 'timer', at: NOW, ok: true }),
    ...(translate ? { translate } : {}),
    onPrefsSaved: (p) => events.push(['prefs-saved', p]),
    sseTimers: {
      setIntervalMod: (fn, ms) => { beats.push(fn); return { ms, unref() {} }; },
      clearIntervalMod: () => {},
    },
    ...(sseBroken ? { logger: { warn: (m) => events.push(String(m)) } } : {}),
  });
  return {
    f, stores, engine, handler, events, beats,
    seed: async () => {
      await stores.entries.writeMany(seed);
      if (withMeta) await stores.meta.patch({ keyRule: KEY_RULE_VERSION, sha: 'sha-seed', lastStatus: 'success', total: 4, lastCheckedAt: NOW });
    },
  };
}

const get = async (h, path, { reqOpts } = {}) => {
  const req = makeReq({ url: `${ROUTE_PREFIX}${path}`, ...reqOpts });
  const res = makeRes();
  await h(req, res);
  await flush(2);
  return res;
};
const post = async (h, path, body, { reqOpts, raw } = {}) => {
  const req = makeReq({ method: 'POST', url: `${ROUTE_PREFIX}${path}`, body: raw ?? (body === undefined ? '' : JSON.stringify(body)), ...reqOpts });
  const res = makeRes();
  await h(req, res);
  await flush(2);
  return { res, req };
};

/* ------------------------------------------------------------------ *
 * A 读路径
 * ------------------------------------------------------------------ */

check('GET /api/snapshot：信封 + 首屏要的数字一次给齐，客户端不必发第二发', async () => {
  const r = rig();
  await r.seed();
  const res = await get(r.handler, '/api/snapshot');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  const d = res.json().data;
  assert.equal(d.index.total, 4);
  assert.equal(d.index.categories, 2);
  assert.equal(d.facets.category.length, 2);
  assert.deepEqual(d.presets, { 'no-key': 3, 'browser-direct': 2 }, 'Beta 要 key、Delta 的 CORS 是 unknown ⇒ 两档计数必然不同，同数就是把 unknown 当成了 No');
  assert.equal(d.result.total, 4);
  assert.equal(d.notes.total, 0);
  assert.equal(d.capabilities.storageDomain, true);
  // ★ 2026-10-06：能力位的**展示行**只留首屏 payload 那一份（host-compat 那批判据读它）。
  //   快照每轮都推，而界面上那张「解析台账」已经撤了 ⇒ 再摊一份数组就是每帧为没人读的东西买单。
  assert.equal('capabilityRows' in d, false, 'capabilityRows 还在每轮推的快照里：撤卡要连载荷一起撤干净');
  assert.equal(d.lastSync.ok, true, 'lastSync 是"本次宿主启动后那一轮的结果"，没跑过才是 null');
  assert.equal(typeof d.builtAt, 'number');
  assert.equal(d.meta.sha, 'sha-seed');
});

check('GET /api/search：query / category / host / facet / limit 全从 query string 走', async () => {
  const r = rig();
  await r.seed();
  assert.equal((await get(r.handler, '/api/search?q=weather')).json().data.total, 1, '分类不参与打分：只有 Delta 的 desc 里有 weather，查分类该走 category 参数');
  assert.equal((await get(r.handler, '/api/search?q=weather&category=Books')).json().data.total, 1);
  assert.equal((await get(r.handler, '/api/search?q=alpha')).json().data.total, 1);
  assert.equal((await get(r.handler, '/api/search?category=Books')).json().data.total, 1);
  assert.equal((await get(r.handler, '/api/search?host=github.com')).json().data.total, 2);
  assert.equal((await get(r.handler, '/api/search?auth=No&auth=apiKey')).json().data.total, 4);
  assert.equal((await get(r.handler, '/api/search?auth=apiKey')).json().data.total, 1);
  assert.equal((await get(r.handler, '/api/search?auth=No,OAuth')).json().data.total, 3, '逗号写法与重复键必须同结果');
  const lim = (await get(r.handler, '/api/search?limit=2')).json().data;
  assert.equal(lim.rows.length, 2);
  assert.equal(lim.truncated, true);
  assert.equal((await get(r.handler, '/api/search?limit=99999')).json().data.rows.length, Math.min(SEARCH_LIMIT_MAX, 4));
  const url = (await get(r.handler, '/api/search?q=%E5%A4%A9%E6%B0%94')).json().data;
  assert.deepEqual(url.rows, [], '编码过的中文查询要能走到子串匹配（这里是 0 条，不是 400）');
});

check('GET /api/hosts：默认门槛与 min/top 参数；截断要如实标出来', async () => {
  const r = rig();
  await r.seed();
  const all = (await get(r.handler, '/api/hosts?min=1')).json().data;
  assert.equal(all.rows[0].host, 'github.com');
  assert.equal(all.rows[0].count, 2);
  assert.equal(all.truncated, false);
  const top1 = (await get(r.handler, '/api/hosts?min=1&top=1')).json().data;
  assert.equal(top1.rows.length, 1);
  assert.equal(top1.truncated, true);
  assert.equal(top1.total, all.total);
  assert.deepEqual((await get(r.handler, '/api/hosts')).json().data.rows.map((x) => x.host), ['github.com'], '默认门槛 HOST_AGG_MIN：只有一条的那两家不进清单');
  // ★ `?min=`（空串）必须与"没填"同义：Number('') 是 0 且是有限数，不先判空就会被夹到下限 1，
  //   清单从"散在多个分类的 34 家"变成"全列"，而界面上那句门槛话术还写着 5。
  assert.deepEqual((await get(r.handler, '/api/hosts?min=')).json().data.rows.map((x) => x.host), ['github.com'], 'min 传空串时被顶成了下限 1：默认门槛没保住');
  assert.equal((await get(r.handler, '/api/hosts?min=%20')).json().data.rows.length, 1, 'min 传空白也一样当"没填"');
});

check('GET /api/entry：命中给条目 + 批注 + 派生句，不命中 404 并指向「我的笔记」', async () => {
  const r = rig();
  await r.seed();
  await r.stores.notes.write({ slug: 'Weather::Alpha', category: 'Weather', purpose: '试过能用', tags: ['常用'], starred: true, updatedAt: NOW });
  const hit = (await get(r.handler, '/api/entry?slug=Weather%3A%3AAlpha')).json().data;
  assert.equal(hit.entry.name, 'Alpha');
  assert.equal(hit.entry.note.purpose, '试过能用');
  assert.ok(hit.entry.derived.length >= 1);
  const miss = await get(r.handler, '/api/entry?slug=Weather%3A%3ANope');
  assert.equal(miss.statusCode, 404);
  assert.equal(miss.json().error.code, 'NOT_FOUND');
  assert.ok(miss.json().error.message.includes('我的笔记'), '上游删掉的条目，界面要告诉用户笔记还在不在');
  assert.equal((await get(r.handler, '/api/entry')).statusCode, 400);
});

check('GET /api/entry 把用法层带过去，而 /api/snapshot 一行都不带（那一层只有点开详情才用得上）', async () => {
  const COVERED = Object.keys(USAGE)[0];
  const r = rig({ seed: [{ category: 'Data', updatedAt: NOW, items: [
    item('Data::Covered', { url: COVERED, host: new URL(COVERED).hostname }),
    item('Data::Plain', { url: 'https://目录里没有这一家.example/' }),
  ] }] });
  await r.seed();
  const entry = (await get(r.handler, '/api/entry?slug=Data%3A%3ACovered')).json().data.entry;
  assert.deepEqual(entry.usage, USAGE[COVERED], '路由那一发把用法层改了形状（界面按这几格摆，漂一格就空一块）');
  const plain = (await get(r.handler, '/api/entry?slug=Data%3A%3APlain')).json().data.entry;
  assert.equal(plain.usage, null);
  const snap = (await get(r.handler, '/api/snapshot')).json().data;
  for (const row of snap.result.rows) {
    assert.equal('usage' in row, false, `${row.slug} 出现在快照行里：一百多键的表被摊进每一发快照`);
  }
});

check('GET /api/changes：倒序 + kind 过滤 + limit 的"没填"口径（0 / abc / 空串都回落默认 100）', async () => {
  const r = rig();
  await r.seed();
  await r.stores.changes.appendMany([
    { kind: 'added', at: NOW + 1, slug: 'Weather::Alpha', name: 'Alpha', category: 'Weather' },
    { kind: 'source_error', at: NOW + 2, detail: '源故障：jsDelivr CDN timeout' },
    { kind: 'changed', at: NOW + 3, slug: 'Weather::Beta', name: 'Beta', detail: '鉴权 No → apiKey' },
  ]);
  const rows = (await get(r.handler, '/api/changes')).json().data.rows;
  assert.deepEqual(rows.map((x) => x.kind), ['changed', 'source_error', 'added']);
  assert.equal((await get(r.handler, '/api/changes?kind=source_error')).json().data.rows.length, 1);
  assert.equal((await get(r.handler, '/api/changes?limit=2')).json().data.rows.length, 2);
  assert.equal((await get(r.handler, '/api/changes?limit=0')).json().data.rows.length, 3);
  assert.equal((await get(r.handler, '/api/changes')).json().data.meta.sha, 'sha-seed');

  // 流水超过默认 100 行时，`limit=0` 与"没填"必须同数：把 0 夹成 0 条交给仓储，
  // 界面会说"库里最多 200 行"而只画一行都不画的那一栏（读不出）；传下去不拦就等于让一发请求把整档流水倒进面板。
  const big = rig();
  await big.seed();
  await big.stores.changes.appendMany(Array.from({ length: 120 }, (_, i) => ({
    kind: 'changed', at: NOW + 1000 + i, slug: `Weather::Alpha`, name: `Alpha ${i}`, category: 'Weather', detail: `第 ${i} 行`,
  })));
  const plain = (await get(big.handler, '/api/changes')).json().data.rows.length;
  assert.equal(plain, 100, '默认 limit 是 100，不是"全给"');
  assert.equal((await get(big.handler, '/api/changes?limit=0')).json().data.rows.length, plain, 'limit=0 要当"没填"回落默认');
  assert.equal((await get(big.handler, '/api/changes?limit=abc')).json().data.rows.length, plain, 'limit=abc 同上');
});

check('GET /api/notes 与 /api/prefs：视图名不认识的直接 400，不返回"全部"糊过去', async () => {
  const r = rig();
  await r.seed();
  await r.stores.notes.write({ slug: 'Weather::Alpha', category: 'Weather', purpose: 'p', starred: true, updatedAt: NOW });
  assert.equal((await get(r.handler, '/api/notes')).json().data.rows.length, 1);
  assert.equal((await get(r.handler, '/api/notes?view=starred')).json().data.rows.length, 1);
  assert.equal((await get(r.handler, '/api/notes?view=orphan')).json().data.rows.length, 0);
  const bad = await get(r.handler, '/api/notes?view=everything');
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'INVALID_PARAM');
  assert.equal((await get(r.handler, '/api/prefs')).json().data.intervalMin, 720);
});

check('未知路径 404、方法不对 405（并说清接受哪些方法）', async () => {
  const r = rig();
  await r.seed();
  const nf = await get(r.handler, '/api/nope');
  assert.equal(nf.statusCode, 404);
  assert.ok(nf.json().error.message.includes(ROUTE_PREFIX));
  const wrong = await post(r.handler, '/api/snapshot', {});
  assert.equal(wrong.res.statusCode, 405);
  assert.ok(wrong.res.json().error.message.includes('GET'));
  const bare = await get(r.handler, '/');
  assert.equal(bare.statusCode, 404, '前缀本身不是接口：404 也算答了，不许挂');
  assert.equal(bare.json().error.code, 'NOT_FOUND');
});

/* ------------------------------------------------------------------ *
 * B 写路径
 * ------------------------------------------------------------------ */

check('POST body 是从流里拼出来的：handler 只拿到 (req,res) 也要能写库', async () => {
  const r = rig();
  await r.seed();
  const req = makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/notes`, body: JSON.stringify({ slug: 'Weather::Alpha', category: 'Weather', purpose: '从流里来的' }) });
  const res = makeRes();
  assert.equal(req.listenerCount('data'), 0, '夹具不该预先有人听');
  await r.handler(req, res);   // 只传两个参数 —— 真机就是这样
  await flush(4);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.purpose, '从流里来的');
  assert.equal((await r.stores.notes.read('Weather::Alpha')).purpose, '从流里来的');
});

check('宿主已解析过 body（req.__parsedBody）时不重复读流', async () => {
  const r = rig();
  await r.seed();
  const req = makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/prefs` });
  req.__parsedBody = { intervalMin: 60 };
  const res = makeRes();
  await r.handler(req, res);
  await flush(2);
  assert.equal(res.json().data.intervalMin, 60);
});

check('POST /api/notes：只发一项也不抹掉别的（读-合并-写），时刻由服务端定', async () => {
  const r = rig();
  await r.seed();
  await r.stores.notes.write({ slug: 'Weather::Alpha', category: 'Weather', purpose: '别抹我', tags: ['a'], starred: false, hidden: true, updatedAt: 1 });
  const first = (await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', starred: true })).res;
  assert.equal(first.statusCode, 200);
  const saved = first.json().data;
  assert.equal(saved.purpose, '别抹我');
  assert.deepEqual(saved.tags, ['a']);
  assert.equal(saved.hidden, true);
  assert.equal(saved.starred, true);
  assert.equal(saved.updatedAt, NOW, 'updatedAt 必须由服务端 clock 定，界面报的时刻不作数');
  assert.equal((await r.stores.notes.read('Weather::Alpha')).updatedAt, NOW);
});

check('POST /api/notes 的入参校验：长度、类型、缺字段各报各的', async () => {
  const r = rig();
  await r.seed();
  const tooLong = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', purpose: '长'.repeat(NOTE_PURPOSE_MAX_LEN + 1) });
  assert.equal(tooLong.res.statusCode, 400);
  assert.ok(tooLong.res.json().error.message.includes(String(NOTE_PURPOSE_MAX_LEN)), '超长要报"上限是多少"，不能只说无效');
  const notString = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', purpose: 42 });
  assert.equal(notString.res.statusCode, 400);
  const noSlug = await post(r.handler, '/api/notes', { category: 'Weather', purpose: 'x' });
  assert.equal(noSlug.res.statusCode, 400);
  const noCategory = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', purpose: 'x' });
  assert.equal(noCategory.res.statusCode, 400, '缺 category 会算不出搬家后的新键，必须拒');
  const nothing = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather' });
  assert.equal(nothing.res.statusCode, 400, '一个字段都没给等于写一行空批注');
  // slug 的长度闸门：编码层会把键截到 64 字符以内，所以越界不会崩 —— 但它意味着"两个长 slug 凑出同一个批注键"，
  // 用户的笔记会串到别人身上。界面递来的 slug 只能是目录里那一个形状。
  const longSlug = await post(r.handler, '/api/notes', { slug: `Weather::${'长'.repeat(301)}`, category: 'Weather', purpose: 'x' });
  assert.equal(longSlug.res.statusCode, 400, 'slug 顶到 300 字以上必须拒：键折叠之后批注会串到另一条上');
  assert.equal(longSlug.res.json().error.code, 'INVALID_PARAM');
});

check('标签：去空白、去空、去重后入库；数量与长度超限才报', async () => {
  const r = rig();
  await r.seed();
  const ok = await post(r.handler, '/api/notes', { slug: 'Weather::Beta', category: 'Weather', tags: [' 常用 ', '常用', '', '备用'] });
  assert.deepEqual(ok.res.json().data.tags, ['常用', '备用']);
  const many = await post(r.handler, '/api/notes', { slug: 'Weather::Beta', category: 'Weather', tags: Array.from({ length: TAG_MAX_COUNT + 1 }, (_, i) => `t${i}`) });
  assert.equal(many.res.statusCode, 400);
  const long = await post(r.handler, '/api/notes', { slug: 'Weather::Beta', category: 'Weather', tags: ['长'.repeat(TAG_MAX_LEN + 1)] });
  assert.equal(long.res.statusCode, 400);
  assert.equal((await post(r.handler, '/api/notes', { slug: 'Weather::Beta', category: 'Weather', tags: '不是数组' })).res.statusCode, 400);
});

check('批注行的 name 快照：从在册条目取人话名，界面递的 name 一个字都不吃', async () => {
  const r = rig();
  await r.seed();
  const first = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', purpose: '我的用法' });
  assert.equal(first.res.json().data.name, 'Alpha', 'slug 尾巴是按 norm(name) 生成的，界面递来的 name 不算数 —— 只有库里的条目能作证');
  assert.equal((await r.stores.notes.read('Weather::Alpha')).name, 'Alpha');

  // 上游删了条目之后再改批注：快照必须保住（这正是它存在的唯一理由）
  await r.stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [] }]);
  await r.stores.meta.patch({ sha: 'sha-seed-2' });   // 不换 sha，引擎照旧吃缓存，这一发就测不到"条目真没了"
  const again = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', purpose: '改一句' });
  assert.equal(again.res.json().data.name, 'Alpha', '条目没了就把快照洗成空，orphan 那一行又只剩 slug 尾巴了');

  // 目录里从来没有过的 slug：查不到条目不等于不许写批注，name 回落成"没有"
  const ghost = await post(r.handler, '/api/notes', { slug: 'Weather::Never', category: 'Weather', purpose: 'x', name: '假名字' });
  assert.equal(ghost.res.statusCode, 200);
  assert.notEqual(ghost.res.json().data.name, '假名字', '界面递的 name 一个字都不许进载荷');
  assert.equal('name' in await r.stores.notes.read('Weather::Never'), false, 'optionalString 对空串是给 undefined 的：落库那行不该多一个空 name 键');
});

check('orphan 由差分写、界面改不动：把 starred 关掉不会把"上游已删"洗成还在', async () => {
  const r = rig();
  await r.seed();
  await r.stores.notes.write({ slug: 'Weather::Gamma', category: 'Weather', purpose: '留着', orphan: true, starred: true, updatedAt: 1 });
  const res = (await post(r.handler, '/api/notes', { slug: 'Weather::Gamma', category: 'Weather', starred: false })).res.json().data;
  assert.equal(res.starred, false);
  assert.equal(res.orphan, true, 'orphan 被界面写掉了 —— 用户删个星标不该让笔记从"上游已删"变成"还在"');
  // 只防"没递"不够：脚本可以直接递 orphan:false 把标记洗掉。库里那一份才是唯一出处，界面递来的这个字段一个字都不认。
  const lied = (await post(r.handler, '/api/notes', { slug: 'Weather::Gamma', category: 'Weather', purpose: '补一句', orphan: false })).res.json().data;
  assert.equal(lied.orphan, true, 'orphan 由差分写：body 里递 false 也不许洗成"还在册"');
  const lied2 = (await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', purpose: '假装上游删了', orphan: true })).res.json().data;
  assert.equal(lied2.orphan, false, '也不许递 true 把一条在册 API 的笔记标成"上游已删"');
});

check('POST /api/notes/delete：删掉那一行，没有批注可删报 404', async () => {
  const r = rig();
  await r.seed();
  await r.stores.notes.write({ slug: 'Weather::Alpha', category: 'Weather', purpose: 'p', updatedAt: 1 });
  assert.equal((await post(r.handler, '/api/notes/delete', { slug: 'Weather::Alpha' })).res.statusCode, 200);
  assert.equal(await r.stores.notes.read('Weather::Alpha'), null);
  const again = await post(r.handler, '/api/notes/delete', { slug: 'Weather::Alpha' });
  assert.equal(again.res.statusCode, 404);
  assert.equal(again.res.json().error.code, 'NOT_FOUND');
});

check('POST /api/prefs：档位外的值与没登记的源 id 都拒，落库后回调重挂节拍', async () => {
  const r = rig();
  await r.seed();
  const bad = await post(r.handler, '/api/prefs', { intervalMin: 7 });
  assert.equal(bad.res.statusCode, 400);
  assert.ok(bad.res.json().error.message.includes('720'), '报错要把可用档位念出来，界面上才知道能填什么');
  const unknownSource = await post(r.handler, '/api/prefs', { sourcePriority: ['jsdelivr', 'raw-github'] });
  assert.equal(unknownSource.res.statusCode, 400);
  const saved = (await post(r.handler, '/api/prefs', { intervalMin: 60 })).res;
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().data.intervalMin, 60);
  // 期望形状从 DEFAULT_PREFS 派生，不手抄键清单：prefs 每加一项（S8 那两项就是例子），
  // 手抄的那份立刻变成"少一格也绿"的旧账。
  assert.deepEqual(await r.stores.prefs.read(), { ...DEFAULT_PREFS, intervalMin: 60 });
  assert.equal(r.events.filter((e) => Array.isArray(e) && e[0] === 'prefs-saved').length, 1, '不落库回调就没必要重挂节拍');
  const empty = await post(r.handler, '/api/prefs', {});
  assert.equal(empty.res.statusCode, 400);

  // 现译的两项：开关只认布尔，渠道只认登记过的档位（界面点出来的值不会越界，越界的就是别的来路）。
  const notBool = await post(r.handler, '/api/prefs', { transEnabled: 'yes' });
  assert.equal(notBool.res.statusCode, 400, '字符串 "yes" 被收成了开关 —— 真机上这就是"我以为我开了"');
  const badChannel = await post(r.handler, '/api/prefs', { transChannel: 'google' });
  assert.equal(badChannel.res.statusCode, 400);
  assert.ok(badChannel.res.json().error.message.includes(TRANS_CHANNEL_IDS[0]), '报错要把能选的档念出来');
  const on = await post(r.handler, '/api/prefs', { transEnabled: true, transChannel: 'baidu' });
  assert.equal(on.res.statusCode, 200);
  assert.equal(on.res.json().data.transEnabled, true);
  assert.equal(on.res.json().data.transChannel, 'baidu');
  const stored = await r.stores.prefs.read();
  assert.equal(stored.transChannel, 'baidu');
  // 递凭据给偏好这一发必须**整发拒掉**（而不是"收下但界面看不见"）：prefs 是会被整份推给浏览器的那一份。
  const smuggled = await post(r.handler, '/api/prefs', { appid: '1234567890', key: 'super-secret-value' });
  assert.equal(smuggled.res.statusCode, 400, '未知键没被拒 ⇒ clamp 之外还有第二条进 prefs 的路');
  assert.equal((await r.stores.prefs.read()).appid, undefined);
  // 凭据字段清单从登记表派生（手抄几个名字的清单会在加一档之后漏掉那一档的字段）。
  const credKeys = [...new Set(Object.values(TRANS_CRED_FIELDS).flat().map((f) => f.id))];
  assert.ok(credKeys.length >= 8, `派生出的凭据字段清单只有 ${credKeys.length} 项，等于没扫`);
  for (const k of credKeys) {
    assert.equal(k in stored, false, `prefs 里出现了凭据键 ${k}：这份会被 snapshotOf 整份推给浏览器`);
  }
});

check('POST /api/prefs 的代理两格：模式只认三档、地址必须隧道层解析得过，带 user:pass@ 的那一发整发拒（它是唯一进 prefs 的出网地址）', async () => {
  const r = rig();
  await r.seed();

  const badMode = await post(r.handler, '/api/prefs', { proxyMode: 'socks' });
  assert.equal(badMode.res.statusCode, 400);
  assert.ok(badMode.res.json().error.message.includes(PROXY_MODES.join(' / ')), '报错要把三档念出来，界面上才知道能填哪几档');

  // 这一格只收"隧道层真能拿去发 CONNECT"的形状：解析不过就当场拒，别留到下一发出网时才报"传输失败"。
  for (const junk of ['127.0.0.1', 'http://127.0.0.1:0', 'socks5://127.0.0.1:1080', 'localhost:port']) {
    const bad = await post(r.handler, '/api/prefs', { proxyUrl: junk });
    assert.equal(bad.res.statusCode, 400, `"${junk}" 被收进了 prefs ⇒ 出网那一发才会说"没能出去"，那时已经看不出是地址写错`);
  }
  assert.equal((await post(r.handler, '/api/prefs', { proxyUrl: 'h'.repeat(PROXY_URL_MAX + 1) })).res.statusCode, 400);

  // ★ 这一条是这一格的分界线，也是下面那条 400 的前提：**解析层本身收带认证的地址**
  //   （环境变量与注册表那两条路必须收），写侧却偏要拒 —— 前半句不先钉住，后半句就成了
  //   "谁都解析不过所以谁都进不来"的假绿（@ 那一拦根本没在拦东西）。
  const withAuth = 'http://user:pw@127.0.0.1:7897';
  assert.equal(parseProxyUrl(withAuth).ok, true, '解析层现在连这种形状都不认 ⇒ 上面那圈"写侧拒 @"拦的是空气');
  const smuggled = await post(r.handler, '/api/prefs', { proxyMode: 'custom', proxyUrl: withAuth });
  assert.equal(smuggled.res.statusCode, 400);
  assert.equal(smuggled.res.json().error.message, PROXY_URL_BOUNDARY,
    '拒了却没把"为什么不收"整句念出来：界面上只剩"地址不合法"，用户会去改端口');

  const ok = await post(r.handler, '/api/prefs', { proxyMode: 'custom', proxyUrl: ' http://127.0.0.1:7897 ' });
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.res.json().data.proxyUrl, 'http://127.0.0.1:7897', '首尾空白没抹掉：带着空格去解析就成了"地址不合法"');
  assert.deepEqual(await r.stores.prefs.read(), { ...DEFAULT_PREFS, proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7897' });
  // 空串是"清除"而不是"没填"：填过又删掉的那位不能被旧地址卡住。
  assert.equal((await post(r.handler, '/api/prefs', { proxyUrl: '' })).res.json().data.proxyUrl, '');
  assert.equal(JSON.stringify(await r.stores.prefs.read()).includes('pw'), false,
    '代理密码进了 prefs：这一份会被 snapshotOf 整份推给浏览器');
});

check('POST /api/sync：跑完给那一轮的结果；撞车那一发报 409 而不是"200 但其实没同步"', async () => {
  const seen = [];
  const r = rig({ trigger: async (t) => { seen.push(t); return { ok: true, status: 'noChange', code: 'no_change', trigger: t }; } });
  await r.seed();
  const one = (await post(r.handler, '/api/sync')).res;
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().data.result.status, 'noChange');
  assert.deepEqual(seen, ['manual'], '触发来源要标成 manual，界面才知道是谁跑的这一轮');
  const busy = rig({ trigger: async () => ({ ok: false, status: 'failure', code: SYNC_BUSY.code, skipped: true }) });
  await busy.seed();
  const res = (await post(busy.handler, '/api/sync')).res;
  assert.equal(res.statusCode, SYNC_BUSY.http);
  assert.equal(res.json().error.code, SYNC_BUSY.code);
});

/* ------------------------------------------------------------------ *
 * C 门与坏请求
 * ------------------------------------------------------------------ */

check('每条 POST 路由都声明回环门（表判据：新增路由忘了声明也要在这里红）', async () => {
  const posts = Object.entries(API_ROUTES).filter(([key]) => key.startsWith('POST '));
  assert.ok(posts.length >= 4, `POST 路由只剩 ${posts.length} 条？`);
  for (const [key, route] of posts) assert.equal(route.loopback, true, `${key} 是写接口却没声明 loopback`);
  for (const [key, route] of Object.entries(API_ROUTES)) {
    if (key.startsWith('GET ')) assert.equal(route.loopback, undefined, '读接口加了回环门 = 本机以外看不见目录');
    assert.equal(typeof route.handler, 'function', `${key} 没有 handler`);
  }
});

check('非回环的写请求 403，而且连请求流都不消费', async () => {
  const r = rig();
  await r.seed();
  const req = makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/notes`, body: JSON.stringify({ slug: 'Weather::Alpha', category: 'Weather', purpose: '外来' }), socket: { remoteAddress: '10.0.0.8' } });
  const res = makeRes();
  await r.handler(req, res);
  await flush(4);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FORBIDDEN');
  assert.equal(req.listenerCount('data'), 0, '403 之前就把流读掉了：门变成了"读完了再拒"');
  assert.equal(await r.stores.notes.read('Weather::Alpha'), null);
  const viaProxy = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', purpose: 'x' }, {
    reqOpts: { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9, 127.0.0.1' } },
  });
  assert.equal(viaProxy.res.statusCode, 403, 'remoteAddress 是本机但 x-forwarded-for 露了外部来源 ⇒ 不算回环');
  const clean = await post(r.handler, '/api/notes', { slug: 'Weather::Alpha', category: 'Weather', purpose: '本机' }, {
    reqOpts: { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1, ::1' } },
  });
  assert.equal(clean.res.statusCode, 200, '全跳都是回环就该放行');
});

check('isLoopback 的判定表：IPv6 映射、缺 socket、多跳', async () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopback({}), true, '宿主本地直连时可能根本没有 socket 字段');
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.5' } }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '8.8.8.8' } }), false);
});

check('坏 JSON 400、超大 body 400 并掐掉请求', async () => {
  const r = rig();
  await r.seed();
  const junk = await post(r.handler, '/api/prefs', undefined, { raw: '{这不是 JSON' });
  assert.equal(junk.res.statusCode, 400);
  assert.equal(junk.res.json().error.code, 'BAD_JSON');
  const scalar = await post(r.handler, '/api/prefs', undefined, { raw: '"一个字符串"' });
  assert.equal(scalar.res.statusCode, 400, 'JSON 标量不是对象，不能当空 body 放过去');
  const empty = await post(r.handler, '/api/notes', undefined, { raw: '   ' });
  assert.equal(empty.res.statusCode, 400, '空 body 走的是"缺 slug"这一支，不是崩在 JSON.parse');
  const big = await post(r.handler, '/api/prefs', undefined, { raw: JSON.stringify({ intervalMin: 60, pad: 'x'.repeat(1_100_000) }) });
  assert.equal(big.res.statusCode, 400);
  assert.equal(big.req.destroyed, true, '超限要当场把请求掐掉，不能继续收');
});

check('空 body 与只读一次流：readBody 对没有 on() 的 req 给空对象', async () => {
  assert.deepEqual(await readBody({}), {});
  assert.deepEqual(await readBody(null), {});
  assert.deepEqual(await readBody({ __parsedBody: { a: 1 } }), { a: 1 });
  const req = makeReq({ body: '{"a":2}' });
  assert.deepEqual(await readBody(req), { a: 2 });
});

/* ------------------------------------------------------------------ *
 * D SSE
 * ------------------------------------------------------------------ */

async function attach(r, path = '/api/stream') {
  const req = makeReq({ url: `${ROUTE_PREFIX}${path}` });
  const res = makeRes();
  await r.handler(req, res);
  await flush(2);
  return { req, res };
}

function frames(res) {
  return res.writes.filter((w) => w.startsWith('event: '));
}

check('GET /api/stream：先冲头（: ok），第一帧就是整份 snapshot', async () => {
  const r = rig();
  await r.seed();
  const { res } = await attach(r);
  assert.equal(res.head.statusCode, 200);
  assert.ok(res.head['Content-Type'].startsWith('text/event-stream'));
  assert.equal(res.head['X-Accel-Buffering'], 'no');
  assert.equal(res.writes[0], ': ok\n\n', '首帧注释是拿来冲缓冲的：没有它浏览器会一直等着');
  const [first] = frames(res);
  assert.ok(first.startsWith('event: snapshot\ndata: '), first);
  const payload = JSON.parse(first.slice('event: snapshot\ndata: '.length).trim());
  assert.equal(payload.index.total, 4);
  assert.equal(res.ended, false, '长连接不许 end');
  assert.equal(r.handler.hub.size, 1);
  assert.equal(r.beats.length, 1, '心跳定时器没挂上');
});

check('update 帧的形状就是 GET /api/snapshot 的形状：客户端不需要为增量补字段', async () => {
  const r = rig();
  await r.seed();
  const { res } = await attach(r);
  const viaGet = (await get(r.handler, '/api/snapshot')).json().data;
  const frame = frames(res)[0];
  const first = JSON.parse(frame.slice('event: snapshot\ndata: '.length).trim());
  assert.deepEqual(Object.keys(first).sort(), Object.keys(viaGet).sort(), '两条路的键集不同 ⇒ 客户端要写分支，早晚漏一个字段');
  await r.stores.notes.write({ slug: 'Weather::Alpha', category: 'Weather', purpose: '同步后又写了一条', updatedAt: NOW });
  await r.handler.pushUpdate();
  await flush(2);
  const last = JSON.parse(frames(res)[1].slice('event: update\ndata: '.length).trim());
  assert.equal(last.notes.total, 1);
  assert.deepEqual(Object.keys(last).sort(), Object.keys(viaGet).sort());
});

check('一轮同步跑完广播一次；没人订阅时 pushUpdate 一个字节都不读库', async () => {
  const r = rig();
  await r.seed();
  assert.equal(await r.handler.pushUpdate(), null, '没人看却去摊一份快照 = 每轮同步白读一遍 2019 条');
  const { res } = await attach(r);
  const before = frames(res).length;
  await r.handler.pushUpdate();
  await flush(2);
  assert.equal(frames(res).length, before + 1);
  assert.ok(frames(res)[before].startsWith('event: update'));
});

check('SSE 的三种摘牌：客户端断开、心跳写失败、广播写失败', async () => {
  const r = rig();
  await r.seed();
  const { req, res } = await attach(r);
  req.emit('close');
  assert.equal(r.handler.hub.size, 0, '断开没摘牌：下一轮广播会往已死的连接里写');
  assert.equal(res.ended, true, '摘牌了却没 end，宿主那边一直挂着这条响应');

  const hub = createHub();
  const sink = makeRes();
  const sse = openSse(sink, {
    onBroken: () => hub.remove(client),
    setIntervalMod: (fn) => { sink.beat = fn; return { unref() {} }; },
    clearIntervalMod: () => {},
  });
  const client = { send: sse.send, close: sse.close };
  hub.add(client);
  assert.equal(hub.size, 1);
  sink.failNext = true;
  sink.beat();
  assert.equal(hub.size, 0, '心跳写失败要当场摘牌（留着就是一发没人接的 write）');
  hub.broadcast('update', { a: 1 });
  assert.equal(hub.size, 0);
});

check('dispose 关掉所有长连接（teardown 走的就是这一发）', async () => {
  const r = rig();
  await r.seed();
  const a = await attach(r);
  const b = await attach(r);
  assert.equal(r.handler.hub.size, 2);
  const writtenBefore = a.res.writes.length;
  r.handler.dispose();
  assert.equal(r.handler.hub.size, 0);
  assert.equal(a.res.ended, true);
  assert.equal(b.res.ended, true);
  assert.equal(await r.handler.pushUpdate(), null, '撤销后清单没清空：teardown 之后还在往已关的连接里写');
  await r.stores.notes.write({ slug: 'Weather::Alpha', category: 'Weather', purpose: '撤销后又写了一条', updatedAt: NOW });
  assert.equal(a.res.writes.length, writtenBefore, '撤销之后还收得到帧');
});

check('路由表 404 与 SSE 之间不串：/api/stream 只接受 GET', async () => {
  const r = rig();
  await r.seed();
  const res = (await post(r.handler, '/api/stream')).res;
  assert.equal(res.statusCode, 405);
});

/* ------------------------------------------------------------------ *
 * E 降级：存储侧的错不许伪装成"目录是空的"
 * ------------------------------------------------------------------ */

check('长连接的第一帧读不出：200 头已冲出去，原因塞进一帧 error 再关（不许走到外层 json(503)）', async () => {
  // openSse 在 writeHead 之后才读库；这时候再发一次头，在真宿主的 res 上就是 ERR_HTTP_HEADERS_SENT，
  // 而那个异常还会从路由的 catch 里逃逸出去。所以这一发只能有一帧 error + 一次 close。
  const stores = createAllStores({ getFacility: () => null });
  const handler = createApiHandler({
    stores,
    engine: createQueryEngine({ stores }),
    caps: { read: () => ({}), rows: () => [] },
    trigger: async () => ({}),
    sseTimers: { setIntervalMod: () => ({ unref() {} }), clearIntervalMod: () => {} },
  });
  const req = makeReq({ url: `${ROUTE_PREFIX}/api/stream` });
  const res = makeRes();
  await handler(req, res);
  await flush(3);
  assert.equal(res.head.statusCode, 200, '这一发的头只许有一回：写成 503 就是二次 writeHead');
  const errFrame = frames(res).find((w) => w.startsWith('event: error'));
  assert.ok(errFrame, `没把服务端的原因递上来：${res.writes.join(' | ')}`);
  assert.equal(JSON.parse(errFrame.slice(errFrame.indexOf('data:') + 5).trim()).code, 'STORAGE_UNAVAILABLE');
  assert.equal(res.ended, true, '报完原因这条连接要关掉');
  assert.equal(handler.hub.size, 0, '摘牌没做：下一轮同步会为一条已关的连接摊一份快照');
});

check('域不可用：GET 读路径 503，界面才知道该显示"存储这一侧没走通"', async () => {
  const stores = createAllStores({ getFacility: () => null });
  const handler = createApiHandler({
    stores,
    engine: createQueryEngine({ stores }),
    caps: { read: () => ({}), rows: () => [] },
    trigger: async () => ({}),
    sseTimers: { setIntervalMod: () => ({ unref() {} }), clearIntervalMod: () => {} },
  });
  for (const path of ['/api/snapshot', '/api/search', '/api/notes', '/api/changes', '/api/prefs', '/api/hosts']) {
    const res = await get(handler, path);
    assert.equal(res.statusCode, 503, `${path} 在域不可用时回了 ${res.statusCode}`);
    assert.equal(res.json().error.code, 'STORAGE_UNAVAILABLE');
  }
  const write = await post(handler, '/api/notes', { slug: 'x', category: 'y', purpose: 'p' });
  assert.equal(write.res.statusCode, 503, '写不进去也不能报 200');
  assert.equal(statusFor('STORAGE_UNAVAILABLE'), 503);
});

check('错误码到状态：409 与 403 用的是域里那一份，不是本地另写的数', async () => {
  assert.equal(statusFor(SYNC_BUSY.code), 409);
  assert.equal(statusFor('FORBIDDEN'), 403);
  assert.equal(statusFor('BAD_JSON'), 400);
  assert.equal(statusFor('没听过的码'), 500);
});

check('路由与全局键两侧同源：路径都带 /api，同一路径的方法互不重号', async () => {
  assert.equal(ROUTE_PREFIX, '/api-catalog');
  assert.equal(GLOBAL_KEY, '__API_CATALOG__');
  const keys = Object.keys(API_ROUTES);
  const byPath = new Map();
  for (const key of keys) {
    const [method, path] = key.split(' ');
    assert.ok(path.startsWith('/api/'), path);
    byPath.set(path, [...(byPath.get(path) || []), method]);
  }
  for (const [path, methods] of byPath) {
    assert.equal(new Set(methods).size, methods.length, `${path} 挂了两次同一种方法：405 与 404 会互相顶掉`);
  }
  // 同一路径带两种方法是**故意**的（GET /api/notes 与 POST /api/notes）：405 那一支靠的就是这张方法表。
  assert.deepEqual(byPath.get('/api/notes').sort(), ['GET', 'POST']);
  assert.deepEqual(byPath.get('/api/stream'), ['GET'], '长连接只接受 GET：POST 过来只能拿到 405，不许把流读掉再建连接');
});

/* ------------------------------------------------------------------ *
 * F 现译路由（S8）：secrets 只有 POST 能碰，回包里一个值都不许出现
 * ------------------------------------------------------------------ */

/**
 * 造一份真翻译服务（真 stores、假渠道 fetch）。
 * ★ 这里**不给 ctx**：createTranslateService 对缺 ctx 是按"宿主没给模型"处理，
 *   而这一节要验的是路由与载荷，不是渠道本身（渠道的判据在 test/translate.test.mjs）。
 */
function translateRig({ facility, prefs = {}, fetchImpl, getTransport } = {}) {
  const f = facility ?? makeFakeFacility();
  const holder = { ...DEFAULT_PREFS, ...prefs };
  const stores = createAllStores({ getFacility: () => f, now: () => NOW });
  const svc = createTranslateService({
    stores,
    getPrefs: () => holder,
    now: () => NOW,
    fetchImpl: fetchImpl ?? (async () => { throw new Error('这一节不发真请求'); }),
    ...(getTransport ? { getTransport } : {}),
  });
  return { f, stores, svc, holder };
}

check('GET /api/snapshot 的 translate 一格：没有服务就是 null，有服务时带状态/凭据摘要/计数，且**整份回包里没有凭据值**', async () => {
  const tr = translateRig();
  const r = rig({ facility: tr.f, translate: tr.svc });
  await r.seed();
  const snap = (await get(r.handler, '/api/snapshot')).json().data;
  assert.equal(snap.translate.channel, 'host_llm');
  assert.equal(snap.translate.enabled, false, '开关出厂是 false，载荷不许替用户打开它');
  assert.equal(snap.translate.busy, false);
  assert.deepEqual(snap.translate.counts, { rows: 0, ok: 0, failed: 0 });
  // 凭据摘要的形状从登记表派生：没填也要有格，界面才知道该显示「未配置」而不是"这一档不存在"
  assert.deepEqual(Object.keys(snap.translate.secrets).sort(), Object.keys(TRANS_CRED_FIELDS).sort());
  assert.deepEqual(snap.translate.secrets.baidu, { appid: { configured: false, chars: 0, at: 0 }, key: { configured: false, chars: 0, at: 0 } });
  const saved = (await post(r.handler, '/api/translate/secret', { channel: 'baidu', field: 'key', value: 'SECRET-VALUE-1234' })).res;
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().data.secrets.baidu.key.configured, true);
  assert.equal(saved.json().data.secrets.baidu.key.chars, 'SECRET-VALUE-1234'.length);
  assert.equal('value' in saved.json().data.secrets.baidu.key, false, '摘要里带了 value —— 界面上任何一处渲染都会把它抄出去');
  const body = JSON.stringify((await get(r.handler, '/api/snapshot')).json()) + JSON.stringify(saved.json());
  assert.equal(body.includes('SECRET-VALUE-1234'), false, '密钥原文出现在了任何一发 GET/POST 的回包里');
});

check('translate 一格缺服务时是 null，界面按"这一格没话"渲染（不许造一个默认形状）', async () => {
  const r = rig();
  await r.seed();
  const snap = (await get(r.handler, '/api/snapshot')).json().data;
  assert.equal(snap.translate, null);
});

check('凭据路由的入参闸门：没登记的渠道/字段是 400 参数错，不是 503「存储坏了」', async () => {
  const tr = translateRig();
  const r = rig({ facility: tr.f, translate: tr.svc });
  await r.seed();
  const badChannel = await post(r.handler, '/api/translate/secret', { channel: 'google', field: 'key', value: 'v' });
  assert.equal(badChannel.res.statusCode, 400);
  const badField = await post(r.handler, '/api/translate/secret', { channel: 'baidu', field: 'token', value: 'v' });
  assert.equal(badField.res.statusCode, 400);
  assert.ok(badField.res.json().error.message.includes('appid'), '报错要把这一档能填的字段念出来');
  // host_llm 没有凭据字段：递给它也是 400（不是"收下但没地方放"）
  const noNeed = await post(r.handler, '/api/translate/secret', { channel: 'host_llm', field: 'key', value: 'v' });
  assert.equal(noNeed.res.statusCode, 400);
  const blank = await post(r.handler, '/api/translate/secret', { channel: 'baidu', field: 'key', value: '   ' });
  assert.equal(blank.res.statusCode, 400, '一串空格被当成填过了 ⇒ 签名必然对不上，而界面显示「已配置」');
  const tooLong = await post(r.handler, '/api/translate/secret', { channel: 'baidu', field: 'key', value: 'x'.repeat(TRANS_CRED_MAX + 1) });
  assert.equal(tooLong.res.statusCode, 400);
  // 首尾空白存进去之前要抹掉：带空白的密钥永远签不对
  const padded = await post(r.handler, '/api/translate/secret', { channel: 'baidu', field: 'key', value: '  SECRET-PADDED  ' });
  assert.equal(padded.res.statusCode, 200);
  assert.equal(padded.res.json().data.secrets.baidu.key.chars, 'SECRET-PADDED'.length);
  assert.equal((await tr.stores.secrets.read('baidu', 'key')).value, 'SECRET-PADDED');
});

check('凭据清除：删掉之后摘要回到未配置，空串不当作删除（要删走 delete）', async () => {
  const tr = translateRig();
  const r = rig({ facility: tr.f, translate: tr.svc });
  await r.seed();
  await post(r.handler, '/api/translate/secret', { channel: 'baidu', field: 'appid', value: 'APPID-1' });
  const gone = await post(r.handler, '/api/translate/secret/delete', { channel: 'baidu', field: 'appid' });
  assert.equal(gone.res.statusCode, 200);
  assert.deepEqual(gone.res.json().data.secrets.baidu.appid, { configured: false, chars: 0, at: 0 });
  assert.equal(await tr.stores.secrets.read('baidu', 'appid'), null);
  const unknown = await post(r.handler, '/api/translate/secret/delete', { channel: 'baidu', field: 'nope' });
  assert.equal(unknown.res.statusCode, 400);
});

check('POST /api/translate/test 与 /run：把服务那两侧的返回原样带出，且不往 prefs 里写任何东西', async () => {
  const tr = translateRig({ prefs: { transEnabled: true, transChannel: 'baidu' } });
  const r = rig({ facility: tr.f, translate: tr.svc });
  await r.seed();
  // 没填凭据 ⇒ 两发都该在 readiness 那一层收口：一次请求都不发（fetchImpl 一被调就抛，抛了就是发了）
  const test = await post(r.handler, '/api/translate/test');
  assert.equal(test.res.statusCode, 200);
  assert.equal(test.res.json().data.result.ok, false);
  assert.equal(test.res.json().data.result.errKey, 'no_credential');
  assert.ok(test.res.json().data.result.note.length > 0, '失败没带话术，界面上就是"点了没反应"');
  const run = await post(r.handler, '/api/translate/run');
  assert.equal(run.res.statusCode, 200);
  assert.equal(run.res.json().data.result.skipped, 'no_credential');
  assert.equal(run.res.json().data.counts.rows, 0, '没发出去就不该有译文落库');
  assert.deepEqual(await r.stores.prefs.read(), DEFAULT_PREFS, '现译路由改了 prefs ⇒ 凭据那一侧的边界就不再成立了');
});

check('run 那一发要把 skipped 原样带回：busy 不写 lastPass，只看块里那份会把两件事说成一件', async () => {
  const tr = translateRig({ prefs: { transEnabled: true } });
  const seen = [];
  tr.svc.runPass = async ({ reason } = {}) => { seen.push(reason); return { reason, skipped: 'busy', startedAt: NOW }; };
  const r = rig({ facility: tr.f, translate: tr.svc });
  await r.seed();
  const res = (await post(r.handler, '/api/translate/run')).res;
  assert.equal(res.json().data.result.skipped, 'busy');
  assert.deepEqual(seen, ['manual'], '手动这一发的来路要标成 manual，界面才知道是谁点的');
  assert.equal(res.json().data.lastPass, null, 'lastPass 还没被写过，路由不许替它造一个');
});

/**
 * 出网传输层过路由层的那一套（S16c）。★ 形状照 index.js:185-196 的真装配：
 *   `fetchImpl: net.fetch` + `getTransport: () => net.describe()` —— 这两处只要一处变了，
 *   界面上那一行念的就不是"实际出去的那条路"（真机上表现为"它说明明走了代理，可我代理没开"）。
 * 假注册表与假隧道都是**注入**进去的：本条判据要的是"路由层原样搬运"，不是再测一遍 net.js（那 18 条在 test/net.test.mjs）。
 */
function netRig({ prefs = {}, env = {}, tunnel } = {}) {
  const facility = makeFakeFacility();
  const holder = { ...DEFAULT_PREFS, ...prefs };
  const stores = createAllStores({ getFacility: () => facility, now: () => NOW });
  const calls = { tunnels: 0, direct: 0 };
  const net = createNetTransport({
    getPrefs: () => holder,
    env,
    platform: 'win32',
    fetchFn: async () => { calls.direct += 1; throw new Error('走了直连'); },
    registryRead: async () => ({ ok: true, enabled: false, server: '', override: '', reason: '假注册表：系统代理是关的' }),
    tunnelRequestFn: async (url, opts) => {
      calls.tunnels += 1;
      const r = await tunnel(url, opts);
      return r;
    },
    now: () => NOW,
  });
  const svc = createTranslateService({
    stores, getPrefs: () => holder, now: () => NOW,
    fetchImpl: net.fetch, getTransport: () => net.describe(),
  });
  const r = rig({ facility, translate: svc });
  return { net, svc, holder, stores, r, calls };
}

const KEYLESS_FIXTURE = [[['有关英国公共图书馆的数据。', 'Data about public libraries in the UK.', null, null, null]], null, 'en'];
const keylessTunnelResponse = (url) => ({
  url, status: 200, ok: true, headers: { get: () => null },
  async text() { return JSON.stringify(KEYLESS_FIXTURE); },
  async json() { return KEYLESS_FIXTURE; },
});

check('「这一发从哪条路出去」过路由层：整句在宿主拼好、出去的是打码那一份；坏配置报「没能出网」而且直连与隧道都没被碰', async () => {
  const g = netRig({
    prefs: { transEnabled: true, transChannel: 'keyless', proxyMode: 'system' },
    env: { HTTPS_PROXY: 'http://user:pw@127.0.0.1:7897' },
    tunnel: async (url) => keylessTunnelResponse(url),
  });
  await g.r.seed();
  const body = (await post(g.r.handler, '/api/translate/test')).res.json().data;
  assert.equal(body.result.ok, true, `经隧道那一发没译出来：${JSON.stringify(body.result)}`);
  assert.equal(g.calls.tunnels, 1);
  assert.equal(g.calls.direct, 0, '环境变量给了代理，这一发却还去碰直连');

  const t = body.transport;
  assert.equal(t.via, 'proxy');
  assert.equal(t.source, 'env:HTTPS_PROXY', '来源要具体到哪一个环境变量（排障时"环境变量"四个字不够用）');
  assert.equal(t.proxy, 'http://127.0.0.1:7897', '代理地址没被拆成 host:port 那份 ⇒ 认证信息就跟着出进程边界了');
  // 整句是宿主拼的：这里逐字钉死，客户端那边只搬字（它一重排或补标点，两处口径就漂）。
  assert.equal(t.line, '经代理隧道 · 环境变量 HTTPS_PROXY · http://127.0.0.1:7897');
  const dump = JSON.stringify(body);
  const basic = Buffer.from('user:pw', 'utf8').toString('base64');
  for (const leak of ['user:pw', basic]) {
    assert.equal(dump.includes(leak), false, `代理凭据（${leak}）出现在了回包里：这一发是要进浏览器的`);
  }

  // 同一块在 GET /api/snapshot 那侧必须一模一样：首屏与「测试连接」按钮后面念的是两行不同的话就等于两套口径。
  const snap = (await get(g.r.handler, '/api/snapshot')).json().data;
  assert.equal(snap.transport === undefined, true, 'transport 只该长在 translate 那一块里，别在快照顶上再摆一份');
  assert.deepEqual(snap.translate.transport, t);

  // ★ 坏配置那一支：库里那一行是旧版/手工写坏的（现写侧的闸门已经进不来这种值），仲裁必须落 failed。
  //   判据不是"报了错"，而是**两路都没发** —— 偷偷回落直连会把"配了个不通的代理"伪装成"网络不通"。
  const bad = netRig({
    prefs: { transEnabled: true, transChannel: 'keyless', proxyMode: 'custom' },
    tunnel: async () => { throw new Error('坏配置还发了隧道'); },
  });
  await bad.r.seed();
  bad.holder.proxyUrl = 'socks5://127.0.0.1:1080';
  const badBody = (await post(bad.r.handler, '/api/translate/test')).res.json().data;
  assert.equal(bad.calls.tunnels, 0);
  assert.equal(bad.calls.direct, 0, '代理地址坏掉就悄悄改用直连：用户从此分不清"代理没生效"和"网不通"');
  assert.equal(badBody.result.ok, false);
  assert.equal(badBody.result.errKey, 'transport');
  assert.equal(badBody.transport.via, 'failed');
  assert.ok(badBody.transport.line.startsWith('没能出网：'), `那一行没把"没能出网"摆在最前：${badBody.transport.line}`);
  assert.ok(badBody.transport.line.includes('http://'), '原因要把"只支持 http:// 代理"念出来，否则用户不知道该怎么改');

  // 装配层没接传输层（或宿主那侧还没出网）时给 null，界面按"这一格没话"处理，不替它编一句"直连"。
  const plain = translateRig();
  const pr = rig({ facility: plain.f, translate: plain.svc });
  await pr.seed();
  assert.equal((await get(pr.handler, '/api/snapshot')).json().data.translate.transport, null);
});

check('transportView 的两种没话可说：route 缺位给 null，via 不认得就原样交回（界面不许猜一个翻译）', async () => {
  assert.equal(transportView(null), null);
  assert.equal(transportView(undefined), null);
  const v = transportView({ via: 'half-open', source: 'unknown-box', proxy: '', reason: '', targetHost: '', at: 0 });
  assert.equal(v.viaLabel, 'half-open', '没登记的 via 被翻成了一个认识的词：界面上就多了一条假话');
  assert.equal(v.sourceLabel, 'unknown-box');
  assert.equal(v.at, 0);
  // 空 source 那一支（还没出过网）走的是 idle 那句，而不是把空串拼进句子。
  assert.equal(transportView({ via: 'idle', source: '', proxy: '', reason: '', targetHost: '', at: 0 }).line,
    '还没出过网：点「测试连接」才知道走哪条路');
});

check('secrets 只有 POST 够得着：路由表里每一条 GET 的 handler 源码都不提它（表判据，新增 GET 自动被扫）', async () => {
  const getKeys = Object.keys(API_ROUTES).filter((k) => k.startsWith('GET '));
  const postKeys = Object.keys(API_ROUTES).filter((k) => k.startsWith('POST '));
  assert.ok(getKeys.length >= 7 && postKeys.length >= 7, `路由数量变了（GET ${getKeys.length} / POST ${postKeys.length}），本条的扫描面先自证非空`);
  for (const key of getKeys) {
    const src = API_ROUTES[key].handler.toString();
    assert.equal(/secrets/.test(src), false, `${key} 的 handler 里出现了 secrets —— 那就是浏览器半边能读到凭据的口子`);
  }
  const touching = postKeys.filter((k) => /secrets/.test(API_ROUTES[k].handler.toString()));
  assert.ok(touching.length >= 2, `POST 侧够得着 secrets 的路由只有 ${touching.length} 条：写入与清除至少各一条`);
  for (const k of touching) assert.equal(API_ROUTES[k].loopback, true, `${k} 能碰凭据却没声明回环门`);
});

check('四条现译路由全部声明回环门，路径都在 /api/translate 子树下', async () => {
  const keys = Object.keys(API_ROUTES).filter((k) => k.includes('/api/translate'));
  assert.equal(keys.length, 4, `现译路由是 ${keys.length} 条（预期 4：secret / secret/delete / test / run）`);
  for (const k of keys) {
    assert.ok(k.startsWith('POST '), `${k} 不是 POST：能改凭据的接口不许有读语义`);
    assert.equal(API_ROUTES[k].loopback, true, `${k} 没声明回环门`);
  }
});

await runAll('api');
