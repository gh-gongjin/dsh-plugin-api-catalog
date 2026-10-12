/**
 * lib/query.js —— 读侧一份真相（spec §6 与 §7）。
 *
 * 分成两层是刻意的：
 *  · 下面这批**纯函数**只吃「条目数组 + 批注 Map」，不碰存储也不碰时钟 ⇒ 全部判据可以在
 *    真 README（2019 条）上逐字钉住，包括「免 key 963 / 浏览器直连 450 / github.com 112」这些读数。
 *  · createQueryEngine() 只多做一件事：按 meta.sha 缓存索引。界面拿到的每个数字都出自纯函数，
 *    缓存层不参与判断 ⇒ 缓存坏了只会读到旧快照，不会读出错的答案。
 *
 * 浏览器半边不许复制这里的任何规则（含派生文案）：`derivePurpose` 的三句是 §7 第 2 层的**唯一**出处。
 */
import {
  AUTH_LABELS, CORS_LABELS, HTTPS_LABELS, UNKNOWN, PRESETS,
  SEARCH_LIMIT_MAX, SEARCH_DEFAULT_LIMIT, SEARCH_OFFSET_MAX, HOST_AGG_MIN,
  transZhLabel,
} from './domain.js';
import { categoryLabel } from './categories.js';
import { descZhView, DESC_ZH_LABEL } from './desc-zh.js';
import { usageFor } from './usage.js';

/* ------------------------------------------------------------------ *
 * 中文说明（S9：两层 join，读侧只有一处判据）
 * ------------------------------------------------------------------ */

/**
 * 一句描述的中文从哪儿来。**顺序就是优先级**：内置离线预译表 → 本机现译表 → 没有中文。
 * ★ 两条都不许静默降级成"把英文再说一遍"：`descZh` 为空就是真没中文，界面那一行显示原文，
 *   而 `descZhFrom` 让落款说得出这句中文是谁给的（内置表随发版走，现译表跟着本机）。
 * 命中判据与 lib/desc-zh.js、lib/keys.js 的 transKey 全部是「折叠空白后逐字相同」——
 * 三层用同一个函数（这里靠 descZhView，键那侧靠 transKey 的同一式归一）。
 *
 * @param desc     条目的英文原文
 * @param transMap 现译表那份 src → {zh, channel, at}（缺省 = 只看内置表）
 */
export function zhForDesc(desc, transMap = null) {
  const src = String(desc ?? '').replace(/\s+/g, ' ').trim();
  // ★ 落款在这里拼，不在界面拼：'现译 · 渠道 · 时刻' 与 '内置离线预译 · 日期' 的字面量与分隔口径
  //   都归 domain / desc-zh 两家；界面照着 descZhLabel 显示，加一档渠道或改一句日期都不用动浏览器半边。
  if (!src) return { descZh: '', descZhFrom: '', descZhLabel: '', descZhChannel: '', descZhAt: 0 };
  const builtin = descZhView(src);
  if (builtin.translated) return { descZh: builtin.zh, descZhFrom: 'builtin', descZhLabel: DESC_ZH_LABEL, descZhChannel: '', descZhAt: 0 };
  const row = transMap?.get?.(src);
  if (row && row.zh) {
    return {
      descZh: row.zh, descZhFrom: 'trans', descZhLabel: transZhLabel(row.channel || '', row.at),
      descZhChannel: row.channel || '', descZhAt: Number(row.at) || 0,
    };
  }
  return { descZh: '', descZhFrom: '', descZhLabel: '', descZhChannel: '', descZhAt: 0 };
}

/** 给一行条目补上中文（就地返回新对象，不改索引里那份缓存记录）。 */
function withZh(item, transMap) {
  return { ...item, ...zhForDesc(item?.desc, transMap) };
}

/**
 * 归一化：小写 + 去掉 `- _ 空格` 三种分隔符，中文原样留着（中文没有词间空格，去掉也不会粘连）。
 * ★ 为什么要去分隔符：查 "open api" 的人不该因为上游写成 `OpenAPi` / `open-api` / `open_api` 就查不到。
 *   代价是"词"这个概念在这里没有了，所以打分只有「前缀」与「包含」两级 —— 别在这里加词边界判断。
 */
export function norm(v) {
  return String(v ?? '').toLowerCase().replace(/[\s\-_]/g, '');
}

