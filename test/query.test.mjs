/**
 * test/query.test.mjs —— 读侧查询（lib/query.js，spec §6 与 §7 第 2 层）。
 *
 * 判据取向：
 *   A 真数据读数：两档预设（现用 CN 源 673/212，降级用的英文源 963/450）、facet 三列分布、同 host 聚合前三
 *     —— 这些数字是 spec §9.1 / §9.1s 的实测，查询层任何一次"顺手改归一化"都会把它们挪走，所以逐字钉住而不是钉个 >0。
 *   B 打分与过滤：四档次序、多词 AND、limit/truncated、hidden/starred、category/host/facet。
 *   B2 行内中文的两层 join（S9）：内置表优先、现译带渠道与时刻、两层都没有就是空串（绝不拿英文顶上）。
 *   C 派生文案（§7 第 2 层）：三种 unknown 状态各有一句，且不许把 unknown 说成 Yes 或 No。
 *   D 引擎：按 sha 缓存、域不可用时如实 reject（不静默转空集——那会把"存储坏了"伪装成"目录是空的"）。
 */
import { check, runAll, assert, makeFakeFacility, fixture } from './_helpers.mjs';
import { parseCatalog } from '../lib/parse.js';
import {
  SEARCH_LIMIT_MAX, SEARCH_DEFAULT_LIMIT, SEARCH_OFFSET_MAX, NOTE_PURPOSE_MAX_LEN,
  transZhLabel,
} from '../lib/domain.js';
import { DESC_ZH_LABEL } from '../lib/desc-zh.js';
import { USAGE } from '../lib/usage.js';
import { buildIndex, norm, tokenize, scoreRecord, SCORE, facetCounts, presetCounts, hostGroups, searchRecords, noteRows, derivePurpose, zhForDesc, createQueryEngine } from '../lib/query.js';
import { createAllStores } from '../lib/stores.js';
import { CATEGORY_ZH, categoryLabel } from '../lib/categories.js';
import { KEY_RULE_VERSION } from '../lib/keys.js';

const README = await fixture('public-apis-README.md');
const CNREADME = await fixture('public-apis-cn-README.md');
const parsed = parseCatalog(README);
const cnParsed = parseCatalog(CNREADME);
const NOW = 1777000000000;

/**
 * 把 parse 的产物钳成**库里的形状**（少 line/categoryLine，多 firstSeenAt/lastSeenAt）。
 * ★ 不这么做，查询层收到的就是"带着行号的条目"，界面字段那一条断言会被这个假形状圆掉 ——
 *   真库里根本没有 line（record() 丢弃未声明字段），行号是某一份 README 的坐标。
 */
function storedItem(e) {
  return {
    slug: e.slug, name: e.name, url: e.url, host: e.host, desc: e.desc,
    auth: e.auth, https: e.https, cors: e.cors, category: e.category,
    firstSeenAt: NOW, lastSeenAt: NOW,
  };
}
const recs = buildIndex(parsed.entries.map(storedItem));
const cnRecs = buildIndex(cnParsed.entries.map(storedItem));

/**
 * 手工 records：同一个词 'api' 在四档各命中一次，凑出一条**端到端**的档位序
 * （真数据里凑不出这种形状：上游的 name 太有个性，四档同时可比只能自己造样本）。
 */
