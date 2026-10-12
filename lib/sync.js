/**
 * lib/sync.js —— 一轮同步：抓取 → 两道门 → 差分 → 只重写变了的分类行 → 流水 → meta 收尾。
 *
 * 六条不许漂的口径：
 *  1. **单飞必须返 rejected promise**，不能同步 throw：宿主半边这一发是从定时器回调里调的，
 *     同步异常从 timer 回调漏出去会把宿主整块打挂（modelwatch 定时器血案同条教训）。
 *  2. **门不过就不写库**：哈希门（正文一模一样）一行都不写；解析门（读不出目录）保留上一次快照。
 *     宁可界面显示昨天的目录，也不许写一份残缺的进去 —— 残缺那份会被当成真目录来筛选。
 *  3. **写序 entries → notes → changes → meta**：KV 没有事务，meta 里的 sha 是本轮成功的凭据，
 *     所以它必须最后一个写。中途崩了 ⇒ 下一轮 sha 没推进 ⇒ 重新差分、把分类行覆盖回去。
 *  4. **只重写内容真变了的分类行**：判据是 rowFingerprint（与行序无关、不含时刻字段），
 *     所以「上游只动了一条」= 一个文件被重写，不是 51 个。
 *  5. **认不出身份就判「删一条 + 加一条」，不猜**：配对只走同 slug / url 唯一 / 同分类+同折叠名 三条桥，
 *     桥上只要有歧义（同一 key 一侧有多条）就整 key 放过。猜错身份会把用户的批注挂到另一个 API 上。
 *  6. **键规则对不上时一行都不写**（SYNC_FAIL.KEY_RULE）：旧键规则的 notes 还在库里时把新键写下去，
 *     等于把批注变成看不见的文件（dsh-storage-json/lib/index.js:416 读侧静默跳过）。
 *
 * round() 除 SYNC_BUSY 外**不 reject**：存储不可用、源全断、正文读不出全部返回结构化结果，
 * 由调用方（定时器 / POST 路由）决定怎么显示。定时器里等一个会 reject 的 promise 就是自己造 unhandled rejection。
 *
 * 首次同步（库里没有 meta 或没有 sha）走 `baseline`：差分照做，但**不写流水** —— 那时没有"变化"可登记，
 * 把整册条目全记成「上游新增」既挤爆 200 行的流水，也不是事实（事实是本机建了第一份快照）。
 */
import {
  DEFAULT_PREFS, CHECK_INTERVALS, BACKOFF_STEPS,
  SYNC_BUSY, SYNC_NO_CHANGE, SYNC_PARSE_ERROR, SYNC_FAIL,
  KEEP_CHANGES, CHANGE_DETAIL_MAX_LEN, CHANGE_KINDS, CHANGE_KIND_LABELS,
  AUTH_LABELS, HTTPS_LABELS, CORS_LABELS,
} from './domain.js';
import { parseCatalog, foldKey } from './parse.js';
import { fetchCatalog } from './fetch.js';
import { KEY_RULE_VERSION } from './keys.js';

/** 单飞锁：不并发触发第二轮。`http` 留给 S3 的 POST 路由直接写状态码。 */
export class SyncBusyError extends Error {
  constructor() {
    super(SYNC_BUSY.message);
    this.name = 'SyncBusyError';
    this.code = SYNC_BUSY.code;
    this.http = SYNC_BUSY.http;
  }
}

/* ------------------------------------------------------------------ *
 * 节拍与退避
 * ------------------------------------------------------------------ */

function clampBackoff(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, BACKOFF_STEPS.length - 1);
}

/** 下一档（取值是 BACKOFF_STEPS 的下标，封顶在最后一档，不是"失败次数"）。 */
export function nextBackoff(meta) {
  return Math.min(clampBackoff(meta?.backoff) + 1, BACKOFF_STEPS.length - 1);
}

/**
 * 下一轮该等多久（毫秒）。两个口径：
 *  · 间隔必须是档位表里的数（库里的 7 分不清是手滑还是旧版，回落默认）；
 *  · 倍率取 BACKOFF_STEPS[档位]，成功/没变化那一轮把档位写回 0 ⇒ 退避不会自己越拖越长。
 */
