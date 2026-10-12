/**
 * lib/stores.js —— 七表仓储（entries / meta / notes / prefs / changes / trans / secrets），
 * 共用 kv-records-base 的域登记表。
 *
 * 与 sysops / modelwatch / gh-trending 同口径：
 *  · 域名字排他，同一设施同一域只 open 一次（七张表共用 api_catalog 一个域）；
 *  · 写全部走串行队列（KV 没有事务，串行是唯一能保证「谁最后写」确定的办法）；
 *  · 脏行在 put 之前被 schema 挡下并包成带 code 的 INVALID；
 *  · 读用 `[...t.entries()]` —— entries() 是 lazy iterator，Node 22+ 上 `.map()` 不报错但返回另一个迭代器。
 *
 * 本插件独有的一条（per-record 带来的）：键由 lib/keys.js 现算，这里**不再重复挡一道** ——
 * 挡不住的东西由两处兜：test/keys.test.mjs 在真数据上钉「51 类 / 2019 条键全合规且互不相同」，
 * test/_helpers.mjs 的假设施重现宿主 put 闸门（写不过就抛）。编码层一旦回归，离线面当场炸，
 * 而不是像真机那样「读侧静默当不存在」（dsh-storage-json/lib/index.js:416）把批注变成看不见的文件。
 *
 * ★ 校验失败必须是 **rejected promise**，不能是同步 throw：宿主半边这些方法都在定时器回调里被 await，
 *   同步异常从 timer 回调里漏出去会把宿主整块打挂（modelwatch 定时器血案同条教训）。
 *   repo.enqueue 里的 async 回调天然是 rejected promise，别在外层再包同步校验。
 */
import {
  TABLES, AC_DOMAIN, DOMAIN_NAME, META_KEY, PREFS_KEY, ENTRY_ROW_VERSION,
  DEFAULT_PREFS, CHECK_INTERVALS, SOURCES, PROXY_MODES,
  TRANS_CHANNEL_IDS, TRANS_CRED_FIELDS, TRANS_CRED_MAX, DEFAULT_TRANS_CHANNEL, TRANS_HAN_RE,
} from './domain.js';
import { categoryKey, noteKey, transKey, transNorm, secretKey } from './keys.js';
import { acquireDomain, releaseDomain, createRecordRepo, RecordsError, RECORDS_ERROR } from './kv-records-base.js';

function repoFor({ getFacility, logger }, table) {
  return createRecordRepo({ getFacility, logger, domain: AC_DOMAIN, table });
}

/* ------------------------------------------------------------------ *
 * entries：一个分类一行
 * ------------------------------------------------------------------ */

export function createEntriesStore(opts = {}) {
  const repo = repoFor(opts, TABLES.entries);

  return {
    get available() { return repo.available; },
    close: () => repo.close(),

    read(category) {
      const key = categoryKey(category);
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(key);
        return row === undefined ? null : row;
      });
    },

    /** 全部分类行（一轮差分的起点）。行级脏值不拖死别的行：读的是原始 map，schema 只在写侧挡。 */
    readAll() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        return [...t.entries()].map(([, v]) => v);
      });
    },

    /** 摊平成「slug → 条目」的全量视图（查询层与差分的取数口）。 */
    readAllItems() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const out = [];
        for (const [, row] of [...t.entries()]) out.push(...(row.items || []));
        return out;
      });
    },

    /**
     * 写一个分类行。调用方给 {category, items, updatedAt}，rowVersion 在这里补 ——
     * 让调用方各写一遍版本号，早晚有一处忘了升。
     */
    write({ category, items, updatedAt }) {
      const key = categoryKey(category);
      return repo.enqueue(async () => {
        const value = repo.parseOrInvalid({ category, rowVersion: ENTRY_ROW_VERSION, updatedAt, items });
        const t = await repo.tableOf();
        await t.put(key, value);
        return value;
      });
    },

    /**
     * 一批分类行，串行写完再返回。
     * ⚠️ 中途失败就是**部分写入**（KV 没有事务，这里没有回滚可言）。sync 靠"先写 entries、最后写 meta"
     *   的顺序兜住：meta 的 sha 没推进 ⇒ 下一轮认定本轮没成功，重新差分并把所有分类行覆盖回去。
     */
    writeMany(rows) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const written = [];
        for (const row of rows) {
          const key = categoryKey(row.category);
          const value = repo.parseOrInvalid({ ...row, rowVersion: ENTRY_ROW_VERSION });
          await t.put(key, value);
          written.push(key);
        }
        return written;
      });
    },

    remove(category) {
      const key = categoryKey(category);
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        await t.delete(key);
        return key;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * meta：一行快照坐标
 * ------------------------------------------------------------------ */

export function createMetaStore(opts = {}) {
  const repo = repoFor(opts, TABLES.meta);

  return {
    get available() { return repo.available; },
    close: () => repo.close(),

    /** 原始行（没有就 null）。键规则版本由调用方判：这里不替它决定"对不上怎么办"。 */
    read() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(META_KEY);
        return row === undefined ? null : row;
      });
    },

    /** 读-并-写整行：只发半份 = 把其余键静默抹掉（sysops 最终评审 Critical-1 同条教训）。 */
    patch(fields) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const cur = t.get(META_KEY) ?? {};
        const merged = repo.parseOrInvalid({ ...cur, ...(fields && typeof fields === 'object' ? fields : {}) });
        await t.put(META_KEY, merged);
        return merged;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * notes：一条批注一行（键 = noteKey(slug)）
 * ------------------------------------------------------------------ */