const tiered = buildIndex([
  { slug: 't1', name: 'ApiZap', desc: 'd', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' },
  { slug: 't2', name: 'The Api Hub', desc: 'd', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' },
  { slug: 't3', name: 'News', desc: 'api gateway', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' },
  { slug: 't4', name: 'Else', desc: 'd', host: 'api.example', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' },
]);

/* ------------------------------------------------------------------ *
 * A 真数据读数
 * ------------------------------------------------------------------ */

check('两档预设的实读数逐字命中 spec §9.1：免 key 963、浏览器直连 450', () => {
  assert.deepEqual(presetCounts(recs), { 'no-key': 963, 'browser-direct': 450 });
});

check('现用源（public-apis-cn）上的读数：免 key 673 / 浏览器直连 212，unknown 那三格也各归各的', () => {
  // 2026-10-07 换源裁定后，界面上那两枚芯片和三个 facet 组走的是这份读数；
  // 英文那份留在链上只当降级源，所以它的 963/450 不能再当成"当前数字"念给用户。
  assert.deepEqual(presetCounts(cnRecs), { 'no-key': 673, 'browser-direct': 212 });
  const f = facetCounts(cnRecs);
  assert.deepEqual(f.auth, { No: 673, apiKey: 663, OAuth: 149, 'X-Mashape-Key': 6, 'User-Agent': 1, unknown: 2 });
  assert.deepEqual(f.https, { Yes: 1399, No: 94, unknown: 1 });
  assert.deepEqual(f.cors, { Yes: 403, No: 118, unknown: 973 });
  assert.equal(f.category.length, 54);
  assert.equal(f.category.reduce((s, c) => s + c.count, 0), 1494);
  // 分类名本身就是中文 ⇒ CATEGORY_ZH 那张表在这里不参与，界面回落成上游写的那个名字（不许猜译）。
  assert.equal(categoryLabel('动物'), '');
  assert.ok(f.category.some((c) => c.name === '国内物流'), 'CN 特有的分类没进清单');
});

check('facet 三列分布与分类清单跟 S1 台账一致（2019 / 51 类）', () => {
  const f = facetCounts(recs);
  assert.deepEqual(f.auth, { No: 963, apiKey: 898, OAuth: 150, 'X-Mashape-Key': 6, 'User-Agent': 2 });
  assert.deepEqual(f.https, { Yes: 1931, No: 88 });
  assert.deepEqual(f.cors, { No: 227, Yes: 775, unknown: 1017 });
  assert.equal(f.category.length, 51);
  assert.equal(f.category.reduce((s, c) => s + c.count, 0), 2019, '分类计数加起来必须等于总条数');
  assert.ok(f.category.every((c, i, a) => i === 0 || a[i - 1].name.localeCompare(c.name) <= 0), '分类清单没按名字排');
  // 中文标签（2026-10-05 裁定：中文 + 原文小字并列）：51 类必须全配齐，漏一类就是那一类在界面上悄悄只剩原文。
  assert.equal(Object.keys(CATEGORY_ZH).length, 51, '标签表的条数不是 51（上游改分类时这里要先对账）');
  assert.deepEqual(f.category.filter((c) => !c.label).map((c) => c.name), [], '有分类没配上中文标签');
  const books = f.category.find((c) => c.name === 'Books');
  assert.equal(books.label, '图书');
  assert.equal(books.name, 'Books', '原文不许被中文顶掉：主键、导出、详情用的都是它');
});

check('分类标签查不到就回空串（不是回原文）：界面据此决定要不要那行小字', () => {
  assert.equal(categoryLabel('Books'), '图书');
  assert.equal(categoryLabel('  Books  '), '图书', '上游偶尔带空格，不该因此掉进"没标签"那支');
  assert.equal(categoryLabel('Not A Category'), '');
  assert.equal(categoryLabel(undefined), '');
  const f = facetCounts(buildIndex([{ slug: 'C::A', name: 'A', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' }]));
  assert.deepEqual(f.category, [{ name: 'C', label: '', count: 1 }], '没配上的分类必须把原文留给界面，而不是自己编一个中文');
});

check('facet 候选取自库里实际值：字段整个缺列的那几条兜底成 unknown，仍要能筛出来', () => {
  // 真 README 里每个字段都有值（parse 把缺格写成 'unknown'），所以 ?? UNKNOWN 这一支在 2019 条上永不触发
  // —— 用手工样本钉住：库里躺着一行缺列的（旧键规则残留 / 上游表结构变了），它不许从筛选清单上消失。
  const odd = buildIndex([
    { slug: 'o1', name: 'A', desc: '', host: 'h', category: 'C', https: 'Yes' },
    { slug: 'o2', name: 'B', desc: '', host: 'h', category: 'C', auth: 'OAuth-2', https: 'Yes', cors: 'maybe' },
  ]);
  const f = facetCounts(odd);
  assert.deepEqual(f.auth, { unknown: 1, 'OAuth-2': 1 });
  assert.deepEqual(f.cors, { unknown: 1, maybe: 1 });
  const picked = searchRecords({ records: odd, facets: { auth: ['unknown'] } });
  assert.deepEqual(picked.rows.map((r) => r.slug), ['o1'], '按 unknown 筛不出缺列那一条 = 它永远只能被看见一次都筛不出来');
});

check('同 host 聚合：github 112 / rapidapi 24 / google 17，且散在多个分类才进这一栏', () => {
  const h = hostGroups(recs);
  assert.deepEqual(h.rows.slice(0, 3).map((r) => [r.host, r.count]), [['github.com', 112], ['rapidapi.com', 24], ['developers.google.com', 17]]);
  assert.equal(h.total, 34, '实测过 HOST_AGG_MIN 的供应商家数');
  assert.ok(h.rows[0].categories.length > 1);
  assert.ok(h.rows.every((r) => r.count >= 2), '单条的供应商混进来了：那一栏的信号会被淹掉');
  const top = hostGroups(recs, { top: 5 });
  assert.equal(top.rows.length, 5);
  assert.equal(top.truncated, true, '截断了却不标 truncated，界面就会说"一共 5 家"');
  assert.equal(top.total, h.total);
});

/* ------------------------------------------------------------------ *
 * B 归一化 / 打分 / 过滤
 * ------------------------------------------------------------------ */

check('norm：大小写与 - _ 空格 一律抹平，中文与数字原样留着', () => {
  assert.equal(norm('Open-API'), 'openapi');
  assert.equal(norm('Open API'), 'openapi');
  assert.equal(norm('open_api'), 'openapi');
  assert.equal(norm(' 天气API '), '天气api');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
});

check('tokenize：按空白切词并逐词 norm，空串不占位', () => {
  assert.deepEqual(tokenize('  open   API '), ['open', 'api']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   '), []);
});

check('打分四档严格有序：name 前缀 > name 词中 > desc > host（同一个词、端到端一条序）', () => {
  const bySlug = new Map(tiered.map((r) => [r.item.slug, r]));
  assert.equal(scoreRecord(bySlug.get('t1'), ['api']), SCORE.NAME_PREFIX, 'name 开头必须是最高档');
  assert.equal(scoreRecord(bySlug.get('t2'), ['api']), SCORE.NAME, '词中要能跨分隔符命中（name 里是 "The Api Hub"）');
  assert.equal(scoreRecord(bySlug.get('t3'), ['api']), SCORE.DESC);
  assert.equal(scoreRecord(bySlug.get('t4'), ['api']), SCORE.HOST);
  const r = searchRecords({ records: tiered, query: 'api', limit: 10 });
  assert.deepEqual(r.rows.map((x) => x.slug), ['t1', 't2', 't3', 't4'], '结果序没按档位排');
  assert.deepEqual(r.rows.map((x) => x.score), [SCORE.NAME_PREFIX, SCORE.NAME, SCORE.DESC, SCORE.HOST]);
});

check('多词 AND：任何一词没命中就整条出局，不是"命中多的排前面"', () => {
  const bySlug = new Map(tiered.map((r) => [r.item.slug, r]));
  assert.equal(scoreRecord(bySlug.get('t3'), ['api', 'nonexistent']), 0);
  const r = searchRecords({ records: tiered, query: 'api news', limit: 10 });
  assert.deepEqual(r.rows.map((x) => x.slug), ['t3'], 'AND 变成了 OR');
});

check('中文查询按子串命中（上游全英文，这条只能靠手工样本自证）', () => {
  const zh = buildIndex([{ slug: 'z', name: '某个天气接口', desc: '提供预报', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' }]);
  assert.equal(searchRecords({ records: zh, query: '天气' }).total, 1);
  assert.equal(searchRecords({ records: zh, query: '预报' }).total, 1);
  assert.equal(searchRecords({ records: zh, query: '猫' }).total, 0);
});

check('limit：默认 100、上限 200、非法值回落默认，并如实带 total 与 truncated', () => {
  assert.equal(searchRecords({ records: recs }).rows.length, SEARCH_DEFAULT_LIMIT);
  const capped = searchRecords({ records: recs, limit: 99999 });
  assert.equal(capped.rows.length, SEARCH_LIMIT_MAX);
  assert.equal(capped.total, 2019);
  assert.equal(capped.truncated, true);
  assert.equal(searchRecords({ records: recs, limit: 0 }).rows.length, SEARCH_DEFAULT_LIMIT, 'limit=0 不能变成"一条都不给"');
  assert.equal(searchRecords({ records: recs, limit: 'abc' }).rows.length, SEARCH_DEFAULT_LIMIT);
  const small = searchRecords({ records: recs, limit: 3 });
  assert.equal(small.truncated, true);
  assert.equal(searchRecords({ records: recs, query: 'nonexistentxyz' }).truncated, false);
});

check('过滤三样各自成立：category 精确、host 精确、facet 数组是多选', () => {
  assert.equal(searchRecords({ records: recs, category: 'Weather' }).total, 43);
  assert.equal(searchRecords({ records: recs, host: 'github.com' }).total, 112);
  assert.equal(searchRecords({ records: recs, facets: { auth: ['No'], cors: 'Yes', https: 'Yes' } }).total, 450, 'facet 组合必须等于「浏览器直连」预设的数');
  assert.equal(searchRecords({ records: recs, facets: { auth: ['No', 'OAuth'] } }).total, 963 + 150);
  assert.equal(searchRecords({ records: recs, facets: { auth: [] } }).total, 2019, '空数组是"不限"，不是"匹配空"');
  // 组合条件跟"在原始数据上直接数一遍"对账：查询层与夹具各走各的路，数到同一个数才算过。
  assert.equal(searchRecords({ records: recs, category: 'Weather', facets: { auth: 'No' } }).total,
    parsed.entries.filter((e) => e.category === 'Weather' && e.auth === 'No').length);
});

check('hidden 只从浏览态藏起来：带 query 的显式搜索仍然要出', () => {
  const list = buildIndex([{ slug: 'h1', name: 'Hidden Api', desc: 'd', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' },
    { slug: 'h2', name: 'Shown Api', desc: 'd', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' }]);
  const notes = new Map([['h1', { slug: 'h1', category: 'C', hidden: true, starred: false, tags: [], updatedAt: NOW }]]);
  assert.deepEqual(searchRecords({ records: list, notes }).rows.map((r) => r.slug), ['h2']);
  assert.deepEqual(searchRecords({ records: list, notes, query: 'hidden' }).rows.map((r) => r.slug), ['h1'], '显式搜索把隐藏条目吞了 = 用户以为上游删了它');
  assert.deepEqual(searchRecords({ records: list, notes, includeHidden: true }).rows.map((r) => r.slug), ['h1', 'h2']);
});

check('starred 只影响浏览态次序，不掺进相关度排序', () => {
  const list = buildIndex([{ slug: 's1', name: 'Aaa', desc: 'weather', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' },
    { slug: 's2', name: 'Zzz', desc: 'weather', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' }]);
  const notes = new Map([['s2', { slug: 's2', category: 'C', starred: true, tags: [], updatedAt: NOW }]]);
  assert.deepEqual(searchRecords({ records: list, notes }).rows.map((r) => r.slug), ['s2', 's1']);
  assert.deepEqual(searchRecords({ records: list, notes, query: 'weather' }).rows.map((r) => r.slug), ['s1', 's2'],
    '同分时按名字排，置顶不许插进结果里');
});

check('结果行只带界面要的那几样，库里多出来的字段不往外漏', () => {
  const [row] = searchRecords({ records: recs, query: 'JSONPlaceholder', limit: 1 }).rows;
  assert.ok(row.note === null || typeof row.note === 'object');
  // 中文那几格从 zhForDesc 的返回**派生**：给它改名时这条判据跟着走，不会出现「测试钉旧名、界面读新名」的假绿。
  const zhKeys = Object.keys(zhForDesc(''));
  assert.deepEqual([...zhKeys].sort(), ['descZh', 'descZhAt', 'descZhChannel', 'descZhFrom', 'descZhLabel'],
    `zhForDesc 的形状不是这五格（${zhKeys.join('/')}），派生出的清单不可信`);
  assert.deepEqual(Object.keys(row).sort(),
    ['auth', 'category', 'cors', 'desc', 'derived', 'firstSeenAt', 'host', 'https', 'lastSeenAt', 'name', 'note', 'score', 'slug', 'url', ...zhKeys].sort());
  assert.ok(row.derived.length >= 1, '派生句一条都没有，说明 §7 第 2 层没接上');
});

/* ------------------------------------------------------------------ *
 * B2 行内中文的两层 join（S9：内置离线表 → 本机现译表 → 没有中文）
 * ------------------------------------------------------------------ */

check('zhForDesc：内置命中记 builtin，现译命中带渠道与时刻，两层都没有就是空串（绝不拿英文顶上）', () => {
  const builtinHit = recs.find((r) => zhForDesc(r.item.desc).descZhFrom === 'builtin');
  assert.ok(builtinHit, '真 README 里一句都没命中内置表 ⇒ 回填表根本没接进读侧，下面这些断言全是空的');
  const mine = 'A sentence that cannot possibly be in the shipped table.';
  const transMap = new Map([[mine, { zh: '现译好的一句', channel: 'baidu', at: NOW }]]);
  const b = zhForDesc(builtinHit.item.desc);
  assert.deepEqual(b, {
    descZh: b.descZh, descZhFrom: 'builtin', descZhLabel: DESC_ZH_LABEL, descZhChannel: '', descZhAt: 0,
  });
  assert.ok(b.descZh, '内置命中的那格是空的');
  assert.notEqual(b.descZh, builtinHit.item.desc, '内置那一格把原文当译文交出来 = 指鹿为马');
  const t = zhForDesc(mine, transMap);
  assert.equal(t.descZhFrom, 'trans');
  assert.equal(t.descZh, '现译好的一句');
  assert.equal(t.descZhChannel, 'baidu');
  assert.equal(t.descZhAt, NOW, '时刻没带出去，界面就落不了款（这句是谁在什么时候译的）');
  // 落款在服务端拼好（界面不许自己攒格式）：加一档渠道或改一句日期都不用动浏览器半边
  assert.equal(t.descZhLabel, transZhLabel('baidu', NOW), '现译那一档的落款不是 domain 拼的那句');
  const none = zhForDesc('Another invented line with no Chinese anywhere.', transMap);
  assert.deepEqual(none, { descZh: '', descZhFrom: '', descZhLabel: '', descZhChannel: '', descZhAt: 0 });
  assert.deepEqual(zhForDesc('   '), { descZh: '', descZhFrom: '', descZhLabel: '', descZhChannel: '', descZhAt: 0 }, '空描述不该造出一格假中文');
  assert.deepEqual(zhForDesc(null), { descZh: '', descZhFrom: '', descZhLabel: '', descZhChannel: '', descZhAt: 0 });
});

check('zhForDesc 的归一化与键那侧同式：换行与多空格不能把命中打成未命中', () => {
  const clean = recs.find((r) => zhForDesc(r.item.desc).descZhFrom === 'builtin');
  const messy = `  ${String(clean.item.desc).replace(' ', '   \n ')}  `;
  assert.equal(zhForDesc(messy).descZh, zhForDesc(clean.item.desc).descZh,
    '同一句原文只是空白不同就取不到中文 —— 与 lib/keys.js 的 transKey、lib/desc-zh.js 的口径不一致了');
});

check('内置表优先于现译表：同一句两层都有时用内置那份，落款也不许署成现译', () => {
  const hit = recs.find((r) => zhForDesc(r.item.desc).descZhFrom === 'builtin');
  const src = String(hit.item.desc).replace(/\s+/g, ' ').trim();
  const transMap = new Map([[src, { zh: '另一句中文', channel: 'host_llm', at: NOW }]]);
  const r = zhForDesc(src, transMap);
  assert.equal(r.descZhFrom, 'builtin', '现译表把内置表盖掉了：随发版走的那一份才是默认答案');
  assert.notEqual(r.descZh, '另一句中文');
  assert.equal(r.descZhChannel, '', '命中内置表却带了渠道，界面上就会出现「内置的译文 · 现译 · 百度」这种落款');
  assert.equal(r.descZhLabel, DESC_ZH_LABEL, '界面上落款读的是 descZhLabel：这一格署成现译就等于名字里那句话没落地');
});

check('searchRecords 把中文补进行里：不传 transMap 只走内置表，传了才认现译', () => {
  const hit = recs.find((r) => zhForDesc(r.item.desc).descZhFrom === 'builtin');
  const mine = 'Yet another line that the shipped table does not carry.';
  const records = buildIndex([
    { slug: 'A::Alpha', name: 'Alpha', desc: hit.item.desc, host: 'a.example', url: 'https://a.example/', category: 'A', auth: 'No', https: 'Yes', cors: 'Yes' },
    { slug: 'B::Beta', name: 'Beta', desc: mine, host: 'b.example', url: 'https://b.example/', category: 'B', auth: 'No', https: 'Yes', cors: 'Yes' },
  ]);
  const bare = searchRecords({ records, limit: 10 }).rows;
  assert.equal(bare.find((r) => r.slug === 'A::Alpha').descZhFrom, 'builtin');
  assert.equal(bare.find((r) => r.slug === 'B::Beta').descZh, '', '没传现译映射却冒出了中文 = 凭空造的');
  assert.ok(bare.find((r) => r.slug === 'B::Beta').desc, '没中文时原文必须还在，界面显示英文原句而不是空白');
  const withTrans = searchRecords({ records, limit: 10, transMap: new Map([[mine, { zh: '补上的一句', channel: 'baidu', at: NOW }]]) }).rows;
  const b = withTrans.find((r) => r.slug === 'B::Beta');
  assert.equal(b.descZh, '补上的一句');
  assert.equal(b.descZhFrom, 'trans');
  assert.equal(withTrans.find((r) => r.slug === 'A::Alpha').descZh, bare.find((r) => r.slug === 'A::Alpha').descZh,
    '现译表不该改动内置命中的那一行');
});

check('noteRows 挂着的条目也带中文：笔记页与结果页不许一个有一个没有', () => {
  const hit = recs.find((r) => zhForDesc(r.item.desc).descZhFrom === 'builtin');
  const records = buildIndex([
    { slug: 'A::Alpha', name: 'Alpha', desc: hit.item.desc, host: 'a.example', url: 'https://a.example/', category: 'A', auth: 'No', https: 'Yes', cors: 'Yes' },
  ]);
  const notes = new Map([['A::Alpha', { slug: 'A::Alpha', category: 'A', purpose: 'p', tags: [], starred: true, hidden: false, orphan: false, updatedAt: NOW }]]);
  const [row] = noteRows({ records, notes });
  assert.equal(row.entry.descZhFrom, 'builtin');
  assert.ok(row.entry.descZh, '条目挂着却取不到中文');
  const [orphan] = noteRows({ records: [], notes });
  assert.equal(orphan.entry, null, '接不上条目却挂着中文 = 造出来的那一句');
});

/* ------------------------------------------------------------------ *
 * C 派生文案（§7 第 2 层）
 * ------------------------------------------------------------------ */

check('派生句：三种未列状态各有一句，且绝不把 unknown 说成 Yes 或 No', () => {
  assert.deepEqual(derivePurpose({ auth: 'No', https: 'Yes', cors: 'Yes' }), ['无需鉴权']);
  assert.deepEqual(derivePurpose({ auth: 'apiKey', https: 'Yes', cors: 'Yes' }), ['需注册取 key，方式为 需 API key']);
  assert.deepEqual(derivePurpose({ auth: 'X-Mashape-Key', https: 'Yes', cors: 'Yes' }), ['需注册取 key，方式为 需 X-Mashape-Key 头']);
  assert.deepEqual(derivePurpose({ auth: 'unknown', https: 'Yes', cors: 'Yes' }), ['鉴权方式未列']);
  assert.deepEqual(derivePurpose({ auth: 'No', https: 'No', cors: 'No' }),
    ['无需鉴权', '浏览器不能直连（需服务端代理）', '不支持 HTTPS：仍是明文，生产别用']);
  assert.deepEqual(derivePurpose({ auth: 'No', https: 'unknown', cors: 'unknown' }),
    ['无需鉴权', 'CORS 未知，别假设能直连'], 'CORS 未列被说成能直连或不能直连都是谎报');
  assert.deepEqual(derivePurpose({}), ['鉴权方式未列', 'CORS 未知，别假设能直连']);
});

/* ------------------------------------------------------------------ *
 * D 批注视图
 * ------------------------------------------------------------------ */

function note(slug, over = {}) {
  return { slug, category: 'C', purpose: `p-${slug}`, tags: [], starred: false, hidden: false, orphan: false, updatedAt: NOW, ...over };
}

check('noteRows 三视图：全部 / starred / tags / orphan，且 orphan 认"库里已经没有这条"这一支', () => {
  const list = buildIndex([{ slug: 'n1', name: 'One', desc: 'd', host: 'h', category: 'C', auth: 'No', https: 'Yes', cors: 'Yes' }]);
  const notes = new Map([
    ['n1', note('n1', { tags: ['常用'] })],
    ['n2', note('n2', { starred: true, updatedAt: NOW + 5 })],
    ['n3', note('n3', { orphan: true, name: 'Gone But Named', updatedAt: NOW + 9 })],
  ]);
  assert.deepEqual(noteRows({ records: list, notes }).map((r) => r.slug), ['n2', 'n3', 'n1'], '批注视图按 置顶 → 最近修改 排');
  assert.deepEqual(noteRows({ records: list, notes, view: 'starred' }).map((r) => r.slug), ['n2']);
  assert.deepEqual(noteRows({ records: list, notes, view: 'tags' }).map((r) => r.slug), ['n1']);
  assert.deepEqual(noteRows({ records: list, notes, view: 'orphan' }).map((r) => r.slug), ['n2', 'n3'],
    '条目已经从库里消失的批注也算 orphan（界面要能回答"这条笔记还接得上吗"）');
  const rows = noteRows({ records: list, notes });
  assert.equal(rows.find((r) => r.slug === 'n1').entry.name, 'One');
  assert.equal(rows.find((r) => r.slug === 'n3').entry, null, 'orphan 那条不许挂着别人的条目');
  // name 快照要原样带出去：orphan 那一行界面只剩这一份能显示人话（缺这个键的旧行回落 ''，不报错）
  assert.equal(rows.find((r) => r.slug === 'n3').name, 'Gone But Named');
  assert.equal(rows.find((r) => r.slug === 'n1').name, '', '旧库里没这个键的行不该把 undefined 递给界面');
  assert.deepEqual(noteRows({ records: [], notes: new Map() }), []);
});

/* ------------------------------------------------------------------ *
 * E 引擎：缓存与降级
 * ------------------------------------------------------------------ */

function rig({ withMeta = true, at = NOW } = {}) {
  const facility = makeFakeFacility();
  const stores = createAllStores({ getFacility: () => facility, now: () => at });
  const reads = { items: 0 };
  const orig = stores.entries.readAllItems;
  stores.entries.readAllItems = () => { reads.items += 1; return orig(); };
  if (withMeta) {
    // meta 的 sha 是缓存键，也是「这一份索引对应哪一份快照」的唯一凭据。
    stores.meta.patch({ keyRule: KEY_RULE_VERSION, sha: 'sha-a', lastStatus: 'success', total: 2, fetchedAt: at, lastCheckedAt: at });
  }
  const engine = createQueryEngine({ stores });
  return { facility, stores, engine, reads, at };
}

check('引擎：库里两条分类行摊平后就是查询域，数字与纯函数一致', async () => {
  const { stores, engine } = rig();
  await stores.entries.writeMany([
    { category: 'Weather', updatedAt: NOW, items: [{ slug: 'Weather::A', name: 'Alpha Weather', desc: 'd', host: 'a.example', url: 'https://a.example/', auth: 'No', https: 'Yes', cors: 'Yes', category: 'Weather', firstSeenAt: NOW, lastSeenAt: NOW }] },
    { category: 'Books', updatedAt: NOW, items: [{ slug: 'Books::B', name: 'Beta Books', desc: 'weather in books', host: 'b.example', url: 'https://b.example/', auth: 'apiKey', https: 'No', cors: 'unknown', category: 'Books', firstSeenAt: NOW, lastSeenAt: NOW }] },
  ]);
  const snap = await engine.snapshot();
  assert.equal(snap.index.total, 2);
  assert.equal(snap.index.categories, 2);
  assert.equal(snap.index.sha, 'sha-a');
  assert.deepEqual(snap.presets, { 'no-key': 1, 'browser-direct': 1 });
  assert.equal(snap.result.total, 2);
  assert.equal(snap.meta.lastStatus, 'success');
  assert.equal((await engine.search({ query: 'weather' })).total, 2);
  assert.equal((await engine.search({ query: 'weather' })).rows[0].name, 'Alpha Weather', 'name 命中要压过 desc 命中');
  assert.equal((await engine.facets()).facets.category.length, 2);
  assert.deepEqual((await engine.hosts()).rows, [], '各出现一次的供应商不该进聚合栏（HOST_AGG_MIN 的门槛）');
  assert.deepEqual((await engine.hosts({ min: 1 })).rows.map((r) => r.host), ['a.example', 'b.example']);
});

check('引擎：同一个 sha 只读一次库，sha 变了立刻重建（缓存不许拖住旧快照）', async () => {
  const { stores, engine, reads } = rig();
  await stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [] }]);
  assert.equal((await engine.info()).total, 0);
  assert.equal((await engine.info()).total, 0);
  assert.equal(reads.items, 1, `同一份快照读了 ${reads.items} 遍库`);
  await stores.meta.patch({ sha: 'sha-b' });
  await stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [{ slug: 'Weather::C', name: 'Gamma', desc: 'd', host: 'g', url: 'https://g/', auth: 'No', https: 'Yes', cors: 'Yes', category: 'Weather', firstSeenAt: NOW, lastSeenAt: NOW }] }]);
  assert.equal((await engine.info()).total, 1, 'sha 变了却没重建索引');
  engine.invalidate();
  assert.equal((await engine.info()).total, 1);
  assert.equal(reads.items, 3, 'invalidate 之后应当再读一次库');
});

check('引擎：库里没数据是"空的"，不是"坏的"（sha 空串也建索引，不抛）', async () => {
  const { engine } = rig({ withMeta: false });
  const snap = await engine.snapshot();
  assert.equal(snap.meta, null);
  assert.equal(snap.index.total, 0);
  assert.deepEqual(snap.presets, { 'no-key': 0, 'browser-direct': 0 });
  assert.equal('hosts' in snap, false,
    '同 host 聚合不再进快照（2026-10-05 裁定：目录页那块是多此一举）：载荷里养一段没人读的数，就是让每轮推流替一个不存在的界面占地方');
  assert.equal(snap.result.truncated, false);
});

check('引擎：存储域不可用要 reject 并带上原码，不许静默转成空目录', async () => {
  const stores = createAllStores({ getFacility: () => null });
  const engine = createQueryEngine({ stores });
  const err = await engine.snapshot().then(() => null, (e) => e);
  assert.ok(err, '域不可用时 snapshot 必须 reject，不能回一份"看起来正常"的空快照');
  assert.equal(typeof err.code, 'string');
  assert.ok(err.code.length > 0);
});

check('引擎：entry(slug) 命中给条目 + 批注 + 派生句，不命中给 null', async () => {
  const { stores, engine } = rig();
  await stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [{ slug: 'Weather::A', name: 'Alpha Weather', desc: 'd', host: 'a.example', url: 'https://a.example/', auth: 'No', https: 'No', cors: 'No', category: 'Weather', firstSeenAt: NOW, lastSeenAt: NOW }] }]);
  await stores.notes.write({ slug: 'Weather::A', category: 'Weather', purpose: '留着做天气聚合', tags: ['常用'], starred: true, updatedAt: NOW });
  const hit = await engine.entry('Weather::A');
  assert.equal(hit.name, 'Alpha Weather');
  assert.equal(hit.note.purpose, '留着做天气聚合');
  assert.deepEqual(hit.derived, ['无需鉴权', '浏览器不能直连（需服务端代理）', '不支持 HTTPS：仍是明文，生产别用']);
  assert.equal(await engine.entry('没有这一条'), null);
});

check('用法层：entry 带那份抽出来的规范（命中给整份、没登记给 null），列表行一条都不带', async () => {
  // 键从表里现取，不写死某一家：重跑构建脚本换了批次也不该把这条判据弄红（红过两次就会被人改成 >0 那种废断言）。
  const COVERED = Object.keys(USAGE)[0];
  const { stores, engine } = rig();
  await stores.entries.writeMany([{ category: 'Data', updatedAt: NOW, items: [
    { slug: 'Data::Covered', name: 'Covered', desc: 'd', host: 'x', url: COVERED, auth: 'apiKey', https: 'Yes', cors: 'Yes', category: 'Data', firstSeenAt: NOW, lastSeenAt: NOW },
    // 同一家的另一种写法：库里存的 url 常带尾斜杠，取键必须走同一条归一化，否则"抓到了却显示不出"。
    { slug: 'Data::Slashed', name: 'Slashed', desc: 'd', host: 'x', url: `${COVERED}/  `, auth: 'No', https: 'Yes', cors: 'Yes', category: 'Data', firstSeenAt: NOW, lastSeenAt: NOW },
    { slug: 'Data::Plain', name: 'Plain', desc: 'd', host: 'y', url: 'https://目录里没有这一家.example/', auth: 'No', https: 'Yes', cors: 'Yes', category: 'Data', firstSeenAt: NOW, lastSeenAt: NOW },
  ] }]);
  const hit = await engine.entry('Data::Covered');
  assert.deepEqual(hit.usage, USAGE[COVERED], '用法层不是表里那一份（中间被人改写过？）');
  assert.equal((await engine.entry('Data::Slashed')).usage.spec, USAGE[COVERED].spec, '尾斜杠/空白换了形就取不到 ⇒ 键的口径有两份');
  assert.equal((await engine.entry('Data::Plain')).usage, null, '目录里没登记的条目回的不是 null（界面会摆一块空壳）');
  for (const row of (await engine.snapshot()).result.rows) {
    assert.equal('usage' in row, false, `${row.slug} 的列表行带了用法层：快照会被这张一百多键的表撑大，而这一层只有点开详情才用得上`);
  }
});

check('引擎：批注写在同一份库上，读侧立刻看见（批注不进气泡缓存，所以不需要 invalidate）', async () => {
  const { stores, engine, reads } = rig();
  await stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [{ slug: 'Weather::A', name: 'Alpha', desc: 'd', host: 'a', url: 'https://a/', auth: 'No', https: 'Yes', cors: 'Yes', category: 'Weather', firstSeenAt: NOW, lastSeenAt: NOW }] }]);
  assert.equal((await engine.snapshot()).notes.total, 0);
  await stores.notes.write({ slug: 'Weather::A', category: 'Weather', purpose: 'x'.repeat(10), updatedAt: NOW });
  const snap = await engine.snapshot();
  assert.equal(snap.notes.total, 1);
  assert.equal(snap.result.rows[0].note.purpose, 'x'.repeat(10));
  assert.equal(reads.items, 1, '只写批注不该重读条目表');
  await stores.notes.write({ slug: 'Weather::Gone', category: 'Weather', purpose: '上游删了', orphan: true, updatedAt: NOW });
  const after = await engine.snapshot();
  assert.equal(after.notes.orphan, 1);
  assert.deepEqual((await engine.notes({ view: 'orphan' })).map((r) => r.slug), ['Weather::Gone']);
});

check('批注正文上限与 schema 同数（客户端要靠这个数字显示计数器）', async () => {
  assert.equal(NOTE_PURPOSE_MAX_LEN, 2000);
  assert.equal(typeof SEARCH_LIMIT_MAX, 'number');
});

/* ------------------------------------------------------------------ *
 * E2 引擎与现译表（S9：那份映射有自己的缓存，失效口径与索引不同）
 * ------------------------------------------------------------------ */

function rigZh(at = NOW) {
  const facility = makeFakeFacility();
  const stores = createAllStores({ getFacility: () => facility, now: () => at });
  const reads = { items: 0, zh: 0 };
  const origItems = stores.entries.readAllItems;
  stores.entries.readAllItems = () => { reads.items += 1; return origItems(); };
  // ★ bind：trans.zhMap 内部要走 this.readAll()，把方法摘下来裸调会变成"每次取映射都抛"，
  //   而引擎那侧对取不到是**降级成没有中文**（不 reject），于是计数照加、中文照空 —— 一条静默的假绿。
  const origZh = stores.trans.zhMap.bind(stores.trans);
  stores.trans.zhMap = () => { reads.zh += 1; return origZh(); };
  stores.meta.patch({ keyRule: KEY_RULE_VERSION, sha: 'sha-a', lastStatus: 'success', total: 1, fetchedAt: at, lastCheckedAt: at });
  const engine = createQueryEngine({ stores });
  return { facility, stores, engine, reads, at };
}

const ZH_ITEM = { slug: 'Weather::A', name: 'Alpha', desc: 'd', host: 'a', url: 'https://a/', auth: 'No', https: 'Yes', cors: 'Yes', category: 'Weather', firstSeenAt: NOW, lastSeenAt: NOW };

check('引擎：现译表的句子会进 snapshot 的行里，entry 也带同一份中文', async () => {
  const { stores, engine } = rigZh();
  await stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [ZH_ITEM] }]);
  assert.equal((await engine.snapshot()).result.rows[0].descZh, '', '库里还没有译文，行里却冒出了中文');
  await stores.trans.put({ src: 'd', zh: '一句现译', at: NOW, chars: 4, channel: 'baidu', ok: true });
  engine.invalidateZh();
  const snap = await engine.snapshot();
  assert.equal(snap.result.rows[0].descZh, '一句现译');
  assert.equal(snap.result.rows[0].descZhFrom, 'trans');
  assert.equal(snap.result.rows[0].descZhChannel, 'baidu');
  const entry = await engine.entry('Weather::A');
  assert.equal(entry.descZh, '一句现译', '列表有中文、详情没有 = 两条读路径各判各的');
  assert.equal((await engine.notes({ view: 'all' })).length, 0);
});

check('引擎：invalidateZh 之前不重读译文表；调了之后立刻看见新行（现译写完不动 sha，靠 sha 刷不掉它）', async () => {
  const { stores, engine, reads } = rigZh();
  await stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [ZH_ITEM] }]);
  await stores.trans.put({ src: 'd', zh: '第一句', at: NOW, chars: 3, channel: 'baidu', ok: true });
  assert.equal((await engine.search({ query: 'Alpha' })).rows[0].descZh, '第一句');
  assert.equal(reads.zh, 1);
  assert.equal((await engine.search({ query: 'Alpha' })).rows[0].descZh, '第一句');
  assert.equal(reads.zh, 1, `同一份映射读了 ${reads.zh} 遍库`);
  await stores.trans.put({ src: 'd', zh: '换的一句', at: NOW + 1, chars: 4, channel: 'baidu', ok: true });
  assert.equal((await engine.search({ query: 'Alpha' })).rows[0].descZh, '第一句', '没叫 invalidateZh 就读到了新行 —— 那这份缓存等于没有');
  engine.invalidateZh();
  assert.equal((await engine.search({ query: 'Alpha' })).rows[0].descZh, '换的一句');
  assert.equal(reads.zh, 2);
  assert.equal(reads.items, 1, '补一句译文不该把 2019 行的索引也重建一遍');
});

check('引擎：译文表读不出时按"没有中文"降级，不 reject 整份快照', async () => {
  const { stores, engine } = rigZh();
  await stores.entries.writeMany([{ category: 'Weather', updatedAt: NOW, items: [ZH_ITEM] }]);
  stores.trans.zhMap = async () => { throw new Error('域坏了'); };
  const snap = await engine.snapshot();
  assert.equal(snap.result.rows[0].descZh, '');
  assert.equal(snap.index.total, 1, '取不到译文却把整个快照弄成空目录 = 把"存储坏了"伪装成"目录是空的"');
  // 取失败不缓存：修好之后不必 invalidateZh 也应该能读到（否则一次抖动就把中文永久钉成没有）
  stores.trans.zhMap = async () => new Map([['d', { zh: '修好的一句', channel: 'baidu', at: NOW }]]);
  assert.equal((await engine.search({ query: 'Alpha' })).rows[0].descZh, '修好的一句');
});

/* ================================================================== *
 * E. offset 翻页（2026-10-05 版式改版的连带：命中 2019 却只列前 100 是真 bug）
 * ================================================================== */

check('q-e1 offset 切片：第 2 页接在第 1 页之后，两页拼起来正好是前 limit*2 条，且不重不漏', async () => {
  const records = buildIndex(parsed.entries.map(storedItem));
  const p1 = searchRecords({ records, limit: 100 });
  const p2 = searchRecords({ records, limit: 100, offset: 100 });
  assert.equal(p1.rows.length, 100);
  assert.equal(p2.rows.length, 100);
  const whole = searchRecords({ records, limit: 200 }).rows.map((r) => r.slug);
  assert.deepEqual([...p1.rows, ...p2.rows].map((r) => r.slug), whole,
    '两页拼起来与一次要 200 条不一致 ⇒ 切片与排序不是同一套口径（有重叠或有缺口）');
  assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r.slug)).size, 200, '两页之间有重复条目');
});