export function nextDelayMs(prefs, meta) {
  const raw = Number(prefs?.intervalMin);
  const intervalMin = CHECK_INTERVALS.includes(raw) ? raw : DEFAULT_PREFS.intervalMin;
  return intervalMin * 60_000 * BACKOFF_STEPS[clampBackoff(meta?.backoff)];
}

/* ------------------------------------------------------------------ *
 * 差分
 * ------------------------------------------------------------------ */

/** 比较「这一行内容变没变」的字段集合。firstSeenAt / lastSeenAt / updatedAt 不在内：时刻每轮都新，比了就等于每轮全重写。 */
const CONTENT_FIELDS = ['slug', 'name', 'url', 'host', 'desc', 'auth', 'https', 'cors', 'category'];
/** 逐字段登记变化的顺序（host 排最后：它是从 url 派生的，一起改时说 url 那条就够了）。 */
const DIFF_FIELDS = ['name', 'url', 'desc', 'auth', 'https', 'cors', 'host'];
const FIELD_LABELS = { name: '名称', url: '地址', desc: '用途', auth: '鉴权', https: 'HTTPS', cors: 'CORS', host: '主机' };

function displayValue(field, value) {
  if (value === undefined || value === null || value === '') return '（空）';
  if (field === 'auth') return AUTH_LABELS[value] ?? String(value);
  if (field === 'https') return HTTPS_LABELS[value] ?? String(value);
  if (field === 'cors') return CORS_LABELS[value] ?? String(value);
  return String(value);
}

/** 单侧最长 40 字：流水是「一眼看出这轮动了什么」，不是把 128 字的描述抄两遍。 */
function shorten(value, max = 40) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 整句截到 schema 的上限。这里截是允许的：detail 是给人看的一句话，变化本身已按 kind + 各字段登记过。 */
function clipDetail(text) {
  const s = String(text ?? '');
  return s.length > CHANGE_DETAIL_MAX_LEN ? s.slice(0, CHANGE_DETAIL_MAX_LEN - 1) + '…' : s;
}

/**
 * 「本轮摘要」那一行的话术（U-17）。数字全部来自 `diff.stats`，词全部来自 `CHANGE_KIND_LABELS`
 * —— 界面不许自己拼一份，域里也不许有第二个数源。
 */
function roundSummary(stats, sourceId) {
  const parts = CHANGE_KINDS.map((k) => `${CHANGE_KIND_LABELS[k]} ${Number(stats?.[k]) || 0}`);
  return clipDetail(`${parts.join(' · ')} · 源 ${sourceId}`);
}

function fieldDiffs(prev, next) {
  const out = [];
  for (const f of DIFF_FIELDS) {
    const a = prev?.[f] ?? '';
    const b = next?.[f] ?? '';
    if (a === b) continue;
    out.push(`${FIELD_LABELS[f]} ${shorten(displayValue(f, a))} → ${shorten(displayValue(f, b))}`);
  }
  return out;
}

/**
 * 逐行取内容指纹后整体排序 ⇒ 同一批条目不论行序都是同一个串（上游只调顺序不该被当成改动）。
 * 传入的既可以是库里的行（带时刻），也可以是刚解析的条目（不带）—— 比较的字段两边都有。
 */
export function rowFingerprint(items) {
  return (items || [])
    .map((item) => CONTENT_FIELDS.map((f) => `${f}=${item?.[f] ?? ''}`).join('\u0001'))
    .sort()
    .join('\u0002');
}

function makePair(prev, next) {
  const diffs = fieldDiffs(prev, next);
  const slugChanged = prev.slug !== next.slug;
  const categoryChanged = (prev.category ?? '') !== (next.category ?? '');
  let kind = 'same';
  if (slugChanged && categoryChanged) kind = 'moved';
  else if (diffs.length || slugChanged) kind = 'changed';
  const parts = [];
  if (kind !== 'same') {
    if (categoryChanged) parts.push(`分类 ${shorten(prev.category)} → ${shorten(next.category)}`);
    // slug 变了而内容没变是真实存在的一种：同名同分类的另一条被删掉后，去重后缀会收回去。
    // 它必须登记 —— 批注键跟着变，不登记的话用户只会发现"笔记不见了"。
    if (slugChanged) parts.push(`主键 ${shorten(prev.slug)} → ${shorten(next.slug)}`);
    parts.push(...diffs);
  }
  return { prev, next, kind, detail: clipDetail(parts.join('；')) };
}