export function createNotesStore(opts = {}) {
  const repo = repoFor(opts, TABLES.notes);

  return {
    get available() { return repo.available; },
    close: () => repo.close(),

    read(slug) {
      const key = noteKey(slug);
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(key);
        return row === undefined ? null : row;
      });
    },

    readAll() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const map = new Map();
        for (const [, v] of [...t.entries()]) map.set(v.slug, v);
        return map;
      });
    },

    /** 写整行（不是 patch）：批注的字段就是界面那一份，读-改-写在调用方已经完成。 */
    write(note) {
      const key = noteKey(note.slug);
      return repo.enqueue(async () => {
        const value = repo.parseOrInvalid(note);
        const t = await repo.tableOf();
        await t.put(key, value);
        return { value, key };
      });
    },

    remove(slug) {
      const key = noteKey(slug);
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        await t.delete(key);
        return key;
      });
    },

    /**
     * 搬家：slug 变了（上游改了分类名）⇒ 键跟着变。读旧行、改字段、写新键、删旧键。
     * 返回 null 表示没有旧笔记可搬（差分不许为不存在的笔记生成迁移流水）。
     * ⚠️ 这四步不是一个事务：中途失败可能新旧两行都在。宁可重一行也不许丢 ——
     *   下一轮按新键读到就是新键那份，旧键的残留由 sync 的收尾清理再删一次。
     * ⚠️ 两条 slug 撞进同一个键时（32 位哈希并非不可能，而这里的后果是**删掉用户的批注**）
     *   就地改行、不删旧键：先 put 后 delete 同一个键等于把笔记删了。
     */
    migrate({ fromSlug, toSlug, category }) {
      const fromKey = noteKey(fromSlug);
      const toKey = noteKey(toSlug);
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const cur = t.get(fromKey);
        if (cur === undefined) return null;
        const moved = repo.parseOrInvalid({ ...cur, slug: toSlug, category });
        await t.put(toKey, moved);
        if (toKey !== fromKey) await t.delete(fromKey);
        return moved;
      });
    },

    /** 上游删条目 ⇒ 笔记转 orphan 不跟着删（笔记是用户资产）；重新出现则接回。 */
    setOrphan(slug, orphan) {
      const key = noteKey(slug);
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const cur = t.get(key);
        if (cur === undefined) return null;
        const next = repo.parseOrInvalid({ ...cur, orphan });
        await t.put(key, next);
        return next;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * changes：追加式差分流水
 * ------------------------------------------------------------------ */

/**
 * 流水表：一轮同步写若干行，只增不改。
 * id = `c-<毫秒>-<同毫秒序号>`（宿主发号，界面不许自带 id）—— 同一毫秒里 append 多行是常态
 * （一轮加 30 条不会正好错开毫秒），所以序号必须有，否则后一条覆盖前一条。
 */
export function createChangesStore(opts = {}) {
  const repo = repoFor(opts, TABLES.changes);
  const now = opts.now ?? (() => Date.now());
  let seq = 0;
  let lastAt = -1;

  async function allRows(t) {
    return [...t.entries()].map(([, v]) => v).sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1));
  }

  return {
    get available() { return repo.available; },
    close: () => repo.close(),

    append({ kind, at, slug = '', name = '', category = '', detail = '' }) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const when = at ?? now();
        if (when === lastAt) seq += 1; else { lastAt = when; seq = 0; }
        const row = repo.parseOrInvalid({
          id: `c-${when}-${String(seq).padStart(4, '0')}`, at: when, kind,
          slug: slug || undefined, name: name || undefined,
          category: category || undefined, detail: detail || undefined,
        });
        await t.put(row.id, row);
        return row;
      });
    },

    /** 一批流水（一轮差分攒好了一起发，省得 sync 里每行都排一次队）。 */
    appendMany(rows) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const out = [];
        for (const r of rows) {
          const when = r.at ?? now();
          if (when === lastAt) seq += 1; else { lastAt = when; seq = 0; }
          const row = repo.parseOrInvalid({
            id: `c-${when}-${String(seq).padStart(4, '0')}`, at: when, kind: r.kind,
            slug: r.slug || undefined, name: r.name || undefined,
            category: r.category || undefined, detail: r.detail || undefined,
          });
          await t.put(row.id, row);
          out.push(row);
        }
        return out;
      });
    },

    /** limit 钳在 [1,500]；kind 传了就只回那一类（界面「只看新增」不扫全表）。 */
    list(limit = 100, kind = '') {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        let rows = await allRows(t);
        if (kind) rows = rows.filter((r) => r.kind === kind);
        const n = Number(limit);
        const eff = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.trunc(n))) : 100;
        return rows.slice(0, eff);
      });
    },

    trim(keep) {
      return repo.enqueue(async () => {
        const n = Number(keep);
        if (!Number.isFinite(n) || n < 1) return 0;
        const t = await repo.tableOf();
        const rows = await allRows(t);
        const doomed = rows.slice(n);
        for (const row of doomed) await t.delete(row.id);
        return doomed.length;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * prefs：一行偏好
 * ------------------------------------------------------------------ */
/**
 * 钳制偏好。两个口径：
 *  · 间隔不在档位表里 ⇒ 回落默认（存进库里的必须是档位，不是"随便一个数"）；
 *  · 源优先级只认已登记的 id，并把没排进去的源补在末尾 ⇒ **任何一轮都会把所有源试一遍**，
 *    用户把某个源排到最后不代表可以永远不试它。
 * 代理两格（`proxyMode` / `proxyUrl`）是 2026-10-07 加的：旧口径「本插件没有代理开关」被 `lib/net.js`
 * 那条 CONNECT 隧道路改判了（证据与来龙去脉在 domain.js 的 PROXY 那一节与 §9.1r）。
 *
 * ★ 现译那几格多一条律：**开关只认 `true`**。这一格后面挂的是"要不要花用户的额度/密钥"，
 *   库里躺着外部改出来的 `'yes'` / `1` 时按关处理 —— 宁可少发一发，不可多发一发（同 gh-trending 的 llm 开关口径）。
 *   渠道脏值回落出厂档：这一格决定往**哪个域名**出网，不许把没登记的值带进运行时。
 * ★ 代理两格（S16）同一条律：`proxyMode` 脏值回落 `system`（它决定这一发从哪条路出去），
 *   而 `proxyUrl` 里只要出现 `user:pass@` 就**整格洗成空**并点名 —— 写侧（lib/api.js）本来就不收它，
 *   这一道是给"外部直接改库里那行 JSON"兜底：prefs 整份推给浏览器，代理密码漏进去一次就是漏一整屏。
 */
function clampPrefs(raw, logger) {
  // 只认这张表里声明过的键（{...DEFAULT_PREFS, ...raw} 会把旧版留存的、已经没人读的字段一路带进返回值，
  // schema 落库时丢它，但读侧那份"看起来还在"的字段会让界面以为开关存在而它其实不生效）。
  // ★ 也正因为只认声明过的键，任何凭据字段都进不了 prefs —— 而 prefs 是整份推给浏览器的（snapshotOf）。
  const p = { ...DEFAULT_PREFS };
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (src[key] !== undefined) p[key] = src[key];
  }
  if (!CHECK_INTERVALS.includes(Number(p.intervalMin))) {
    if (raw && raw.intervalMin !== undefined) {
      logger?.warn?.(`[api-catalog] 库里的检查间隔不是档位（${raw.intervalMin}），已回落 ${DEFAULT_PREFS.intervalMin} 分钟`);
    }
    p.intervalMin = DEFAULT_PREFS.intervalMin;
  } else p.intervalMin = Number(p.intervalMin);

  const known = SOURCES.map((s) => s.id);
  const rawList = Array.isArray(p.sourcePriority) ? p.sourcePriority : [];
  const picked = [...new Set(rawList.filter((id) => known.includes(id)))];
  if (rawList.length && picked.length < new Set(rawList).size) {
    logger?.warn?.(`[api-catalog] 源优先级里有未登记的 id（${rawList.filter((id) => !known.includes(id)).join(', ')}），已丢弃`);
  }
  p.sourcePriority = [...picked, ...known.filter((id) => !picked.includes(id))];

  p.transEnabled = p.transEnabled === true;
  if (!TRANS_CHANNEL_IDS.includes(p.transChannel)) {
    if (raw && raw.transChannel !== undefined) {
      logger?.warn?.(`[api-catalog] 库里的现译渠道没登记（${p.transChannel}），已回落 ${DEFAULT_TRANS_CHANNEL}`);
    }
    p.transChannel = DEFAULT_TRANS_CHANNEL;
  }

  // 代理模式脏值回落 `system`：这一格决定这一发从哪条路出去，没登记的值不许带进运行时（同渠道那一支）。
  if (!PROXY_MODES.includes(p.proxyMode)) {
    if (raw && raw.proxyMode !== undefined) {
      logger?.warn?.(`[api-catalog] 库里的代理模式没登记（${p.proxyMode}），已回落 ${DEFAULT_PREFS.proxyMode}`);
    }
    p.proxyMode = DEFAULT_PREFS.proxyMode;
  }
  // ★ 带 `user:pass@` 的地址整格洗空（写侧不收，这一道是给直接改库里 JSON 那种来路兜底）：
  //   prefs 整份推给浏览器，代理密码漏进来一次就是跟着每一帧首屏出去一趟。
  p.proxyUrl = String(p.proxyUrl ?? '').trim();
  if (p.proxyUrl.includes('@')) {
    logger?.warn?.('[api-catalog] 库里的代理地址带 user:pass@，这一格整格清空（代理密码不进 prefs）');
    p.proxyUrl = '';
  }
  return p;
}

export function createPrefsStore(opts = {}) {
  const repo = repoFor(opts, TABLES.prefs);
  const logger = opts.logger;

  return {
    get available() { return repo.available; },
    close: () => repo.close(),

    /**
     * 读偏好。默认宽容（界面永远拿到可用值），`{strict:true}` 把「域不可用」如实抛给调用方 ——
     * 装配层要靠这一次区分决定能力位：宽容地把 open 失败当"没写过偏好"，界面上就会显示「存储在位」而写不进去。
     */
    read(readOpts = {}) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(PREFS_KEY);
        return clampPrefs(row === undefined ? null : row, logger);
      }).catch((e) => {
        // 域不可用不是崩溃：回落默认值，界面经 available 位知道「写不进去」（spec §8 降级）。
        if (readOpts.strict) throw e;
        if (e?.code === RECORDS_ERROR.UNAVAILABLE || e?.code === RECORDS_ERROR.CLOSED) return clampPrefs(null, logger);
        throw e;
      });
    },

    /** 读-并-写整行；回给调用方的是 merged 而不是入库那份（proxyUrl='' 会被 schema 洗成没这个键）。 */
    patch(fields) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const cur = t.get(PREFS_KEY) ?? {};
        const merged = clampPrefs({ ...cur, ...(fields && typeof fields === 'object' ? fields : {}) }, logger);
        await t.put(PREFS_KEY, repo.parseOrInvalid(merged));
        return merged;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * trans：一句原文一行（键 = transKey(原文)）
 * ------------------------------------------------------------------ */

/**
 * 现译表。一行 = **一句原文**，不是一条条目 ⇒ 同句话在 2019 条里只译一遍，条目搬家也不作废。
 * 失败行照存（口径见 domain.js 的 transRow）。
 */
export function createTransStore(opts = {}) {
  const repo = repoFor(opts, TABLES.trans);

  return {
    get available() { return repo.available; },
    close: () => repo.close(),

    /** 按原文取行（内部把归一化收在这一处，调用方传原样文字即可）。 */
    read(src) {
      const key = transKey(src);
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(key);
        return row === undefined ? null : row;
      });
    },

    readAll() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        return [...t.entries()].map(([, v]) => v);
      });
    },

    /**
     * 读侧join 用的那份映射：只带**真译成**的行（有 zh、且 zh 里有汉字）。
     * ★ 汉字这一道不是多疑：库里可能躺着别的版本写下的"译文就是英文原文"那种行，
     *   那种行进了映射，界面上就会出现一句顶着中文标签的英文。
     */
    async zhMap() {
      const rows = await this.readAll();
      const map = new Map();
      for (const row of rows) {
        if (row && row.ok === true && typeof row.zh === 'string' && TRANS_HAN_RE.test(row.zh)) {
          map.set(row.src, { zh: row.zh, channel: row.channel, at: row.at });
        }
      }
      return map;
    },

    /** 两个计数（设置页的「已存 N 条 · 失败 M 条」）。失败行也在表里，所以分开数才有意义。 */
    async counts() {
      const rows = await this.readAll();
      let ok = 0;
      let failed = 0;
      for (const row of rows) (row && row.ok === true ? (ok += 1) : (failed += 1));
      return { rows: rows.length, ok, failed };
    },

    put(row) {
      const src = transNorm(row && row.src);
      const key = transKey(src);
      return repo.enqueue(async () => {
        // 行里存的必须是归一后的那一份：zhMap 用行里的 src 当键，而读侧查的是归一后的原文。
        const value = repo.parseOrInvalid({ ...row, src });
        const t = await repo.tableOf();
        await t.put(key, value);
        return { value, key };
      });
    },

    putMany(rows) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const out = [];
        for (const row of rows) {
          const src = transNorm(row && row.src);
          const value = repo.parseOrInvalid({ ...row, src });
          await t.put(transKey(src), value);
          out.push(transKey(src));
        }
        return out;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * secrets：一个渠道的一个凭据字段一行（★ 宿主专用：任何 GET 路由都不许碰）
 * ------------------------------------------------------------------ */

