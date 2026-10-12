/**
 * lib/parse.js —— 目录区（`## Index` 或 `## 目录`）→ 条目 + 解析台账。
 *
 * 三条硬口径（spec §4）：
 *  1. 只吃目录区：从起点锚到**下一个二级标题**，没有下一个二级标题就到文件尾
 *     （CN 源实测全文只有一个二级标题，目录区天然到 EOF）。区段外的 APILayer 广告表（3 列）
 *     和 MCP Servers 表（列语义不同）天然进不来，这条是排除的唯一实现处。
 *  2. 宽容但要报数：源文档自己的校验器对英文 master 报 602 条错（2026-10-05 实测），
 *     而它照常合并 ⇒ 零星脏行照收并登记原因，绝不静默丢条目。
 *  3. 读不出就说读不出：`–` / 空 / 反引号包 Yes 之类的脏值一律归 unknown 并登记，
 *     不许冒充 No（冒充会把"没查过"说成"不支持"）。CN 源的半翻译取值走登记好的对照表
 *     （`YESNO_ZH_TO_EN` / `AUTH_ZH_TO_EN`），表外的值——包括鉴权列那个含义不明的「是」——照第 3 条落 unknown。
 *
 * 无第三方依赖，纯字符串处理；同步函数，调用方（lib/sync.js）负责串行与闸门。
 */
import {
  ANCHOR_PAIRS, LEVEL2_PREFIX, CATEGORY_PREFIX, HEADER_CELL, SEPARATOR_MARK,
  DEFAULT_TABLE_COLS, MIN_TABLE_COLS, COLUMNS,
  AUTH_OPTIONS, AUTH_ZH_TO_EN, YESNO_ZH_TO_EN, UNKNOWN,
  DESC_SOFT_LIMIT, MIN_PARSE_RATIO, PARSE_FATAL, SLUG_SEP,
} from './domain.js';

const LINK_CELL_RE = /^\[(.*?)\]\(\s*(\S+?)\s*\)$/s;
const COMBINING_RE = /[\u0300-\u036f]/g;
const NON_KEY_RE = /[^\p{L}\p{N}]+/gu;

/* ------------------------------------------------------------------ *
 * 小工具（每个都单独可测，parseCatalog 只组合它们）
 * ------------------------------------------------------------------ */