function indexByKey(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const k = keyOf(item);
    if (!k) continue;
    const list = map.get(k);
    if (list) list.push(item); else map.set(k, [item]);
  }
  return map;
}

/** 一条桥：两侧都"唯一"才配对。任何一侧有歧义就整 key 放过 —— 宁可判成删+加也不猜。 */
function linkBy(prevSet, nextSet, pairs, keyOf) {
  const prevByKey = indexByKey(prevSet, keyOf);
  const nextByKey = indexByKey(nextSet, keyOf);
  for (const [key, nextList] of nextByKey) {
    if (nextList.length !== 1) continue;
    const prevList = prevByKey.get(key);
    if (!prevList || prevList.length !== 1) continue;
    const next = nextList[0];
    const prev = prevList[0];
    prevSet.delete(prev);
    nextSet.delete(next);
    pairs.push(makePair(prev, next));
  }
}

function toStoredItem(item, firstSeenAt, at) {
  return {
    slug: item.slug, name: item.name, url: item.url, host: item.host ?? '',
    desc: item.desc ?? '', auth: item.auth, https: item.https, cors: item.cors,
    category: item.category, firstSeenAt, lastSeenAt: at,
  };
}

/**
 * 差分：库里的分类行 + 刚解析的条目 → 该写什么、该删什么、笔记怎么搬家、流水写什么。
 *
 * @param options.prevRows entries.readAll() 的分类行
 * @param options.nextItems parseCatalog().entries（落库字段都在，多出的 line/categoryLine/authRaw 由 schema 丢）
 * @param options.notes notes.readAll() 的 Map（slug → 批注）。预先拿它判断，免得为 2019 条各排一次队。
 * @param options.baseline 库里还没有快照时置 true：只建基线，不写流水。
 */