/**
 * 渠道凭据。它存在的**唯一理由**是：prefs 会被 snapshotOf 整份推给浏览器，
 * 所以密钥只要进了 prefs 就必然出网一趟。这里把它单独关一张表，
 * 判据因此是结构性的（路由表里没有一条 GET 引用它），不是"发之前记得摘掉"。
 *
 * 三条写死的规矩：
 *  · 只有登记过的 `channel` + `field` 组合能写（清单从 TRANS_CRED_FIELDS 派生，不手抄）；
 *  · 值**只做长度闸门**，不做归一化 —— 把用户的密钥 trim/大小写折叠成另一个串等于换了一把钥匙还自称存原样；
 *  · 任何读出去的方法都不带值：`describe()` 只回 `{configured, chars, at}`，`get()` 只给宿主半边的 translator 用。
 */
export function createSecretsStore(opts = {}) {
  const repo = repoFor(opts, TABLES.secrets);
  const logger = opts.logger;

  function locate(channel, field) {
    const ch = String(channel ?? '');
    const fd = String(field ?? '');
    if (!TRANS_CHANNEL_IDS.includes(ch)) {
      throw new RecordsError(RECORDS_ERROR.INVALID, `渠道没登记：${JSON.stringify(ch)}`);
    }
    const spec = (TRANS_CRED_FIELDS[ch] || []).find((f) => f.id === fd);
    if (!spec) throw new RecordsError(RECORDS_ERROR.INVALID, `渠道 ${ch} 没有 ${JSON.stringify(fd)} 这个字段`);
    return spec;
  }

  return {
    get available() { return repo.available; },
    close: () => repo.close(),

    /** 宿主半边取值（唯一能把 value 读出来的口子）。 */
    read(channel, field) {
      let key;
      try {
        locate(channel, field);
        key = secretKey(channel, field);
      } catch (e) { return Promise.reject(e); }
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(key);
        return row === undefined ? null : row;
      });
    },

    /** 写值。返回的是**摘要**（chars + at），value 一个字都不回（连调用方的日志都不进）。 */
    write({ channel, field, value, at }) {
      // 与 read/remove 同一条口径：脏组合也是 rejected promise（同步 throw 会从调用栈里逃出去）。
      let spec;
      try {
        spec = locate(channel, field);
      } catch (e) { return Promise.reject(e); }
      const v = typeof value === 'string' ? value : '';
      if (!v) return Promise.reject(new RecordsError(RECORDS_ERROR.INVALID, `${spec.label} 是空的（要清除请用清除接口，不是填空串）`));
      const max = Math.min(Number(spec.max) || TRANS_CRED_MAX, TRANS_CRED_MAX);
      if (v.length > max) {
        return Promise.reject(new RecordsError(RECORDS_ERROR.INVALID, `${spec.label} 长 ${v.length} 字，上限 ${max} 字`));
      }
      const key = secretKey(channel, field);
      return repo.enqueue(async () => {
        const value2 = repo.parseOrInvalid({ channel, field, value: v, at, chars: v.length });
        const t = await repo.tableOf();
        await t.put(key, value2);
        logger?.info?.(`[api-catalog] 已写入 ${channel}.${field}（${v.length} 位）；值本身不回显`);
        return { channel, field, configured: true, chars: v.length, at: value2.at };
      });
    },

    remove(channel, field) {
      let key;
      try {
        locate(channel, field);
        key = secretKey(channel, field);
      } catch (e) { return Promise.reject(e); }
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        await t.delete(key);
        return { channel, field, configured: false, chars: 0, at: 0 };
      });
    },

    /**
     * 全渠道的凭据**形状**：每个登记过的字段一格，值只有 configured/chars/at。
     * 清单来自 TRANS_CRED_FIELDS ⇒ 加一个字段不用改界面，加一个渠道也不用。
     */
    async describe() {
      const rows = await repo.enqueue(async () => {
        const t = await repo.tableOf();
        return [...t.entries()].map(([, v]) => v);
      });
      const byKey = new Map(rows.map((r) => [secretKey(r.channel, r.field), r]));
      const out = {};
      for (const [channel, fields] of Object.entries(TRANS_CRED_FIELDS)) {
        out[channel] = {};
        for (const f of fields) {
          const row = byKey.get(secretKey(channel, f.id));
          out[channel][f.id] = row
            ? { configured: true, chars: Number(row.chars) || 0, at: Number(row.at) || 0 }
            : { configured: false, chars: 0, at: 0 };
        }
      }
      return out;
    },

    /** 这一档是否填齐（宿主半边判断"能不能发"，界面只看到 describe 里那两个布尔）。 */
    async hasAll(channel) {
      const fields = TRANS_CRED_FIELDS[channel] || [];
      if (!fields.length) return false;
      for (const f of fields) {
        // ★ optional 的字段不挡闸门：留空时由发送侧回落登记里的默认值（腾讯的地域），
        //   逼用户填一个他本来可以不管的字符串，只会多一个填错的地方。
        if (f.optional === true) continue;
        const row = await this.read(channel, f.id).catch(() => null);
        if (!row || !row.value) return false;
      }
      return true;
    },
  };
}

export function createAllStores(opts = {}) {
  return {
    entries: createEntriesStore(opts),
    meta: createMetaStore(opts),
    notes: createNotesStore(opts),
    prefs: createPrefsStore(opts),
    changes: createChangesStore(opts),
    trans: createTransStore(opts),
    secrets: createSecretsStore(opts),
    async closeAll() {
      await Promise.all([
        this.entries.close(), this.meta.close(), this.notes.close(),
        this.prefs.close(), this.changes.close(), this.trans.close(), this.secrets.close(),
      ]);
    },
    get domainName() { return DOMAIN_NAME; },
  };
}

export { RECORDS_ERROR, RecordsError, acquireDomain, releaseDomain };