check('q-e2 offset 的三态：没填/脏值/负数都当第一页，翻过头返回空行而不是报错', async () => {
  const records = buildIndex(parsed.entries.map(storedItem));
  const base = searchRecords({ records, limit: 10 }).rows.map((r) => r.slug);
  for (const bad of [undefined, 0, -1, NaN, 'abc', '', null]) {
    const r = searchRecords({ records, limit: 10, offset: bad });
    assert.deepEqual(r.rows.map((x) => x.slug), base, `offset=${JSON.stringify(bad)} 该当第一页`);
    assert.equal(r.offset, 0, `offset=${JSON.stringify(bad)} 没被夹到 0`);
  }
  const over = searchRecords({ records, limit: 10, offset: 99999 });
  assert.equal(over.rows.length, 0, '翻过头该返回空行，不是把全部条目又吐一遍');
  assert.equal(over.hasMore, false, '翻过头了还说「还有下一页」⇒ 界面会一直显示「继续加载」');
  assert.equal(over.total, base.length > 0 ? searchRecords({ records, limit: 10 }).total : 0, 'total 是总命中数，与翻到第几页无关');
});

check('q-e3 游标字段以服务端为准：offset/limit/hasMore 三个字段都要在，前端不许拿 rows.length 猜下一起点', async () => {
  const records = buildIndex(parsed.entries.map(storedItem));
  const p1 = searchRecords({ records, limit: 30 });
  // 服务端把 limit 夹到 SEARCH_LIMIT_MAX 之后，界面那份 rows.length 与真正的前进步长可能不同：
  // 这里 limit=99999 时 eff 被夹成 200，rows.length 就是 200，前端要发 200 而不是 99999。
  const big = searchRecords({ records, limit: 99999, offset: 200 });
  assert.equal(big.limit, SEARCH_LIMIT_MAX, 'limit 没被夹到上界');
  assert.equal(big.offset, 200, 'offset 原样回传给界面');
  assert.equal(typeof big.hasMore, 'boolean');
  assert.equal(p1.hasMore, true, '全表 2019 条只看 100，必然还有下一页');
  const last = searchRecords({ records, limit: 100, offset: 2000 });
  assert.equal(last.hasMore, false, '翻到接近尾部就该说没有下一页了');
});

check('q-e4 offset 夹在 SEARCH_OFFSET_MAX 上界：1e15 不许原样进slice，且回传的offset 是夹过的那个数', async () => {
  const records = buildIndex(parsed.entries.map(storedItem));
  const huge = searchRecords({ records, limit: 10, offset: 1e15 });
  assert.equal(huge.offset, SEARCH_OFFSET_MAX, `offset 没夹上界，回传的是 ${huge.offset}`);
  assert.equal(huge.rows.length, 0, '夹到上界后仍应是空行（2019 条 < 10 万）');
  assert.equal(huge.hasMore, false);
  // 关键判据：夹过的值必须**回传**。只夹不报的话，界面拿 huge.offset 去发下一发就会带着 1e15 上路，
  // 而那条查询的 SQL/索引层没人夹 —— 这条断言就是为了钉住「夹了要说」。
  assert.equal(typeof huge.offset, 'number');
  assert.ok(huge.offset <= SEARCH_OFFSET_MAX, '回传的 offset 超过上界，等于没夹');
  // 夹上界不许误伤正常值：2000 这种合法翻页起点必须原样通过
  assert.equal(searchRecords({ records, limit: 10, offset: 2000 }).offset, 2000, '合法起点被上界误伤了');
});

await runAll('query');