export function diffCatalog({ prevRows = [], nextItems = [], notes = new Map(), at = 0, baseline = false } = {}) {
  const rows = Array.isArray(prevRows) ? prevRows : [];
  const items = Array.isArray(nextItems) ? nextItems : [];
  const prevItems = [];
  for (const row of rows) prevItems.push(...(row?.items || []));
  const storedByCategory = new Map(
    rows.filter((r) => r && typeof r.category === 'string').map((r) => [r.category, r]),
  );
  const prevBySlug = new Map(prevItems.map((i) => [i.slug, i]));

  const pairs = [];
  const unmatchedPrev = new Set(prevItems);
  const unmatchedNext = new Set(items);

  // 桥 1：主键没变 ⇒ 一定是同一条
  for (const next of items) {
    const prev = prevBySlug.get(next.slug);
    if (!prev) continue;
    if (!unmatchedPrev.delete(prev)) continue;
    unmatchedNext.delete(next);
    pairs.push(makePair(prev, next));
  }
  // 桥 2：地址唯一相同 ⇒ 上游改了显示名或分类名（slug 跟着变，笔记要搬家）
  linkBy(unmatchedPrev, unmatchedNext, pairs, (i) => (i.url ? `u\u0000${i.url}` : ''));
  // 桥 3：同分类 + 同折叠名 ⇒ 上游换了地址
  linkBy(unmatchedPrev, unmatchedNext, pairs, (i) => `n\u0000${i.category ?? ''}\u0000${foldKey(i.name ?? '')}`);

  const removed = prevItems.filter((i) => unmatchedPrev.has(i));
  const added = items.filter((i) => unmatchedNext.has(i));

  const firstSeenByNext = new Map(pairs.map((p) => [p.next, Number(p.prev.firstSeenAt) || at]));
  const groups = new Map();
  for (const item of items) {
    const category = item.category ?? '';
    const stored = toStoredItem(item, firstSeenByNext.get(item) ?? at, at);
    const list = groups.get(category);
    if (list) list.push(stored); else groups.set(category, [stored]);
  }

  const rowsToWrite = [];
  for (const [category, groupItems] of groups) {
    const stored = storedByCategory.get(category);
    if (!stored || rowFingerprint(stored.items) !== rowFingerprint(groupItems)) {
      rowsToWrite.push({ category, items: groupItems, updatedAt: at });
    }
  }
  const rowsToRemove = [...storedByCategory.keys()].filter((c) => !groups.has(c));

  const noteMigrations = [];
  const noteOrphans = [];
  const noteRelinks = [];
  for (const p of pairs) {
    if (p.prev.slug === p.next.slug) continue;
    if (notes.has(p.prev.slug)) {
      noteMigrations.push({ fromSlug: p.prev.slug, toSlug: p.next.slug, category: p.next.category });
    }
  }
  for (const item of removed) {
    const note = notes.get(item.slug);
    if (note && note.orphan !== true) noteOrphans.push(item.slug);
  }
  for (const item of added) {
    const note = notes.get(item.slug);
    if (note && note.orphan === true) noteRelinks.push(item.slug);
  }

  const ledger = [];
  if (!baseline) {
    // ★ 明细行自己带 `at`（= 这一轮的那个 `at`），不留给 stores 的 `now()` 逐行现取：
    //   真时钟下一轮 2000 行会拿到 2000 个递增的时刻，而本轮摘要用的是同步开始那一刻 ⇒ 摘要排在最旧那头，
    //   保留上限一 trim 就被挤掉（U-17 要防的正是这个）。同一 `at` 才轮到 seq 说话。
    const pairByNext = new Map(pairs.map((p) => [p.next, p]));
    const addedSet = new Set(added);
    for (const next of items) {
      const p = pairByNext.get(next);
      if (p) {
        if (p.kind !== 'same') {
          ledger.push({ at, kind: p.kind, slug: next.slug, name: next.name, category: next.category, detail: p.detail });
        }
      } else if (addedSet.has(next)) {
        ledger.push({
          at, kind: 'added', slug: next.slug, name: next.name, category: next.category,
          detail: clipDetail(next.desc ? `上游新列出这条：${shorten(next.desc)}` : '上游新列出这条'),
        });
      }
    }
    for (const prev of removed) {
      ledger.push({
        at, kind: 'removed', slug: prev.slug, name: prev.name, category: prev.category,
        detail: clipDetail('上游不再列这条'),
      });
    }
  }

  const counts = [...groups.entries()].map(([name, groupItems]) => ({ name, count: groupItems.length }));
  const stats = {
    total: items.length,
    categories: groups.size,
    added: added.length,
    removed: removed.length,
    changed: pairs.filter((p) => p.kind === 'changed').length,
    moved: pairs.filter((p) => p.kind === 'moved').length,
    same: pairs.filter((p) => p.kind === 'same').length,
    rowsWritten: rowsToWrite.length,
    rowsRemoved: rowsToRemove.length,
  };
  return {
    rowsToWrite, rowsToRemove, noteMigrations, noteOrphans, noteRelinks,
    added, removed, ledger, counts, stats,
  };
}

/* ------------------------------------------------------------------ *
 * 一轮同步
 * ------------------------------------------------------------------ */

/**
 * @param options.stores createAllStores() 的那一份（entries/meta/notes/prefs/changes）
 * @param options.fetchImpl 注入以走假 fetch（缺省用全局 fetch）
 * @param options.logger 源全断 / 正文读不出 / 键规则对不上要 warn：界面只给一行，日志要留全貌
 * @param options.now 时刻注入 —— 差分与流水共用同一个 at，一轮里不许跳
 */
