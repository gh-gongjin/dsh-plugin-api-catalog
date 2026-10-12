/**
 * lib/api.js —— 路由表 + SSE hub（spec §6 与 §8）。
 *
 * 三条外部契约先写在这里，因为它们是踩过别的插件才知道的：
 *  1. **宿主只给 handler 传 (req, res)** —— 第三个参数只有测试会喂，所以 POST body 必须自己从流里拼
 *     （sysops、appearance 各被这条圆过一次：离线用例喂 body，真机拿不到）。
 *  2. 写操作只认回环地址：门在路由表上逐条声明（`loopback: true`），入口不重复一道 ——
 *     "每条 POST 都声明了"由 test/api.test.mjs 钉住。这个服务只听本机，但一旦有人把它反代出去，
 *     面板就成了改库的口子。
 *  3. SSE 的 update 帧**带整份 snapshot**（形状与 GET /snapshot 一致）。带"变了哪几行"的增量帧
 *     意味着客户端要自己拼，而拼错一次的后果是界面显示一份不存在的目录（gh-trending S17 的教训）。
 *  4. **`secrets` 表没有任何 GET 能碰到它**（S8 裁定：AppID 与密钥不进 prefs）。这一条是结构性的，
 *     不靠"记得剥字段"：`snapshotOf` 把 prefs **整份**推给浏览器，所以凭据压根不进 prefs；
 *     而 GET 路由里出现 `stores.secrets` 就是破口 —— 由 test/api.test.mjs 按路由表逐条判，清单从表里派生。
 *
 * 帧语义（`: ok` 冲缓冲、25 s `: ping` 心跳、心跳写失败当场摘牌）是 sysops / modelwatch / gh-trending
 * 那份的同源拷贝，只改了插件自己的名字。
 */
import {
  ROUTE_PREFIX, GLOBAL_KEY, SYNC_BUSY, CHECK_INTERVALS, SOURCES,
  NOTE_PURPOSE_MAX_LEN, SEARCH_DEFAULT_LIMIT, SEARCH_LIMIT_MAX, SEARCH_OFFSET_MAX, HOST_AGG_MIN,
  TAG_MAX_LEN, TAG_MAX_COUNT,
  TRANS_CHANNEL_IDS, TRANS_CRED_FIELDS, TRANS_CRED_MAX,
  PROXY_MODES, PROXY_MODE_LABELS, PROXY_URL_MAX, PROXY_URL_BOUNDARY,
  TRANSPORT_VIA_LABELS, transportSourceLabel, transportLine,
} from './domain.js';
import { parseProxyUrl } from './net.js';
import { RECORDS_ERROR } from './kv-records-base.js';

export { ROUTE_PREFIX, GLOBAL_KEY };

export const SSE_HEARTBEAT_MS = 25000;
const MAX_BODY_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 响应与错误
 * ------------------------------------------------------------------ */

/** 错误码 → HTTP 状态。界面按 code 说话，中文 reason 只给人看（不许反过来从中文里猜码）。 */
export const HTTP_BY_CODE = {
  BAD_JSON: 400,
  INVALID_PARAM: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  [SYNC_BUSY.code]: SYNC_BUSY.http,
  STORAGE_UNAVAILABLE: 503,
};

export function statusFor(code) {
  return HTTP_BY_CODE[String(code)] ?? 500;
}

export function errBody(code, message) {
  return { ok: false, error: { code: String(code || 'INTERNAL'), message: String(message ?? '') } };
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
  return true;
}

export function jsonOk(res, data) {
  return json(res, 200, { ok: true, data });
}

export class ApiError extends Error {
  constructor(code, message) {
    super(String(message ?? code));
    this.code = String(code);
  }
}

/** 存储侧的错要转成 503：那不是"参数不对"，重试与改参数都不如一句"存储坏了"有用。 */
function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e?.code === SYNC_BUSY.code) return new ApiError(SYNC_BUSY.code, e?.message);
  const code = e?.code;
  if (code === RECORDS_ERROR.UNAVAILABLE || code === RECORDS_ERROR.CLOSED || code === RECORDS_ERROR.INVALID) {
    return new ApiError('STORAGE_UNAVAILABLE', `本地存储这一侧没走通：${e?.message ?? e}`);
  }
  return new ApiError(code || 'INTERNAL', e?.message ?? String(e));
}