/** 去掉反引号与首尾空白（实测 auth/cors 列大量写成 `apiKey` 这种带反引号的形态）。 */
export function unbacktick(v) {
  return String(v ?? '').trim().replace(/`/g, '').trim();
}

/**
 * 名称 → 主键片段：NFD 拆重音、去组合符、小写、只留字母数字。
 * ★ 重音折叠是 §9.2 U-2 的裁定落点：不折叠的话，上游把 É 改成 E 就会被差分认成「删一条 + 加一条」。
 */
export function foldKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(COMBINING_RE, '')
    .toLowerCase()
    .replace(NON_KEY_RE, '');
}

/**
 * 短哈希（FNV-1a 32 位转 base36）：零依赖、跨进程稳定。
 * ★ 同分类同名条目（实测 16 对，如 Animals 下两个 Cat Facts）的后缀**必须与行序无关** ——
 *   用 #2 这种顺序号时，上游删掉前一条会让后一条从 catfacts#2 变成 catfacts，
 *   差分把它认成「删一条 + 加一条」，用户挂在那条上的笔记也跟着掉。
 */
export function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 主键：分类 + 折叠名；给了 url 就再加一段 URL 短哈希（同名消歧用，见 shortHash 那条）。
 * ★ 笔记挂在 slug 上，所以 slug 的稳定性 = 用户资产的稳定性，规则变化必须走差分迁移而不是当场重算。
 */
export function slugOf(category, name, url = '') {
  const base = `${String(category ?? '').trim()}${SLUG_SEP}${foldKey(name)}`;
  return url ? `${base}${SLUG_SEP}${shortHash(normUrl(url))}` : base;
}

/** URL 归一：折尾随空格（实测 3 条链接括号里带空格）、去尾斜杠、保留 query。 */
export function normUrl(raw) {
  let u = String(raw ?? '').trim();
  u = u.replace(/\s+/g, '');                       // 括号内尾随空格与换行续写
  u = u.replace(/\/$/, '');                        // https://x.com/ 与 https://x.com 是同一家
  return u;
}

/** 是否像一条可打开的地址。区里偶尔有人写 `http:` 断链，形状不对就别硬拼 host。 */
export function looksLikeUrl(u) {
  return /^https?:\/\//i.test(u) || /^www\d*\./i.test(u);
}

/** host（小写、去 www. 前缀）；读不出就空串，空串在聚合视图里单独成一组。 */
export function hostOf(url) {
  const u = normUrl(url);
  if (!looksLikeUrl(u)) return '';        // 先过形状闸门：'https://' 去掉尾斜杠会变成 'https:/'，补协议后 new URL 把 scheme 当 hostname 读出来
  const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 标题单元格 → {name,url}；形状不对返回 null 并给 reason。
 * 实测唯一的失败形态是括号内尾随空格，normUrl 已在内部吃掉。
 */
export function parseTitleCell(cell) {
  const m = LINK_CELL_RE.exec(String(cell ?? '').trim());
  if (!m) return { ok: false, reason: '标题格不是 [名称](链接) 形状' };
  const url = normUrl(m[2]);
  if (!looksLikeUrl(url)) return { ok: false, reason: `链接不是 http(s)/www 形状：${url.slice(0, 40)}` };
  const name = m[1].trim();
  if (!name) return { ok: false, reason: '标题名为空' };
  return { ok: true, name, url };
}

/** 鉴权列 → {auth, authRaw?}；枚举外的值不猜，原样留在 authRaw。 */
export function normAuth(cell) {
  const v = unbacktick(cell);
  if (AUTH_OPTIONS.includes(v)) return { auth: v };
  const zh = AUTH_ZH_TO_EN[v];
  if (zh) return { auth: zh };   // CN 源鉴权列写「否」= 不需要认证，语义唯一（实测 9 行）
  return { auth: UNKNOWN, authRaw: v };
}

/** Yes/No 列 → 'Yes' | 'No' | unknown；源文档的 Unknown（及 CN 的「未知」）与一切脏值都归 unknown。 */
export function normYesNo(cell) {
  const v = unbacktick(cell);
  const mapped = YESNO_ZH_TO_EN[v] ?? v;
  if (mapped === 'Yes') return 'Yes';
  if (mapped === 'No') return 'No';
  return UNKNOWN;   // 含源文档写的 Unknown、半角破折号、空、带反引号的 Yes、鉴权列那种含义不明的「是」
}

/**
 * 这格是"源文档自己写了不知道"吗？写了就不进逐格脏值台账 —— 那是源承认没查，不是形状坏了。
 * ★ 中英文两种写法都要认：只认 'Unknown' 的话，CN 源那 50 格「未知」会灌满台账，
 *   台账一长，真脏的那两三格反而没人看（判据钉的是这个，不是那 50 的数字）。
 */
export function isKnownUnknown(cell) {
  const v = unbacktick(cell);
  return v === 'Unknown' || YESNO_ZH_TO_EN[v] === 'Unknown';
}

/** 表头行 / 分隔行判定：这两类不计入 rows。 */
export function isHeaderRow(cells) {
  return unbacktick(cells[0]) === HEADER_CELL;
}
export function isSeparatorLine(line) {
  const t = line.trim();
  return t.includes(SEPARATOR_MARK) || /^\|[\s:|-]+\|$/.test(t);
}

/* ------------------------------------------------------------------ *
 * 区段
 * ------------------------------------------------------------------ */

/**
 * 取目录区的行区间。
 * 起点锚必须**整行相等**（trim 后）—— 子串匹配会被「See the Index below」这类句子命中；
 * 候选锚取自 `ANCHOR_PAIRS`（英文源 `## Index` / CN 源 `## 目录`），两份都在正文里时取**靠前**那一处，
 * 这样同一套代码能吃两种形状，加一档源只改登记表、不改这里。
 * 右界是起点之后的第一个二级标题；**没有就到文件尾**（CN 源实测就是这样）—— 到尾这件事要登记，
 * 不许和"收到了 ## License"混成同一个读数。与配对里写明的右界不一致时只登记（report.endAnchorUnexpected），
 * 不阻断 —— 目录内容仍然可信。
 * @returns {{ok:boolean, fatal?:string, lines:string[], start:number, end:number, endAnchor:string, atEof:boolean}}
 */
export function extractRegion(text) {
  const lines = String(text ?? '').split('\n');
  if (!String(text ?? '').trim()) {
    return { ok: false, fatal: PARSE_FATAL.EMPTY_TEXT, lines: [], start: -1, end: -1, endAnchor: '', atEof: false };
  }
  let start = -1;
  let pair = null;
  for (const candidate of ANCHOR_PAIRS) {
    const i = lines.findIndex((l) => l.trim() === candidate.start);
    if (i !== -1 && (start === -1 || i < start)) { start = i; pair = candidate; }
  }
  if (start === -1) {
    return { ok: false, fatal: PARSE_FATAL.INDEX_ANCHOR_MISSING, lines: [], start: -1, end: -1, endAnchor: '', atEof: false };
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    // LEVEL2_PREFIX 是「## + 空格」，所以 `### x` 天然不匹配（第三个字符是 # 不是空格）
    if (lines[i].trim().startsWith(LEVEL2_PREFIX)) { end = i; break; }
  }
  const atEof = end === -1;
  const stop = atEof ? lines.length : end;
  return {
    ok: true,
    lines: lines.slice(start, stop),
    start,
    end: stop,
    endAnchor: atEof ? '' : lines[end].trim(),
    atEof,
    expectedEnd: pair.end,
  };
}

/** 一行表格 → 单元格数组（尾竖线可省，上游两种写法都有）。 */
export function splitCells(line) {
  const parts = line.split('|');
  const body = parts[parts.length - 1].trim() === '' ? parts.slice(1, -1) : parts.slice(1);
  return body.map((s) => s.trim());
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export function parseCatalog(text) {
  const region = extractRegion(text);
  if (!region.ok) {
    return { ok: false, fatal: region.fatal, entries: [], report: emptyReport(region) };
  }

  const entries = [];
  const report = emptyReport(region);
  if (region.atEof) report.endAtEof = true;
  if (region.expectedEnd && region.endAnchor && region.endAnchor !== region.expectedEnd) {
    report.endAnchorUnexpected = region.endAnchor;   // 只登记，不阻断：右界换了名字不代表目录坏了
  }
  report.headerRows = 0;
  report.separatorRows = 0;

  let category = '';
  let categoryLine = -1;
  // 这一档表的列数由**它自己的分隔行**说了算（CN 的「AI模型」是 4 列，其余 5 列）；分类头一出现就复位。
  let sectionCols = DEFAULT_TABLE_COLS;
  const narrow = new Map();
  const raws = [];

  region.lines.forEach((rawLine, idx) => {
    const lineNo = region.start + idx + 1;          // 台账里报**整份文件的 1 起行号**，方便对着 README 看
    const line = rawLine.trimEnd();
    if (!line) return;

    if (line.startsWith(CATEGORY_PREFIX + ' ') || line.startsWith(CATEGORY_PREFIX + '\t')) {
      category = line.slice(CATEGORY_PREFIX.length).trim();
      categoryLine = lineNo;
      sectionCols = DEFAULT_TABLE_COLS;
      report.categories.push({ name: category, count: 0, line: lineNo });
      return;
    }
    if (!line.startsWith('|')) return;

    const cells = splitCells(line);
    if (isSeparatorLine(line)) {
      report.separatorRows += 1;
      const n = cells.length;
      // 只在"这看起来就是这张表的列尺子"时采信：低于地板（3 列广告表）或超出认识的列数都不改尺子。
      if (n >= MIN_TABLE_COLS && n <= COLUMNS.length) {
        sectionCols = n;
        if (n < DEFAULT_TABLE_COLS && category) narrow.set(category, n);
      }
      return;
    }
    if (isHeaderRow(cells)) { report.headerRows += 1; return; }
    if (cells.length === 0 || cells.every((c) => c === '')) return;

    report.rows += 1;

    if (!category) {
      report.skipped.push({ line: lineNo, reason: '这行表格在任何一个三级分类标题之前', cell: cells[0]?.slice(0, 60) ?? '' });
      return;
    }
    if (cells.length < sectionCols) {
      report.skipped.push({ line: lineNo, reason: `列数不足（有 ${cells.length}，这一档表 ${sectionCols} 列）`, cell: cells[0]?.slice(0, 60) ?? '' });
      return;
    }

    const title = parseTitleCell(cells[0]);
    if (!title.ok) {
      report.skipped.push({ line: lineNo, reason: title.reason, cell: cells[0].slice(0, 60) });
      return;
    }

    const desc = cells[1];
    const auth = normAuth(cells[2]);
    const https = normYesNo(cells[3]);
    const hasCors = cells.length >= 5;
    const cors = hasCors ? normYesNo(cells[4]) : UNKNOWN;

    if (desc.length > DESC_SOFT_LIMIT) {
      report.overLongDesc.push({ line: lineNo, len: desc.length, name: title.name });
    }
    if (!desc) report.emptyDesc.push({ line: lineNo, name: title.name });
    if (auth.auth === UNKNOWN) report.unknownFields.push({ line: lineNo, column: 'auth', value: auth.authRaw });
    if (https === UNKNOWN && !isKnownUnknown(cells[3])) report.unknownFields.push({ line: lineNo, column: 'https', value: unbacktick(cells[3]) });
    // 这一档表压根没有 CORS 列时不往 unknownFields 里灌（那是"源没写"，不是"这格脏"），它在 narrowSections 里成一条账。
    if (hasCors && cors === UNKNOWN && !isKnownUnknown(cells[4])) report.unknownFields.push({ line: lineNo, column: 'cors', value: unbacktick(cells[4]) });

    raws.push({
      line: lineNo,
      category,
      categoryLine,
      name: title.name,
      url: title.url,
      host: hostOf(title.url),
      desc,
      auth: auth.auth,
      ...(auth.authRaw ? { authRaw: auth.authRaw } : {}),
      https,
      cors,
    });
  });

  /*
   * 第二遍：定主键。★ 必须两遍扫 —— 单遍"第一条拿干净主键、第二条起加哈希后缀"的写法仍依赖行序：
   * 上游删掉同名同分类的第一条后，第二条会从 slugA::hash 变成 slugA，用户挂在 slugA 上的笔记就串到了
   * 另一个 API 上。规则改成按**组**裁定：同名同分类只有一个地址时主键不带后缀；多于一个地址时全组都带。
   * 这样主键集合与行序无关（test/parse.test.mjs 用倒序解析钉这条）。
   */
  const urlsPerBase = new Map();
  for (const raw of raws) {
    const base = slugOf(raw.category, raw.name);
    const set = urlsPerBase.get(base) || new Set();
    set.add(raw.url);
    urlsPerBase.set(base, set);
  }
  const taken = new Set();
  const urlSeen = new Map();
  const catRowByLine = new Map(report.categories.map((c) => [c.line, c]));
  for (const raw of raws) {
    const base = slugOf(raw.category, raw.name);
    const multi = (urlsPerBase.get(base) || new Set()).size > 1;
    const slug = multi ? slugOf(raw.category, raw.name, raw.url) : base;
    if (taken.has(slug)) {
      // 同名同址（上游把一条写了两遍）：留第一条，第二条登记后丢掉，不生成两个可挂笔记的同址主键
      report.exactDups.push({ line: raw.line, name: raw.name, url: raw.url, category: raw.category });
      continue;
    }
    // dupSlugs 只记**真正成条**的那些行：被 exactDups 丢掉的那条已经另有账，一条行不该同时进两个台账
    if (multi) report.dupSlugs.push({ line: raw.line, name: raw.name, url: raw.url, category: raw.category, slug });
    taken.add(slug);
    const urlN = (urlSeen.get(raw.url) || 0) + 1;
    urlSeen.set(raw.url, urlN);
    if (urlN > 1) report.dupUrls.push({ line: raw.line, url: raw.url, name: raw.name, category: raw.category });

    const catRow = catRowByLine.get(raw.categoryLine);
    if (catRow) catRow.count += 1;
    entries.push({ slug, ...raw });
    report.parsed += 1;
  }

  // 「这一档表少一列」按分类成一条账：源没给 CORS 列 ≠ 这格是脏值，两者不能混进同一份台账。
  const rowsByCategory = new Map(report.categories.map((c) => [c.name, c.count]));
  report.narrowSections = [...narrow.entries()]
    .map(([name, cols]) => ({ category: name, cols, rows: rowsByCategory.get(name) || 0 }));

  finishReport(report, entries);

  const fatal = report.rows === 0
    ? PARSE_FATAL.ROWS_ZERO
    : report.parseRatio < MIN_PARSE_RATIO ? PARSE_FATAL.BELOW_RATIO : '';
  return { ok: !fatal, ...(fatal ? { fatal } : {}), entries, report };
}

function emptyReport(region) {
  return {
    region: { start: region.start, end: region.end, lineCount: region.lines.length },
    endAnchor: region.endAnchor || '',
    endAtEof: false,
    endAnchorUnexpected: '',
    rows: 0,
    parsed: 0,
    categories: [],
    skipped: [],
    overLongDesc: [],
    emptyDesc: [],
    unknownFields: [],
    narrowSections: [],
    dupSlugs: [],
    exactDups: [],
    dupUrls: [],
    counts: {},
    hosts: [],
    parseRatio: 0,
  };
}

/** 台账收尾：派生计数与聚合，全在这里算一次，界面与查询都不再各自数。 */
function finishReport(report, entries) {
  const byAuth = {};
  const byHttps = { Yes: 0, No: 0, unknown: 0 };
  const byCors = { Yes: 0, No: 0, unknown: 0 };
  for (const e of entries) {
    byAuth[e.auth] = (byAuth[e.auth] || 0) + 1;
    byHttps[e.https] += 1;
    byCors[e.cors] += 1;
  }
  const hosts = new Map();
  for (const e of entries) hosts.set(e.host, (hosts.get(e.host) || 0) + 1);

  report.counts = {
    entries: entries.length,
    byAuth,
    byHttps,
    byCors,
    noKey: byAuth.No || 0,
    browserDirect: entries.filter((e) => e.auth === 'No' && e.cors === 'Yes' && e.https === 'Yes').length,
    categoryCount: report.categories.length,
    emptyCategory: report.categories.filter((c) => c.count === 0).map((c) => c.name),
  };
  report.hosts = [...hosts.entries()]
    .filter(([h]) => h)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([host, count]) => ({ host, count }));
  report.parseRatio = report.rows === 0 ? 0 : report.parsed / report.rows;
}