export function createSync({ stores, fetchImpl, logger, now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  let running = false;

  function storageFailed(e, at, prefs) {
    return withCadence({
      ok: false, status: 'failure', code: SYNC_FAIL.STORAGE,
      storageCode: e?.code, reason: `存储这一侧没走通：${e?.message ?? e}`, at, stored: false,
    }, prefs, undefined);
  }

  /** 结果里带上"下一轮等多久"，装配层就不用为了算节拍再读一遍库（读了也可能已被另一轮改掉）。 */
  function withCadence(result, prefs, backoffStep) {
    return { ...result, nextDelayMs: nextDelayMs(prefs ?? DEFAULT_PREFS, { backoff: backoffStep ?? 0 }) };
  }

  /** 失败收尾：先登记流水再写 meta（与成功分支同一顺序 —— meta 最后）。写库本身也失败时不掩盖原始原因。 */
  async function failRound({ at, meta, prefs, code, lastErrorCode, reason, detail, ledgerKind }) {
    let stored = true;
    try {
      if (ledgerKind) await stores.changes.append({ kind: ledgerKind, at, detail });
      await stores.meta.patch({
        keyRule: KEY_RULE_VERSION,
        lastStatus: 'failure',
        lastCheckedAt: at,
        lastError: reason,
        lastErrorCode,
        backoff: nextBackoff(meta),
      });
    } catch (e) {
      stored = false;
      reason = `${reason}（登记这一步也没走通：${e?.message ?? e}）`;
    }
    return withCadence({
      ok: false, status: 'failure', code, reason, at, stored, lastErrorCode,
    }, prefs, nextBackoff(meta));
  }

  async function round() {
    const at = clock();
    let prefs;
    let meta;
    try {
      prefs = await stores.prefs.read();
      meta = await stores.meta.read();
    } catch (e) {
      return storageFailed(e, at, prefs);
    }

    // 门 0：键规则对不上 ⇒ 一行都不写（连 meta 都不改 —— 改了就是把 keyRule 谎报成已迁移）
    if (meta && Number(meta.keyRule) !== KEY_RULE_VERSION) {
      const reason = `库里那份快照的键规则是 ${meta.keyRule}，本机是 ${KEY_RULE_VERSION}：直接同步会把批注写成对不上号的键，本轮不碰库`;
      logger?.warn?.(`[api-catalog] ${reason}`);
      return withCadence({ ok: false, status: 'failure', code: SYNC_FAIL.KEY_RULE, reason, at, stored: false }, prefs, clampBackoff(meta?.backoff));
    }

    const fetched = await fetchCatalog({ sourcePriority: prefs.sourcePriority, fetchImpl, logger });
    if (!fetched.ok) {
      const lastErrorCode = fetched.failures[0]?.code ?? 'all_sources_failed';
      const reason = fetched.failures.length
        ? `${fetched.reason}：${fetched.failures.map((f) => `${f.label}（${f.code}）`).join('、')}`
        : fetched.reason;
      logger?.warn?.(`[api-catalog] 取正文失败：${reason}`);
      const detail = clipDetail(`源故障：${fetched.failures.map((f) => `${f.label} ${f.code}`).join('；') || fetched.reason}`);
      return await failRound({ at, meta, prefs, code: SYNC_FAIL.FETCH, lastErrorCode, reason, detail, ledgerKind: 'source_error' });
    }

    // 门 1（哈希）：正文一模一样 ⇒ 一行都不写。lastError 不清（它是历史），但 lastStatus 必须写成 noChange，
    // 否则故障恢复后的第一次「没变化」会被界面读成「还在故障中」。
    if (meta && meta.sha && meta.sha === fetched.sha) {
      try {
        await stores.meta.patch({ keyRule: KEY_RULE_VERSION, lastStatus: 'noChange', lastCheckedAt: at, backoff: 0 });
      } catch (e) {
        return storageFailed(e, at, prefs);
      }
      return withCadence({
        ok: true, status: 'noChange', code: SYNC_NO_CHANGE, at,
        sha: fetched.sha, sourceId: fetched.sourceId, total: Number(meta.total) || 0,
      }, prefs, 0);
    }

    const parsed = parseCatalog(fetched.text);
    if (!parsed.ok) {
      // 门 2（解析）：保留上一次快照 —— 旧目录继续可用，本轮不碰 entries。
      const reason = `正文拿到了但目录读不出：${parsed.fatal}`;
      logger?.warn?.(`[api-catalog] ${reason}（源 ${fetched.sourceId}，${fetched.bytes} B）`);
      return await failRound({
        at, meta, prefs, code: SYNC_PARSE_ERROR, lastErrorCode: SYNC_PARSE_ERROR, reason,
        detail: clipDetail(`解析失败：${parsed.fatal}`), ledgerKind: 'source_error',
      });
    }

    let prevRows;
    let notes;
    try {
      prevRows = await stores.entries.readAll();
      notes = await stores.notes.readAll();
    } catch (e) {
      return storageFailed(e, at, prefs);
    }

    const baseline = !meta || !meta.sha;
    const diff = diffCatalog({ prevRows, nextItems: parsed.entries, notes, at, baseline });

    try {
      await stores.entries.writeMany(diff.rowsToWrite);
      for (const category of diff.rowsToRemove) await stores.entries.remove(category);
      for (const migration of diff.noteMigrations) await stores.notes.migrate(migration);
      for (const slug of diff.noteOrphans) await stores.notes.setOrphan(slug, true);
      for (const slug of diff.noteRelinks) await stores.notes.setOrphan(slug, false);
      await stores.changes.appendMany(diff.ledger);
      // ★ 摘要行写在明细之后：同一 `at` 下它的 seq 最大 ⇒ `allRows` 排序第一 ⇒ `trim` 之后必然留着。
      //   没有这一行，换源那种 2154 行的轮次在界面上只剩 200 行「源里删掉了」（真机读数，§9.1t），
      //   读起来像"这一轮只删了东西"—— 而 117 条新增与 1377 条换分类是被保留上限挤掉的，不是没发生。
      if (diff.ledger.length) {
        await stores.changes.append({ kind: 'round', at, detail: roundSummary(diff.stats, fetched.sourceId) });
      }
      await stores.changes.trim(KEEP_CHANGES);
    } catch (e) {
      // meta 还没写 ⇒ sha 没推进 ⇒ 下一轮重新差分并把这些行覆盖回去（这就是"没有事务"下的补偿）。
      const fail = storageFailed(e, at, prefs);
      return { ...fail, partial: true, reason: `${fail.reason}；本轮已写的行会在下一轮被覆盖` };
    }

    try {
      await stores.meta.patch({
        keyRule: KEY_RULE_VERSION,
        lastStatus: 'success',
        sha: fetched.sha,
        sourceId: fetched.sourceId,
        sourceUrl: fetched.sourceUrl,
        fetchedAt: at,
        lastCheckedAt: at,
        total: parsed.entries.length,
        parseRatio: parsed.report.parseRatio,
        endAnchor: parsed.report.endAnchor,
        counts: diff.counts,
        backoff: 0,
      });
    } catch (e) {
      return { ...storageFailed(e, at, prefs), partial: true };
    }

    return withCadence({
      ok: true, status: 'success', code: 'updated', at,
      sha: fetched.sha, sourceId: fetched.sourceId, sourceUrl: fetched.sourceUrl,
      bytes: fetched.bytes, total: parsed.entries.length, stats: diff.stats,
      ledgerCount: diff.ledger.length, baseline, report: parsed.report,
    }, prefs, 0);
  }

  return {
    get busy() { return running; },

    /**
     * 跑一轮。占用中再触发 ⇒ rejected SyncBusyError（**不是**同步 throw，口径第 1 条）。
     * 返回的 promise 除 busy 这一支外永不 reject。
     * 锁的释放挂在返回给调用方的那个 then 之前 ⇒ 调用方拿到结果时锁已经放开，不会看见"空闲却报忙"。
     */
    run() {
      if (running) return Promise.reject(new SyncBusyError());
      running = true;
      return round()
        .catch((e) => {
          // round 自己已经把各分支包成结构化结果；走到这里只剩"没预料到的崩"（schema 之外的脏数据等）。
          logger?.warn?.(`[api-catalog] 同步本轮以预料之外的方式中断：${e?.stack ?? e}`);
          return withCadence({
            ok: false, status: 'failure', code: SYNC_FAIL.STORAGE,
            reason: `本轮中断：${e?.message ?? e}`, at: clock(), stored: false,
          }, DEFAULT_PREFS, 0);
        })
        .then((result) => { running = false; return result; });
    },
  };
}