/* ------------------------------------------------------------------ *
 * 请求门面
 * ------------------------------------------------------------------ */

/**
 * 从流里拼 POST body。
 * ★ `req.__parsedBody` 是宿主某些版本已经解析好的那份 —— 有就直接用，没有才自己读流。
 *   只走自己读流这一条也行，但那时候要先确认宿主不会先把流消费掉（试过一次两边都读=第二发空）。
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req && typeof req === 'object' && req.__parsedBody && typeof req.__parsedBody === 'object') {
      return resolve(req.__parsedBody);
    }
    if (!req || typeof req.on !== 'function') return resolve({});
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += (c && c.length) || 0;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError('BAD_JSON', '请求体过大'));
        req.destroy?.();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const parsedJson = JSON.parse(text);
        if (!parsedJson || typeof parsedJson !== 'object') throw new Error('不是对象');
        resolve(parsedJson);
      } catch {
        reject(new ApiError('BAD_JSON', '请求体不是合法 JSON 对象'));
      }
    });
    req.on('error', (e) => reject(new ApiError('BAD_JSON', String(e?.message ?? e))));
  });
}

export function isLoopback(req) {
  const addr = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
  const direct = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
  if (!direct) return false;
  // 经由代理进来时 remoteAddress 仍是本机，但 x-forwarded-for 会露出真正的来源 —— 那一跳不是回环就不算。
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded.every((hop) => hop === '127.0.0.1' || hop === '::1' || hop.startsWith('::ffff:127.0.0.1'));
}

function toUrl(raw) {
  if (raw instanceof URL) return raw;
  const s = String(raw || '/');
  if (/^https?:\/\//i.test(s)) return new URL(s);
  return new URL(s, 'http://127.0.0.1');
}

/** 摘掉路由前缀：注册的是 prefix，宿主把整条路径递进来。 */
export function stripPrefix(pathname) {
  const p = String(pathname || '');
  if (p === ROUTE_PREFIX) return '/';
  if (p.startsWith(`${ROUTE_PREFIX}/`)) return p.slice(ROUTE_PREFIX.length);
  return p;
}