/** 切词：按空白分，每词再走一遍 norm。空串 ⇒ 空数组（= 不过滤，不是"匹配空"）。 */
export function tokenize(query) {
  return String(query ?? '').split(/\s+/).map(norm).filter(Boolean);
}

/** 打分的四档（spec §6：name 前缀 > name 词中 > desc > host）。数值只为排序，档位差必须大于词数上限带来的漂移。 */
export const SCORE = { NAME_PREFIX: 100, NAME: 60, DESC: 20, HOST: 10 };

/**
 * 一条记录对一个查询的得分；**任何一词没命中就整条 0**（多词 AND）。
 * 分类不参与打分：分类是 facet，不是搜索域 —— 把它算进分数会让"某类条目多"伪装成"更相关"。
 */
export function scoreRecord(rec, words) {
  let total = 0;
  for (const w of words) {
    let hit = 0;
    if (rec.nameN.startsWith(w)) hit = SCORE.NAME_PREFIX;
    else if (rec.nameN.includes(w)) hit = SCORE.NAME;
    else if (rec.descN.includes(w)) hit = SCORE.DESC;
    else if (rec.hostN.includes(w)) hit = SCORE.HOST;
    if (!hit) return 0;
    total += hit;
  }
  return total;
}

/** 建索引：把每条的name/desc/host 各归一化一次（查询期不再重复 normalize 2019×3 次）。 */
export function buildIndex(items) {
  return (items ?? []).map((item) => ({
    item,
    nameN: norm(item.name),
    descN: norm(item.desc),
    hostN: norm(item.host),
  }));
}

/* ------------------------------------------------------------------ *
 * facet 与预设（§6）
 * ------------------------------------------------------------------ */

const FACET_FIELDS = ['auth', 'https', 'cors'];

/** facet 的**候选值**取自库里实际出现的值，不取 AUTH_OPTIONS：上游多出来的脏值也要能筛出来看。 */
function tally(records, field) {
  const out = {};
  for (const rec of records) {
    const v = String(rec.item[field] ?? UNKNOWN);
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

/** 分类清单：库里实际有行就有，空分类（items 为 []）也算一类，计数 0。 */
export function categoryCounts(records) {
  const map = new Map();
  for (const rec of records) {
    const name = String(rec.item.category ?? '');
    if (!name) continue;
    map.set(name, (map.get(name) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, label: categoryLabel(name), count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function facetCounts(records) {
  const facets = { category: categoryCounts(records) };
  for (const field of FACET_FIELDS) facets[field] = tally(records, field);
  return facets;
}

/** 一行的 facet 命中表（数组 = 多选 chips，字符串 = 单值，空 = 不限）。 */
function facetAllowed(item, facets) {
  for (const field of FACET_FIELDS) {
    const want = facets[field];
    if (want === undefined || want === null || want === '' || (Array.isArray(want) && !want.length)) continue;
    // ★ 缺列兜底必须与 tally() 同一个口径：清单按 unknown 报了数，点 unknown 却筛不出这一条就是两句实话。
    const list = (Array.isArray(want) ? want : [want]).map(String);
    if (!list.includes(String(item[field] ?? UNKNOWN))) return false;
  }
  return true;
}

/** 预设档就是「一组 facet 条件」，所以计数与点进 chips 的结果必然同数（不许另写一条判据）。 */
export function presetCounts(records) {
  const out = {};
  for (const preset of PRESETS) {
    out[preset.id] = records.filter((rec) => facetAllowed(rec.item, preset.facets)).length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 同 host 聚合（§6：回答"一家供应商散在几个分类"）
 * ------------------------------------------------------------------ */

/**
 * 返回按条数倒序的 host 清单。`min` 是界面门槛（默认 HOST_AGG_MIN）：
 * 只有一条的供应商占 90%，全列出来等于把「散在多个分类」这一条信号淹掉。
 * `top` 只截清单，不截计数 —— 截断必须在响应里说得出"还有几家"，所以总数另带。
 */
export function hostGroups(records, { min = HOST_AGG_MIN, top = 0 } = {}) {
  const map = new Map();
  for (const rec of records) {
    const host = String(rec.item.host || '');
    if (!host) continue;
    let g = map.get(host);
    if (!g) {
      g = { host, count: 0, categories: new Set() };
      map.set(host, g);
    }
    g.count += 1;
    if (rec.item.category) g.categories.add(String(rec.item.category));
  }
  const all = [...map.values()]
    .map((g) => ({ host: g.host, count: g.count, categories: [...g.categories].sort((a, b) => a.localeCompare(b)) }))
    .filter((g) => g.count >= min)
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  const rows = top > 0 ? all.slice(0, top) : all;
  return { rows, total: all.length, truncated: all.length > rows.length };
}

/* ------------------------------------------------------------------ *
 * 用途说明第三层：字段派生（§7 第 2 层，纯字段推，可断言）
 * ------------------------------------------------------------------ */

/**
 * 派生的是"注意事项"而不是"介绍"：desc 已经是上游给的一句话，这里只补三条从字段推得出的结论。
 * ★ 第三种状态（unknown）必须有自己的文案：把 CORS 未知说成"浏览器不能直连"是谎报，
 *   说成"可以直连"更糟 —— 用户会拿它去接线上的东西。
 */
export function derivePurpose(entry) {
  const out = [];
  const auth = String(entry?.auth ?? UNKNOWN);
  if (auth === 'No') out.push(AUTH_LABELS.No);
  else if (auth === UNKNOWN) out.push(AUTH_LABELS.unknown);
  else out.push(`需注册取 key，方式为 ${AUTH_LABELS[auth] ?? auth}`);

  const cors = String(entry?.cors ?? UNKNOWN);
  if (cors === 'No') out.push(CORS_LABELS.No);
  else if (cors === UNKNOWN) out.push(CORS_LABELS.unknown);

  // 这一句比 facet 的标签多一段忠告：§7 第 2 层的产物是"注意事项"，只说"不支持 HTTPS"用户不知道该干什么。
  // 前半截仍取标签表 —— 两处说法对不上，界面就会出现"标签说不支持、忠告说别用"各说各话。
  if (String(entry?.https ?? UNKNOWN) === 'No') out.push(`${HTTPS_LABELS.No}：仍是明文，生产别用`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 搜索主流程（纯函数）
 * ------------------------------------------------------------------ */

function byName(a, b) {
  return String(a.rec.item.name).localeCompare(String(b.rec.item.name));
}

/**
 * @param records buildIndex() 的产物
 * @param notes   slug → note 的 Map（界面 join 用；没有批注就是 undefined）
 * @param includeHidden 默认 false：`hidden:true` 只从**默认结果集**里藏掉，带 query 的显式搜索仍要出
 *        （§5 口径 —— 藏的是"默认别烦我"，不是"从库里消失"）
 * @param host 同 host 聚合的点击落点（§6 那一块的唯一后续动作）。它不是 §6 列的四个 facet 之一，
 *        所以单列一个参数：混进 facets 会让"facet 取自库里实际值"这条口径多出一个例外。
 * @param offset 翻页起点（2026-10-05 加）。**排序必须在切片之前完成** —— 排序在切片后做，
 *        第 2 页会拿到另一批条目，用户点「继续加载」看到的顺序会跳。
 *        返回值里 offset/limit/hasMore 三个字段是给界面累加游标用的：前端不许自己拿 rows.length 猜下一页起点
 *        （服务端把 limit 夹过之后，界面那份 rows.length 与真正的前进步长可能不是同一个数）。
 */
export function searchRecords({
  records = [], notes = new Map(), query = '', category = '', host = '',
  facets = {}, limit = SEARCH_DEFAULT_LIMIT, offset = 0, includeHidden = false, transMap = null,
} = {}) {
  const words = tokenize(query);
  const cat = String(category || '');
  const hostW = String(host || '');
  const matched = [];
  for (const rec of records) {
    if (cat && String(rec.item.category) !== cat) continue;
    if (hostW && String(rec.item.host) !== hostW) continue;
    if (!facetAllowed(rec.item, facets)) continue;
    const note = notes.get(rec.item.slug);
    if (!words.length && !includeHidden && note?.hidden === true) continue;
    if (words.length) {
      const score = scoreRecord(rec, words);
      if (!score) continue;
      matched.push({ rec, note, score });
    } else {
      matched.push({ rec, note, score: 0 });
    }
  }

  // 相关度优先（有 query）；浏览态按 分类 + 名称，但置顶的批注排最前（starred 的全部含义）。
  if (words.length) matched.sort((a, b) => b.score - a.score || byName(a, b));
  else matched.sort((a, b) => (b.note?.starred ? 1 : 0) - (a.note?.starred ? 1 : 0)
    || String(a.rec.item.category).localeCompare(String(b.rec.item.category))
    || byName(a, b));

  const n = Number(limit);
  const eff = Number.isFinite(n) && n > 0 ? Math.min(SEARCH_LIMIT_MAX, Math.trunc(n)) : SEARCH_DEFAULT_LIMIT;
  // ★ offset 必须夹成非负整数，且**不参与"没填就回落默认"那一支**：offset 的默认值就是 0，
  //   拿 limitParam 那套「负数当没填」的口径来处理它，?offset=-1 会被顶成 0（看起来对），
  //   而 ?offset=abc 也会被顶成 0 —— 界面于是分不清"翻到第 0 页"和"翻页参数写坏了"。
  //   翻过头（offset ≥ matched.length）返回空行 + hasMore:false，这是合法答案，不是错。
  const rawOffset = Number(offset);
  const off = Number.isFinite(rawOffset) && rawOffset > 0
    ? Math.min(SEARCH_OFFSET_MAX, Math.trunc(rawOffset))
    : 0;
  const page = matched.slice(off, off + eff);
  // ★ 中文在这里补，不在界面补：`withZh` 是读侧唯一一处 join（内置表 → 现译表 → 无），
  //   界面只许显示 `descZh` / 空则回退 `desc`。多写一处判据就会出现「列表有中文、详情没有」那种分裂。
  const rows = page.map(({ rec, note, score }) => ({
    ...withZh(rec.item, transMap),
    note: note ? { purpose: note.purpose || '', tags: [...(note.tags || [])], starred: !!note.starred, hidden: !!note.hidden, orphan: !!note.orphan } : null,
    derived: derivePurpose(rec.item),
    score,
  }));
  // hasMore 是"下一页还有没有"，truncated 保留旧名同义（总命中 > 已看到）——
  // 界面用哪一个都拿得到同一件事，但旧字段有测试钉着，不趁这次改名。
  return { rows, total: matched.length, offset: off, limit: eff, hasMore: off + rows.length < matched.length, truncated: matched.length > off + rows.length };
}

/** 我的笔记页：批注全量（含 orphan），能接上条目的就把条目带上。 */
export function noteRows({ records = [], notes = new Map(), view = 'all', transMap = null } = {}) {
  const bySlug = new Map(records.map((rec) => [rec.item.slug, rec.item]));
  const rows = [];
  for (const note of notes.values()) {
    const entry = bySlug.get(note.slug);
    const isOrphan = !entry || note.orphan === true;
    if (view === 'starred' && !note.starred) continue;
    if (view === 'tags' && !(note.tags || []).length) continue;
    if (view === 'orphan' && !isOrphan) continue;
    rows.push({
      slug: note.slug,
      category: note.category,
      name: note.name || '',
      purpose: note.purpose || '',
      tags: [...(note.tags || [])],
      starred: !!note.starred,
      hidden: !!note.hidden,
      orphan: isOrphan,
      updatedAt: note.updatedAt,
      entry: entry ? { name: entry.name, url: entry.url, auth: entry.auth, https: entry.https, cors: entry.cors, desc: entry.desc || '', ...zhForDesc(entry.desc, transMap) } : null,
    });
  }
  rows.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.updatedAt - a.updatedAt);
  return rows;
}

/* ------------------------------------------------------------------ *
 * 引擎：按 meta.sha 缓存索引
 * ------------------------------------------------------------------ */

/**
 * @param stores createAllStores() 那一份。只读，这里一行都不写。
 *
 * 缓存键为什么是 sha 而不是"写库时打个点"：写侧只有 sync 一处，它写完 entries 一定写 meta
 * （meta 最后，§5 写序），所以下一次读到的 sha 变了就必然意味着条目变了。反过来，
 * 中途崩掉那一轮 sha 没推进 ⇒ 下一轮重新差分并把行覆盖回去，索引跟着 sha 走也不会读到半份。
 */
export function createQueryEngine({ stores } = {}) {
  let cache = null;
  /**
   * 现译表那份 `src → {zh, channel, at}`。失效口径**与索引不同**，这是这里唯一需要解释的地方：
   * 索引按 `meta.sha`（一轮同步换一次，写侧的顺序保证 sha 变则条目变）；现译是增量补写，
   * 写完不动 sha —— 靠 sha 顺带刷不掉它。所以只有两个入口能让它变干净：
   * 本引擎的 `invalidateZh()`（翻译服务每次真写过行就叫它），以及换库重建（`invalidate()`）。
   */
  let zhCache = null;

  async function load() {
    const meta = await stores.meta.read();
    const sha = meta && meta.sha ? String(meta.sha) : '';
    if (cache && cache.sha === sha) return { ...cache, meta };
    const items = await stores.entries.readAllItems();
    cache = { sha, records: buildIndex(items), builtAt: Date.now() };
    return { ...cache, meta };
  }

  /** 取现译映射；**取不到不缓存** —— 译文表临时不可用不该把中文永久钉成"没有"。 */
  async function zhMap() {
    if (zhCache) return zhCache;
    const map = await stores.trans.zhMap().catch(() => null);
    if (!map) return new Map();
    zhCache = map;
    return zhCache;
  }

  return {
    /** 索引读数（诊断与快照接口用）：条数、建索引时的快照 sha。 */
    async info() {
      const { records, meta } = await load();
      return { sha: meta?.sha || '', total: records.length, builtAt: cache?.builtAt ?? 0 };
    },

    /** facet + 两档预设计数（一次读全，界面不许自己数条目）。 */
    async facets() {
      const { records } = await load();
      return { facets: facetCounts(records), presets: presetCounts(records) };
    },

    /** 同 host 聚合：不带 top = 全清单（GET /hosts 用）。 */
    async hosts({ min = HOST_AGG_MIN, top = 0 } = {}) {
      const { records } = await load();
      return hostGroups(records, { min, top });
    },

    async search(params) {
      const { records } = await load();
      const notes = await stores.notes.readAll();
      return searchRecords({ ...params, records, notes, transMap: await zhMap() });
    },

    async notes(params) {
      const { records } = await load();
      const notes = await stores.notes.readAll();
      return noteRows({ ...params, records, notes, transMap: await zhMap() });
    },

    /** 一次读齐界面首屏（快照页签要的数字全在这里，客户端不再发第二发）。 */
    async snapshot({ query = '', category = '', host = '', facets = {}, limit = SEARCH_DEFAULT_LIMIT, offset = 0 } = {}) {
      const { records, meta } = await load();
      const notes = await stores.notes.readAll();
      const transMap = await zhMap();
      const slugs = new Set(records.map((rec) => rec.item.slug));
      let orphanNotes = 0;
      for (const note of notes.values()) {
        if (note.orphan === true || !slugs.has(note.slug)) orphanNotes += 1;
      }
      const searched = searchRecords({ records, notes, query, category, host, facets, limit, offset, transMap });
      return {
        meta: meta ?? null,
        index: { sha: meta?.sha || '', total: records.length, categories: categoryCounts(records).length },
        facets: facetCounts(records),
        presets: presetCounts(records),
        // 同 host 聚合**不进快照**（2026-10-05 用户裁定：目录页那块是多此一举）：
        // 每轮推流摊 20 行没人读的数据，等于让载荷替一个不存在的界面占地方。能力留在 GET /api/hosts。
        notes: { total: notes.size, orphan: orphanNotes },
        result: { rows: searched.rows, total: searched.total, offset: searched.offset, limit: searched.limit, hasMore: searched.hasMore, truncated: searched.truncated },
      };
    },

    /** 条目详情（含批注与派生句）。找不到就 null，界面按 null 说话。 */
    async entry(slug) {
      const { records } = await load();
      const rec = records.find((r) => r.item.slug === String(slug));
      if (!rec) return null;
      return {
        ...withZh(rec.item, await zhMap()),
        note: (await stores.notes.read(slug)) || null,
        derived: derivePurpose(rec.item),
        // ★ 用法层只在这一发里出现（列表行不带）：那是一份 177 键的表，摊进每一行等于把快照撑大一圈，
        //   而用户只有点开详情时才用得上它。取不到就是 null —— 界面整块不摆，不摆"没有规范"的半套话术。
        usage: usageFor(rec.item.url),
      };
    },

    /** 让下一读重新取库（现在只有测试与"重建"这类动作会用；同步轮次不需要它 —— sha 会变）。 */
    invalidate() { cache = null; },

    /** 现译表被写过了：下一读重新取那份映射（不重建索引 —— 条目一条没变）。 */
    invalidateZh() { zhCache = null; },
  };
}