/** query 里的 facet：既收 `?auth=No&auth=OAuth`，也收 `?auth=No,OAuth`；空值一律当"不限"。 */
function facetParam(url, field) {
  const raw = url.searchParams.getAll(field).flatMap((v) => String(v).split(','));
  const list = raw.map((v) => v.trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : '';
}

function intParam(url, name, dflt, min, max) {
  // ★ 先判"有没有这个参数"：`Number(null)` 是 0 且是有限数，缺省时会被夹到下限而不是取默认值
  //   （hosts 的默认门槛 HOST_AGG_MIN 就是这么被顶成 1 的 —— 清单变成"全列"）。
  const raw = url.searchParams.get(name);
  if (raw === null || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * limit 类参数：**0、负数、'abc' 与没填一律当"没填"**，回落默认。
 * ★ 这里不能复用 intParam 的夹取：把 `limit=0` 夹成 1 条，界面显示的是"目录里只有这一条"，
 *   而用户看到的是空得莫名其妙 —— 与 query.js 里 searchRecords 的钳制同一个口径，两处不许各说一套。
 */
function limitParam(url, name, dflt, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(max, Math.trunc(n));
}

function boolParam(url, name) {
  const v = url.searchParams.get(name);
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * offset（翻页起点）：与 limit **故意用两套口径**。
 *   - limit：0/负数/'abc' 一律当"没填"回落默认 —— 把 limit=0 夹成 1 条，界面显示"只有这一条"，
 *     用户看到的是空得莫名其妙。
 *   - offset：脏值一律夹到 0，**不回落默认值**（它的默认值本来就是 0）。理由是分页游标不能猜：
 *     ?offset=abc 与 ?offset=0 落到同一个 0，界面上分不清"用户翻到第一页"与"翻页参数写坏了"，
 *     而后者在真机上表现为"点了继续加载，列表又从第一页重来"，极难自查。
 *   - 上界夹到 SEARCH_OFFSET_MAX：夹的不是错，是不让 1e15 这种值进 slice（结果恒为空且看不出原因）。
 */
function offsetParam(url, name = 'offset') {
  const raw = url.searchParams.get(name);
  if (raw === null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(SEARCH_OFFSET_MAX, Math.trunc(n));
}

function searchParamsOf(url) {
  return {
    query: url.searchParams.get('q') || '',
    category: url.searchParams.get('category') || '',
    host: url.searchParams.get('host') || '',
    facets: { auth: facetParam(url, 'auth'), https: facetParam(url, 'https'), cors: facetParam(url, 'cors') },
    limit: limitParam(url, 'limit', SEARCH_DEFAULT_LIMIT, SEARCH_LIMIT_MAX),
    offset: offsetParam(url),
    includeHidden: boolParam(url, 'includeHidden'),
  };
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */

/**
 * @param opts.onBroken 心跳写失败时回调（hub 借此摘牌）
 * @param opts.setIntervalMod / clearIntervalMod / heartbeatMs 测试注入，避免每条长连接真等 25 秒
 */
export function openSse(res, opts = {}) {
  const { onBroken, heartbeatMs = SSE_HEARTBEAT_MS } = opts;
  const setIntervalMod = opts.setIntervalMod ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalMod = opts.clearIntervalMod ?? ((h) => clearInterval(h));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  // 首帧注释：把响应头冲出去，浏览器才会立刻收到（否则要等缓冲满，界面看起来"卡在连接上"）。
  res.write(': ok\n\n');
  const beat = () => {
    if (closed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      closed = true;
      clearIntervalMod(hb);
      onBroken?.();
    }
  };
  const hb = setIntervalMod(beat, heartbeatMs);
  if (typeof hb?.unref === 'function') hb.unref();
  return {
    send(event, data) {
      if (closed) return false;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        closed = true;
        clearIntervalMod(hb);
        onBroken?.();
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearIntervalMod(hb);
      try {
        res.end();
      } catch { /* 已经断了 */ }
    },
  };
}

/** 长连接清单：第一发接上 / 最后一发断开各回调一次（装配层用它决定要不要留同步通知的订阅）。 */
export function createHub(onFirst, onLast) {
  const clients = new Set();
  return {
    get size() { return clients.size; },
    add(client) {
      const first = clients.size === 0;
      clients.add(client);
      if (first) onFirst?.();
    },
    remove(client) {
      if (!clients.delete(client)) return;
      client.close?.();
      if (clients.size === 0) onLast?.();
    },
    broadcast(event, data) {
      for (const c of [...clients]) {
        if (!c.send(event, data)) this.remove(c);
      }
    },
    dispose() {
      for (const c of [...clients]) this.remove(c);
    },
  };
}

/* ------------------------------------------------------------------ *
 * 写侧入参校验（界面 → 库的最后一道；库里那两道是 schema 与 clamp）
 * ------------------------------------------------------------------ */

function needSlug(body) {
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  if (!slug) throw new ApiError('INVALID_PARAM', '缺少 slug');
  if (slug.length > 300) throw new ApiError('INVALID_PARAM', `slug 过长（${slug.length} 字）`);
  return slug;
}

/**
 * 批注正文与标签。★ 超长**报错**而不是截断：笔记是用户写的，悄悄删半句最不能接受。
 * 标签做三件无害的事：去空白、去空、去重 —— 这三样用户想要的是什么没有歧义。
 */
function noteFieldsFrom(body) {
  const out = {};
  if (body.purpose !== undefined) {
    if (typeof body.purpose !== 'string') throw new ApiError('INVALID_PARAM', 'purpose 必须是字符串');
    if (body.purpose.length > NOTE_PURPOSE_MAX_LEN) {
      throw new ApiError('INVALID_PARAM', `批注最长 ${NOTE_PURPOSE_MAX_LEN} 字，现在 ${body.purpose.length} 字`);
    }
    out.purpose = body.purpose;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) throw new ApiError('INVALID_PARAM', 'tags 必须是数组');
    const tags = [...new Set(body.tags.map((t) => String(t ?? '').trim()).filter(Boolean))];
    if (tags.length > TAG_MAX_COUNT) throw new ApiError('INVALID_PARAM', `标签最多 ${TAG_MAX_COUNT} 个`);
    if (tags.some((t) => t.length > TAG_MAX_LEN)) throw new ApiError('INVALID_PARAM', `单个标签最长 ${TAG_MAX_LEN} 字`);
    out.tags = tags;
  }
  for (const flag of ['starred', 'hidden']) {
    if (body[flag] !== undefined) out[flag] = Boolean(body[flag]);
  }
  return out;
}

function prefsFrom(body) {
  const out = {};
  if (body.intervalMin !== undefined) {
    const n = Number(body.intervalMin);
    // 这里不 clampPrefs 那样"回落默认"：界面上点的是档位，档位外的值说明请求来路不对，
    // 悄悄改成一个能用的数等于把用户选的东西换成另一个。
    if (!CHECK_INTERVALS.includes(n)) {
      throw new ApiError('INVALID_PARAM', `检查间隔必须是档位之一：${CHECK_INTERVALS.join(' / ')} 分钟`);
    }
    out.intervalMin = n;
  }
  if (body.sourcePriority !== undefined) {
    if (!Array.isArray(body.sourcePriority)) throw new ApiError('INVALID_PARAM', 'sourcePriority 必须是数组');
    const known = SOURCES.map((s) => s.id);
    const bad = body.sourcePriority.filter((id) => !known.includes(String(id))).map(String);
    if (bad.length) throw new ApiError('INVALID_PARAM', `源优先级里有没登记过的 id：${bad.join(', ')}`);
    out.sourcePriority = [...new Set(body.sourcePriority.map(String))];
  }
  // ★ 下面四项是 prefs 里**唯一**与现译有关的键，而且没有一项是凭据：
  //   snapshotOf 把 prefs 整份推给浏览器（hc-14 钉着"载荷里没有凭据字段"），
  //   所以「AppID/密钥不进 prefs」这条不是流程约定，是这里不收它们。
  if (body.transEnabled !== undefined) {
    if (typeof body.transEnabled !== 'boolean') throw new ApiError('INVALID_PARAM', 'transEnabled 必须是布尔值');
    out.transEnabled = body.transEnabled;
  }
  if (body.transChannel !== undefined) {
    const c = String(body.transChannel ?? '');
    if (!TRANS_CHANNEL_IDS.includes(c)) {
      throw new ApiError('INVALID_PARAM', `现译渠道必须是登记的几档之一：${TRANS_CHANNEL_IDS.join(' / ')}`);
    }
    out.transChannel = c;
  }
  // 代理两档（S16）。★ 自定义地址这一格**不收 `user:pass@`**：它是整份推给浏览器的，
  //   代理密码只要进来就跟着首屏出去一趟 —— 那条「凭据不进 prefs」的律不能被一个新字段绕开。
  //   要带认证的代理请配环境变量或 Windows 系统代理：那两条读的是宿主进程侧，不进 prefs。
  if (body.proxyMode !== undefined) {
    const m = String(body.proxyMode ?? '');
    if (!PROXY_MODES.includes(m)) {
      throw new ApiError('INVALID_PARAM', `代理模式必须是三档之一：${PROXY_MODES.join(' / ')}`);
    }
    out.proxyMode = m;
  }
  if (body.proxyUrl !== undefined) {
    const u = String(body.proxyUrl ?? '').trim();
    if (u.length > PROXY_URL_MAX) throw new ApiError('INVALID_PARAM', `代理地址最长 ${PROXY_URL_MAX} 字，现在 ${u.length} 字`);
    if (u && parseProxyUrl(u).ok !== true) throw new ApiError('INVALID_PARAM', `代理地址不合法：${parseProxyUrl(u).reason}`);
    if (u.includes('@')) throw new ApiError('INVALID_PARAM', PROXY_URL_BOUNDARY);
    out.proxyUrl = u;
  }
  return out;
}

/**
 * 凭据写入/清除的目标：渠道与字段都必须是登记过的值。
 * ★ 为什么在这里验而不是让 stores 拒：stores 那条拒的是「键构造不出合法记录」，包成 RecordsError(INVALID)
 *   → 503「本地存储这一侧没走通」。但「你递了个没登记的字段」是**参数错**（400），不是存储坏了，
 *   界面会照着 503 的话去查磁盘，那就查不出来。两处判据同源（都读 TRANS_CRED_FIELDS），不手抄。
 */
function secretTargetFrom(body) {
  const channel = String(body?.channel ?? '').trim();
  if (!TRANS_CHANNEL_IDS.includes(channel)) {
    throw new ApiError('INVALID_PARAM', `没有这一档现译渠道：${channel || '(空)'}`);
  }
  const fields = TRANS_CRED_FIELDS[channel] || [];
  const field = String(body?.field ?? '').trim();
  const spec = fields.find((f) => f.id === field);
  if (!spec) {
    const allowed = fields.map((f) => f.id).join(' / ') || '（这一档不需要凭据）';
    throw new ApiError('INVALID_PARAM', `${channel} 没有「${field || '(空)'}」这个凭据字段，可填：${allowed}`);
  }
  return { channel, field, spec };
}

/* ------------------------------------------------------------------ *
 * 现译（S8/S9）：快照里那一块 + 三条写路由
 * ------------------------------------------------------------------ */

/**
 * 快照与设置页共用的那一块状态。**这里出现的每一样都不含凭据值**：
 * `status()` 只给形状与开关，`secrets.describe()` 只给 `{configured, chars, at}`（值不回显，见 lib/stores.js）。
 * 依赖缺失（装配层没给 translate 服务）时给 null，界面按"这一格没话"处理，不猜。
 */
async function translateBlock(d) {
  if (!d.translate) return null;
  const [secrets, counts] = await Promise.all([
    d.stores.secrets.describe().catch(() => ({})),
    d.stores.trans.counts().catch(() => ({ rows: 0, ok: 0, failed: 0 })),
  ]);
  const st = d.translate.status();
  return { ...st, secrets, counts, transport: transportView(st.transport) };
}

/**
 * 「这一发到底从哪条路出去了」那一块（S16）。整句在**宿主**拼好，客户端只搬字：
 * 它一重排或补个标点，两处口径就漂。route 来自 `lib/net.js` 的 `describe()`，代理地址已打码。
 * 没有传输层（装配层没接、或测试只挂了假服务）时给 null —— 界面那一句就整个不摆，不编一句「直连」。
 */
export function transportView(route) {
  if (!route) return null;
  const via = String(route.via ?? 'idle');
  const view = {
    via,
    viaLabel: TRANSPORT_VIA_LABELS[via] ?? String(via || '未知'),
    source: route.source ?? '',
    sourceLabel: transportSourceLabel(route.source),
    proxy: route.proxy ?? '',
    reason: route.reason ?? '',
    targetHost: route.targetHost ?? '',
    at: route.at ?? 0,
  };
  view.line = transportLine(view);
  return view;
}

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */

/** 首屏与 update 帧共用同一份装配函数：两条路的形状必须一模一样，客户端才不需要分支。 */
async function snapshotOf(deps, params = {}) {
  const snap = await deps.engine.snapshot(params);
  return {
    builtAt: Date.now(),
    capabilities: deps.caps.read(),
    // capabilityRows（能力位的展示行）2026-10-06 随「解析台账」那张卡一起从界面撤了：
    // 展示行只剩首屏 payload 那一份（index.js，hc 面读它），每轮推流不再摊这一坨没人读的数组。
    // strict：域不可用时这一发要如实 503。宽容读法会返回一份默认偏好，界面于是显示"存储在位"而它其实写不进去。
    prefs: await deps.stores.prefs.read({ strict: true }),
    lastSync: deps.lastSync ? deps.lastSync() ?? null : null,
    // 现译那一块（含译文计数与凭据摘要，**没有值**）。缺服务就是 null：客户端按"这一格没话"渲染。
    translate: await translateBlock(deps),
    ...snap,
  };
}

const ROUTES = {
  'GET /api/snapshot': { handler: async (d, req, res, body, url) => jsonOk(res, await snapshotOf(d, searchParamsOf(url))) },
  'GET /api/search': { handler: async (d, req, res, body, url) => jsonOk(res, await d.engine.search(searchParamsOf(url))) },
  'GET /api/hosts': {
    handler: async (d, req, res, body, url) => jsonOk(res, await d.engine.hosts({
      min: intParam(url, 'min', HOST_AGG_MIN, 1, 1000),
      top: intParam(url, 'top', 0, 0, 5000),
    })),
  },
  'GET /api/entry': {
    handler: async (d, req, res, body, url) => {
      const slug = url.searchParams.get('slug') || '';
      if (!slug) throw new ApiError('INVALID_PARAM', '缺少 slug');
      const entry = await d.engine.entry(slug);
      if (!entry) return json(res, 404, errBody('NOT_FOUND', `目录里没有这一条：${slug}（上游可能删了，去「我的笔记」看批注还在不在）`));
      return jsonOk(res, { entry });
    },
  },
  'GET /api/changes': {
    handler: async (d, req, res, body, url) => {
      const kind = url.searchParams.get('kind') || '';
      const rows = await d.stores.changes.list(limitParam(url, 'limit', 100, 500), kind);
      return jsonOk(res, { rows, meta: await d.stores.meta.read() });
    },
  },
  'GET /api/notes': {
    handler: async (d, req, res, body, url) => {
      const view = url.searchParams.get('view') || 'all';
      if (!['all', 'starred', 'tags', 'orphan'].includes(view)) throw new ApiError('INVALID_PARAM', `没有这种批注视图：${view}`);
      return jsonOk(res, { view, rows: await d.engine.notes({ view }) });
    },
  },
  'GET /api/prefs': { handler: async (d, req, res) => jsonOk(res, await d.stores.prefs.read({ strict: true })) },

  'POST /api/sync': {
    loopback: true,
    handler: async (d, req, res) => {
      const result = await d.trigger('manual');
      // 撞车那一发装配层给的是 {skipped:true}（它不许 throw，否则会从定时器回调逃逸）；
      // 界面要的是"这一发没跑"，所以按 SYNC_BUSY 报 409 —— 而不是 200 加一句"其实没同步"。
      if (result?.skipped) return json(res, SYNC_BUSY.http, errBody(SYNC_BUSY.code, SYNC_BUSY.message));
      return jsonOk(res, { result });
    },
  },
  'POST /api/prefs': {
    loopback: true,
    handler: async (d, req, res, body) => {
      const patch = prefsFrom(body ?? {});
      if (!Object.keys(patch).length) throw new ApiError('INVALID_PARAM', '没有要改的偏好项');
      const saved = await d.stores.prefs.patch(patch);
      d.onPrefsSaved?.(saved);   // 落库之后立刻重挂节拍，否则新档位要等下一轮才生效
      return jsonOk(res, saved);
    },
  },
  'POST /api/notes': {
    loopback: true,
    handler: async (d, req, res, body) => {
      const slug = needSlug(body);
      const fields = noteFieldsFrom(body ?? {});
      if (!Object.keys(fields).length) throw new ApiError('INVALID_PARAM', '没有要写的批注字段');
      const category = typeof body.category === 'string' ? body.category.trim() : '';
      if (!category) throw new ApiError('INVALID_PARAM', '缺少 category（搬家时靠它算新行，不许留空）');
      const now = d.now ? d.now() : Date.now();
      const cur = await d.stores.notes.read(slug);
      // 名称快照只从**在册条目**取，界面递来的 name 一个字都不吃（同 orphan 那句口径）。
      const live = await d.engine.entry(slug);
      const note = {
        slug,
        category,
        name: live?.name ?? cur?.name ?? '',
        purpose: fields.purpose ?? cur?.purpose ?? '',
        tags: fields.tags ?? (cur?.tags ? [...cur.tags] : []),
        starred: fields.starred ?? Boolean(cur?.starred),
        hidden: fields.hidden ?? Boolean(cur?.hidden),
        // orphan 由差分写，界面不碰：用户删掉半句话不该让一条笔记从"上游已删"变成"还在"。
        orphan: Boolean(cur?.orphan),
        updatedAt: now,
      };
      await d.stores.notes.write(note);
      return jsonOk(res, note);
    },
  },
  'POST /api/notes/delete': {
    loopback: true,
    handler: async (d, req, res, body) => {
      const slug = needSlug(body);
      const cur = await d.stores.notes.read(slug);
      if (!cur) return json(res, 404, errBody('NOT_FOUND', `这条没有批注可删：${slug}`));
      await d.stores.notes.remove(slug);
      return jsonOk(res, { removed: slug });
    },
  },

  /* ---- 现译（S8）。这四条是**唯一**能碰到 secrets 的路由，而且全是 POST + loopback ---- */

  'POST /api/translate/secret': {
    loopback: true,
    handler: async (d, req, res, body) => {
      const { channel, field, spec } = secretTargetFrom(body ?? {});
      // 先 trim 再验：AppID 与密钥是从控制台复制进来的，首尾那点空白带着它签名必然对不上，
      // 而"存进去存不进得去"看不出来 —— 所以存 trim 后的那份，界面显示的位数也是那一份（同一条口径两处不许多）。
      const value = String(body?.value ?? '').trim();
      const max = Math.min(Number(spec.max) || TRANS_CRED_MAX, TRANS_CRED_MAX);
      if (!value) throw new ApiError('INVALID_PARAM', `${spec.label} 是空的：要删掉请用「清除」，填一串空格也不算填过`);
      if (value.length > max) throw new ApiError('INVALID_PARAM', `${spec.label} 长 ${value.length} 字，上限 ${max} 字`);
      await d.stores.secrets.write({ channel, field, value, at: d.now() });
      // 回的是整块状态（含新的「已配置 · N 位」）：客户端只换这一格，不自己拼摘要。
      return jsonOk(res, await translateBlock(d));
    },
  },
  'POST /api/translate/secret/delete': {
    loopback: true,
    handler: async (d, req, res, body) => {
      const { channel, field } = secretTargetFrom(body ?? {});
      await d.stores.secrets.remove(channel, field);
      return jsonOk(res, await translateBlock(d));
    },
  },
  'POST /api/translate/test': {
    loopback: true,
    handler: async (d, req, res) => {
      // `test` 只在这一发里出现（固定原文、不落库，所以不进 lastPass）；其余形状与快照那一块一致。
      const result = await d.translate.testConnection();
      return jsonOk(res, { ...(await translateBlock(d)), result });
    },
  },
  'POST /api/translate/run': {
    loopback: true,
    handler: async (d, req, res) => {
      // ★ 这一发必须把 runPass 的返回原样带回去：`skipped:'busy'` 那一支**不写 lastPass**，
      //   只看块里的 lastPass 会把"没排队"显示成"上一轮的结果"，那是把两件事说成一件。
      const result = await d.translate.runPass({ reason: 'manual' });
      return jsonOk(res, { ...(await translateBlock(d)), result });
    },
  },

  'GET /api/stream': {
    handler: async (d, req, res) => {
      let client;
      const sse = openSse(res, { onBroken: () => d.hub.remove(client), ...(d.sseTimers ?? {}) });
      client = { send: sse.send, close: sse.close };
      d.hub.add(client);
      req.on?.('close', () => d.hub.remove(client));
      // 接上就先发整份快照：客户端不需要"先 GET 一次再订阅"，也就没有两发之间的空窗。
      // ★ 这一发的失败**不能**走到外层的 json(503)：openSse 已经 writeHead 把 200 头发冲出去了，
      //   再写一次头在真宿主的 res 上是 ERR_HTTP_HEADERS_SENT（异常还会从路由的 catch 里逃逸）。
      //   所以这里把原因塞进一帧 error 再关连接：界面上看到的是"为什么没推流"，客户端按断开重连。
      try {
        sse.send('snapshot', await snapshotOf(d));
      } catch (e) {
        const err = toApiError(e);
        sse.send('error', { code: err.code, message: err.message });
        sse.close();
        d.hub.remove(client);   // 立刻摘牌：留着它，下一轮同步会为一个已关的连接摊一份 2019 条的快照
      }
      return true;   // 不 end：这条连接要一直开着
    },
  },
};

const PATH_METHODS = new Map();
for (const key of Object.keys(ROUTES)) {
  const [method, path] = key.split(' ');
  if (!PATH_METHODS.has(path)) PATH_METHODS.set(path, []);
  PATH_METHODS.get(path).push(method);
}

/**
 * @param deps { engine, stores, caps, hub, trigger, lastSync, onPrefsSaved, translate, sseTimers, now, logger }
 *              `translate` 缺省时快照里的 `translate` 一格是 null，四条现译路由也就不可能被走通（路由照旧存在，回 500 前先看 null）。
 * @returns handler(req, res, bodyArg) —— 带 .dispose() 与 .hub，装配层与测试都从这两个口子拿。
 */
export function createApiHandler(deps = {}) {
  const hub = deps.hub ?? createHub();
  const d = { ...deps, hub, now: deps.now ?? (() => Date.now()) };

  async function handler(req, res, bodyArg) {
    const method = String(req?.method || 'GET').toUpperCase();
    const url = toUrl(req?.url);
    const path = stripPrefix(url.pathname);

    const entry = ROUTES[`${method} ${path}`];
    if (!entry) {
      if (PATH_METHODS.has(path)) {
        return json(res, 405, errBody('METHOD_NOT_ALLOWED', `${path} 只接受 ${PATH_METHODS.get(path).join(' / ')}`));
      }
      return json(res, 404, errBody('NOT_FOUND', `没有这个接口：${method} ${ROUTE_PREFIX}${path}`));
    }
    // 门在读 body 之前：非本机的写请求连请求流都不该消费（403 要比"读完了再拒"更早、也更便宜）。
    if (entry.loopback && !isLoopback(req)) {
      return json(res, 403, errBody('FORBIDDEN', '写操作只接受本机请求（这个服务按只写本机设计）'));
    }
    let body = bodyArg;
    if (body === undefined && method === 'POST') {
      try {
        body = await readBody(req);
      } catch (e) {
        const err = toApiError(e);
        return json(res, statusFor(err.code), errBody(err.code, err.message));
      }
    }
    try {
      return await entry.handler(d, req, res, body ?? {}, url);
    } catch (e) {
      const err = toApiError(e);
      const status = statusFor(err.code);
      d.logger?.warn?.(`[api-catalog] ${method} ${path} 失败（${err.code}）：${err.message}`);
      return json(res, status, errBody(err.code, err.message));
    }
  }

  handler.dispose = () => hub.dispose();
  handler.hub = hub;
  handler.routes = Object.keys(ROUTES);
  /** 跑完一轮后推一帧。★ 帧的形状就是 GET /api/snapshot 的形状（客户端不许补字段）。 */
  handler.pushUpdate = async () => {
    if (!hub.size) return null;
    const snap = await snapshotOf(d);
    hub.broadcast('update', snap);
    return snap;
  };
  return handler;
}

/** 路由表本身：判据「每条 POST 都声明了 loopback」要看表，光看 handler 的行为只能测到"当前这几条"。 */
export { ROUTES as API_ROUTES };
