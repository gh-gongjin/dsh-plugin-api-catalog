/**
 * lib/translate.js —— 中文说明的现译渠道层（S8）。**宿主半边唯一**允许碰 `ctx.llm` 的文件，
 * 也是唯一允许往非 GitHub 域名出网的文件。
 *
 * 五条口径，改这个文件时不许退回旧形状：
 *  1. **默认零调用**。`prefs.transEnabled` 出厂是 `false` ⇒ 一句都不发、一次 llm.stream 都不碰。
 *     这是 hc-9 从「零 ctx.llm」改判成「默认零调用 + 句柄只出现在本文件」之后的落地判据，
 *     由 test/translate.test.mjs 用 spy 句柄钉（关着的那一档真调一次都算挂）。
 *  2. **一次一句**。多句拼一发时回包怎么切回每句没有可靠判据，切错的后果是把 A 的描述挂到 B 上 ——
 *     那是"看起来更省"换来的一类新事故，所以宁可多发几发。
 *  3. **出网域名是封闭集合**。只允许 `TRANS_ENDPOINTS` 里那几台（白名单从 domain 派生，判据不手抄），
 *     而且闸门在 `httpCall` 内部第一行 —— 新增渠道不经过调用方那一路。
 *     目录抓取那一路的「全程只读 GET」红线**没有**因为翻译而放宽：本文件往 GitHub 去的仍然只有 GET。
 *     放宽的只是渠道侧：厂商官方接口自己要求 POST 的（腾讯 TMT、讯飞机器翻译（新））就按官方形状发 POST，
 *     正文只有这一句待译原文 + 应用 id + 签名，不含用户库里的任何别的数据，也不含密钥。
 *     ★ S16 起 `fetchImpl` 默认不再是全局 fetch，而是装配层给的 `lib/net.js` 传输层（同一条 GET 语义，
 *     只是多一条"这一发从哪条路出去"的仲裁）：免费接口那一档在这台机器上直连实测发不出去（§9.1r）。
 *     抓取那一路**没有**换传输层，它照旧直接用全局 fetch。
 *  4. **密钥只参与签名，绝不出现在 URL、日志与任何回包里**。界面上能看见的只有「已配置 · N 位」。
 *  5. **失败也登记**。`ok:false` 的行带着 `at` 与 `errText` 存进 trans 表，
 *     cooldown（TRANS_FAIL_COOLDOWN_MS）内同一句不再重试；不存失败行的话，每轮同步都会把同一句再打一遍。
 *
 * 与内置离线预译表（lib/desc-zh.js）的分工：命中判据两边都是「折叠空白后逐字相同」，
 * 内置表命中的句子**不进** trans 表（它随发版走，不需要本机重复存一份），
 * trans 表只收现译出来的那些。读侧由 lib/query.js 两层 join。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  TRANS_CHANNELS, TRANS_CHANNEL_IDS, TRANS_CHANNEL_LABELS, TRANS_ENDPOINTS, TRANS_HOSTS,
  TRANS_CRED_FIELDS, TRANS_TIMEOUT_MS, TRANS_IN_MAX, TRANS_OUT_MAX,
  TRANS_MAX_PER_ROUND, TRANS_FAIL_COOLDOWN_MS, TRANS_RATE_LIMIT_COOLDOWN_MS, TRANS_ERROR_LABELS, TRANS_HAN_RE,
  transZhLabel, DEFAULT_TRANS_CHANNEL, TENCENT_DEFAULT_REGION,
} from './domain.js';
import { descZhView } from './desc-zh.js';

/** 交给宿主模型的那一句指令：要的是"一句话对一句话"，不是解释、不是改写。 */
export const TRANS_LLM_SYSTEM =
  '你是术语一致的翻译者。把用户给出的一行英文 API 用途描述翻译成简洁的简体中文，'
  + '只输出译文本身：不要解释、不要加引号，产品名与公司名保留原文。';

/** 测试连接那一发的固定原文（不是用户库里的句子 ⇒ 不占用也不污染 trans 表）。 */
export const TRANS_PROBE_TEXT = 'Data about public libraries in the United Kingdom.';

/** 模型那一档的 maxTokens：一句描述实测 10~30 个汉字，128 已经给它留了整段回吐的空间。 */
export const TRANS_LLM_MAX_TOKENS = 128;

export function channelSpec(channel) {
  return TRANS_CHANNELS.find((c) => c.id === String(channel)) || null;
}

/** 这一档要填的凭据字段（id + label + 上限）。真源在 domain.js，界面与存储都读这一份。 */
export function credSpecs(channel) {
  return TRANS_CRED_FIELDS[String(channel)] || [];
}

function md5Hex(text) {
  return createHash('md5').update(String(text ?? ''), 'utf8').digest('hex');
}

function errNote(errKey) {
  return TRANS_ERROR_LABELS[errKey] || '';
}

/** 统一的失败形状。`zh` 一律空串 —— 让调用方无法"顺手"把半句当译文用。 */
function fail(errKey, errText = '') {
  return {
    ok: false, zh: '', cached: false, stored: false, channel: '',
    errKey, errText: String(errText).slice(0, 200), note: errNote(errKey),
  };
}

/**
 * 非 2xx 归哪一类（U-15）。★ 两处发送共用这一条判据：429 单独立键是为了让"这一档在限流"
 * 与"接口形状变了"在屏幕上分开，也为了让冷却按种类分档 —— 写两份迟早漂成两种口径。
 */
function failStatus(res) {
  const status = res?.status;
  return fail(status === 429 ? 'rate_limited' : 'http', `HTTP ${status ?? '?'}`);
}

/**
 * 某次失败之后要关多久（U-15）。只有 429 走短的那一档；种类缺失（换源之前留在库里的失败行）
 * 与别的错一样按整天关 —— 宁可少试一次，不要拿"库里有行读不出种类"当免冷却的口子。
 */
function cooldownFor(errKey) {
  return errKey === 'rate_limited' ? TRANS_RATE_LIMIT_COOLDOWN_MS : TRANS_FAIL_COOLDOWN_MS;
}

/** 原文归一（与 lib/desc-zh.js 的 descZhNorm、lib/keys.js 的 transKey 同一条口径）。 */
function normSrc(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * 渠道一：宿主模型（llm.stream）
 * ------------------------------------------------------------------ */

function frameKind(c) { return c?.type ?? c?.kind ?? 'unknown'; }
function frameText(c) { return String(c?.text ?? c?.delta?.text ?? ''); }

/**
 * 走宿主模型一发。★ 判成败看 **finish 帧**，不看有没有 throw：
 * 宿主把错误坐在 `{kind:'error', failure:{...}}` 那一帧里（2026-10-05 探针病历，spec §9.1j）。
 */
async function callLlm({ handle, modelPicker, src, timeoutMs, now, logger, stats }) {
  if (!modelPicker || typeof modelPicker.currentSelection !== 'function') {
    return fail('unavailable', '宿主没给出 agentDefaultModel 服务');
  }
  let picked = null;
  try { picked = modelPicker.currentSelection(); } catch (e) {
    logger?.warn?.(`[api-catalog] 读宿主默认模型失败：${e?.message ?? e}`);
    return fail('no_model', String(e?.message ?? e));
  }
  const provider = typeof picked?.provider === 'string' ? picked.provider : '';
  const model = typeof picked?.model === 'string' ? picked.model : '';
  if (!provider) return fail('no_model', '宿主没设默认模型');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const opts = {
    // ★ provider/model 必须我们自己填：宿主 llm.stream() 不解析默认档，provider 缺省的真机读数
    //   是 finish 帧里的 NO_ADAPTER；默认档的权威来源是宿主的 agentDefaultModel，本插件不另立一份。
    provider, model,
    system: TRANS_LLM_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: src.slice(0, TRANS_IN_MAX) }] }],
    temperature: 0,
    maxTokens: TRANS_LLM_MAX_TOKENS,
    signal: ac.signal,
    // ★ 实测关思考的唯一入口（reasoningChars 归零、单发 12 token / 0.9s）；顶层 thinking/reasoning 适配器不认。
    reasoningEffort: 'off',
  };
  // 自证：留的是**实际交给 stream() 的那一份**（探针 v2 的假读数就是从标签里造出来的）。
  stats.lastOpts = { ...opts, messages: JSON.parse(JSON.stringify(opts.messages)), signal: 'AbortSignal' };

  const t0 = now();
  let text = '';
  let reasoningChars = 0;
  let failure = null;
  let finish = null;
  const frames = {};
  let threw = null;
  try {
    for await (const c of handle.stream(opts)) {
      const k = frameKind(c);
      frames[k] = (frames[k] ?? 0) + 1;
      if (k === 'text-delta') text += frameText(c);
      else if (k === 'reasoning-delta') reasoningChars += frameText(c).length;
      else if (k === 'finish') {
        finish = c?.reason ?? c?.finishReason ?? c?.value?.reason ?? c ?? null;
        const f = c?.failure ?? c?.value?.failure ?? (k === 'error' ? c : null);
        if (f) failure = f;
      }
    }
  } catch (e) {
    threw = e;
  } finally {
    clearTimeout(timer);
    stats.lastMs = now() - t0;
    stats.lastFrames = frames;
    stats.lastReasoningChars = reasoningChars;
    stats.lastFinish = finish;
  }

  if (threw) {
    const timedOut = ac.signal?.aborted === true || threw?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'transport', String(threw?.message ?? threw));
  }
  if (failure || finish?.kind === 'error' || finish?.failure != null) {
    const f = failure ?? finish?.failure ?? {};
    return fail('http', `${f.code ?? ''} ${f.message ?? ''}`.trim());
  }
  const zh = text.trim();
  if (!zh) return fail('empty');
  if (zh.length > TRANS_OUT_MAX) return fail('too_long');
  if (!TRANS_HAN_RE.test(zh)) return fail('no_han');
  return { ok: true, zh };
}

/* ------------------------------------------------------------------ *
 * 渠道〇：免费接口（Google 的网页版翻译）—— 免注册免密钥，但**不是官方授权接口**
 * ------------------------------------------------------------------ */

/**
 * 组这一发的 URL。★ 参数形状照热榜插件那发实测（`client=gtx` 是网页版自己用的那个客户端标识），
 * 全部交给 `URLSearchParams` —— 原文里带 `&` 与 `#` 是常态，手拼必坏。
 * `sl=auto` 而不是本项目官方那几家写死的 `from=en`：网页版没有 from 这个参数名，而库里全是英文描述，
 * 自动判定在这一发上等价于 en（实测回包第三个字段就写着 `"en"`）。
 */
export function keylessUrl({ endpoint, text }) {
  const qs = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: text });
  return `${endpoint}?${qs.toString()}`;
}

/**
 * 回包 → 译文。形状是嵌套数组 `[[[zh, src, ...], [zh, src, ...]], ...]`（本机实测读数见 §9.1r）。
 * ★ 读不出这个形状必须点名 `bad_json`，不许归到 `empty`：这一档不是官方接口，
 *   "对方改了形状"和"这句没译出来"是两件事，混成一句就等于让用户替我们盯上游。
 */
export function parseKeylessResponse(payload) {
  const segs = Array.isArray(payload) ? payload[0] : null;
  if (!Array.isArray(segs)) return fail('bad_json', '回包不是那个嵌套数组（网页版接口自己改了形状）');
  const zh = segs.map((s) => (Array.isArray(s) ? String(s[0] ?? '') : '')).join('').trim();
  if (!zh) return fail('empty');
  if (zh.length > TRANS_OUT_MAX) return fail('too_long');
  if (!TRANS_HAN_RE.test(zh)) return fail('no_han');
  return { ok: true, zh };
}

/** 免费接口一发：GET、无凭据、无签名。★ 域名闸门仍然在 httpCall 内部第一行（新渠道不开后门）。 */
async function callKeyless({ src, fetchImpl, timeoutMs, stats }) {
  const text = normSrc(src).slice(0, TRANS_IN_MAX);
  const r = await httpCall({
    url: keylessUrl({ endpoint: TRANS_ENDPOINTS.keyless, text }),
    method: 'GET',
    headers: { accept: 'application/json' },
    fetchImpl, timeoutMs, stats, kind: 'keyless',
  });
  if (r && r.ok === false) return r;
  return parseKeylessResponse(r);
}

/* ------------------------------------------------------------------ *
 * 渠道二：百度翻译开放平台（官方接口里唯一吃 GET 的一档）
 * ------------------------------------------------------------------ */

/**
 * 签名 = MD5(AppID + 原文 + salt + 密钥)。★ 密钥只进这一条摘要，永不进 URL。
 * salt 用本次时刻：它与 sign 一起被服务端校验，本身没有别的语义。
 */
export function baiduSign({ appid, text, salt, key }) {
  return md5Hex(`${appid}${text}${salt}${key}`);
}

/** 查询串里出现的是 AppID / salt / sign，**没有密钥** —— 这条由 test/translate.test.mjs 拿真值钉。 */
export function baiduUrl({ endpoint, appid, text, salt, sign }) {
  const qs = new URLSearchParams({ q: text, appid, salt, from: 'en', to: 'zh', sign });
  return `${endpoint}?${qs.toString()}`;
}

/** 回包形状：`{trans_result:[{src,dst}]}`；出错时是 `{error_code, error_msg}`（HTTP 仍是 200）。 */
export function parseBaiduResponse(payload) {
  if (!payload || typeof payload !== 'object') return fail('bad_json');
  if (payload.error_code !== undefined && payload.error_code !== null) {
    return fail('http', `${payload.error_code} ${payload.error_msg ?? ''}`.trim());
  }
  const list = Array.isArray(payload.trans_result) ? payload.trans_result : null;
  if (!list) return fail('bad_json', '没有 trans_result 这个字段');
  const zh = list.map((r) => String(r?.dst ?? '')).join('').trim();
  if (!zh) return fail('empty');
  if (zh.length > TRANS_OUT_MAX) return fail('too_long');
  if (!TRANS_HAN_RE.test(zh)) return fail('no_han');
  return { ok: true, zh };
}

async function callBaidu({ creds, src, fetchImpl, timeoutMs, now, logger, stats }) {
  const appid = String(creds.appid ?? '');
  const key = String(creds.key ?? '');
  if (!appid || !key) return fail('no_credential');
  const text = normSrc(src).slice(0, TRANS_IN_MAX);
  const salt = String(now());
  const sign = baiduSign({ appid, text, salt, key });
  const url = baiduUrl({ endpoint: TRANS_ENDPOINTS.baidu, appid, text, salt, sign });
  stats.lastUrl = url;
  // ★ 出网前的最后一道闸：这一发的域名必须在登记表派生出来的白名单里。
  const host = new URL(url).hostname;
  if (!TRANS_HOSTS.includes(host)) return fail('error', `渠道域名不在白名单：${host}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  let res = null;
  let threw = null;
  const t0 = now();
  try {
    res = await fetchImpl(url, { method: 'GET', signal: ac.signal, headers: { accept: 'application/json' } });
  } catch (e) {
    threw = e;
  } finally {
    clearTimeout(timer);
    stats.lastMs = now() - t0;
  }
  if (threw) {
    const timedOut = ac.signal?.aborted === true || threw?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'transport', String(threw?.message ?? threw));
  }
  if (!res?.ok) return failStatus(res);
  let payload = null;
  try {
    payload = await res.json();
  } catch (e) {
    logger?.warn?.(`[api-catalog] 百度回包读不出 JSON：${e?.message ?? e}`);
    return fail('bad_json', String(e?.message ?? e));
  }
  return parseBaiduResponse(payload);
}

/* ------------------------------------------------------------------ *
 * 渠道三：腾讯云 API 3.0 签名 v3（TC3-HMAC-SHA256）
 * ------------------------------------------------------------------ */

function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(String(data ?? ''), 'utf8').digest();
}

/** UTC 日期（yyyy-mm-dd）。★ 必须从**秒级时间戳**推，不能用本地日历：文档明写东八区凌晨会全线失败。 */
function utcDateFromTs(tsSeconds) {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * TC3 整条链，一次算完并把每一层都返回（返回层是为了让官方算例能逐层对，不是给界面用的）。
 * 规范请求串的换行结构照文档：空查询串那一行**保留**（`POST\n/\n\n<headers>\n<signedHeaders>\n<payloadHash>`），
 * CanonicalHeaders 自带结尾换行，所以它和 SignedHeaders 之间也是空行。少一行就是签名失败。
 */
export function tencentTc3Sign({
  secretId, secretKey, timestampSeconds, service, host, action, contentType, payload, method = 'POST', queryString = '',
}) {
  const date = utcDateFromTs(timestampSeconds);
  const headers = [
    `content-type:${String(contentType).toLowerCase()}`,
    `host:${host}`,
    `x-tc-action:${String(action).toLowerCase()}`,
  ].sort();
  const canonicalHeaders = `${headers.join('\n')}\n`;
  const signedHeaders = headers.map((h) => h.slice(0, h.indexOf(':'))).join(';');
  const canonicalRequest = [
    method, '/', queryString, canonicalHeaders, signedHeaders, sha256Hex(payload),
  ].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = ['TC3-HMAC-SHA256', String(timestampSeconds), credentialScope, hashedCanonicalRequest].join('\n');
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    date, canonicalRequest, canonicalHeaders, signedHeaders, credentialScope,
    hashedPayload: sha256Hex(payload), hashedCanonicalRequest, stringToSign,
    secretDate: secretDate.toString('hex'), secretService: secretService.toString('hex'),
    secretSigning: secretSigning.toString('hex'), signature, authorization,
  };
}

/** 腾讯 TMT 的 body：字段名照官方「文本翻译」接口描述（Source/Target 而不是 SourceLanguage/TargetLanguage）。 */
export function tencentPayload(text) {
  return JSON.stringify({
    SourceText: text, Source: 'en', Target: 'zh', ProjectId: 0,
  });
}

/** 回包 `{Response:{TargetText,...}}`；失败是 `{Response:{Error:{Code,Message}}}`（HTTP 仍可能是 200）。 */
export function parseTencentResponse(payload) {
  const r = payload && payload.Response;
  if (!r || typeof r !== 'object') return fail('bad_json', '没有 Response 这个字段');
  if (r.Error && (r.Error.Code || r.Error.Message)) {
    return fail('http', `${r.Error.Code ?? ''} ${r.Error.Message ?? ''}`.trim());
  }
  return readPlainZh(r.TargetText);
}

/* ------------------------------------------------------------------ *
 * 渠道四：阿里云 RPC 签名（HMAC-SHA1 + Base64，GET）
 * ------------------------------------------------------------------ */

/**
 * RFC3986 百分号编码。★ 不能直接交给 encodeURIComponent：它**不编** `!'()*`，
 * 而阿里的口径是这几个也要编（`~` 反过来必须不编），差一个字符服务端就报签名不匹配。
 */
export function aliyunPercentEncode(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28')
    .replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

/** 规范化请求串：键 ASCII 升序、键值都过百分号编码、以 & 连（文档步骤一）。 */
export function aliyunCanonicalQuery(params) {
  return Object.keys(params)
    .filter((k) => k !== 'Signature')
    .sort()
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`)
    .join('&');
}

/** StringToSign = METHOD&%2F&encode(规范化串)，密钥是 `AccessKeySecret + '&'`（文档步骤二、三）。 */
export function aliyunSign({ params, accessKeySecret, method = 'GET' }) {
  const canonical = aliyunCanonicalQuery(params);
  const stringToSign = `${method}&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonical)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64');
  return { canonicalQuery: canonical, stringToSign, signature };
}

/** 公共参数 + 通用翻译的业务参数拼成一条 GET URL（签名最后附上，同样要百分号编码）。 */
export function aliyunUrl({ endpoint, text, accessKeyId, accessKeySecret, nonce, timestamp }) {
  const params = {
    Action: 'TranslateGeneral',
    Version: '2018-10-12',
    Format: 'JSON',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    Timestamp: timestamp,
    RegionId: 'cn-hangzhou',
    SourceLanguage: 'en',
    TargetLanguage: 'zh',
    SourceText: text,
    Scene: 'general',
    FormatType: 'text',
  };
  const { canonicalQuery, stringToSign, signature } = aliyunSign({ params, accessKeySecret });
  return {
    url: `${endpoint}?${canonicalQuery}&Signature=${aliyunPercentEncode(signature)}`,
    canonicalQuery, stringToSign, signature,
  };
}

/** 阿里的回包用 Code 说话：成功是 `'200'`（字符串），失败时带 Message。 */
export function parseAliyunResponse(payload) {
  if (!payload || typeof payload !== 'object') return fail('bad_json');
  const code = payload.Code === undefined ? '' : String(payload.Code);
  if (code && code !== '200') return fail('http', `${code} ${payload.Message ?? ''}`.trim());
  return readPlainZh(payload.Data && payload.Data.Translated);
}

/* ------------------------------------------------------------------ *
 * 渠道五：讯飞开放平台 机器翻译（新）
 * ------------------------------------------------------------------ */

/**
 * 鉴权串。★ 影响结果的四件是 url、apiSecret、apiKey、date（文档原话），
 * request-line 用的是 `POST /v1/its HTTP/1.1` —— 方法与路径都从登记端点推，不写死第二份。
 * authorization_origin 里逗号后**带一个空格**：这是文档自己那发算例 base64 解出来的形状。
 */
export function xunfeiAuth({ apiKey, apiSecret, endpoint, date }) {
  const u = new URL(endpoint);
  const host = u.hostname;
  const requestLine = `POST ${u.pathname} HTTP/1.1`;
  const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signature = createHmac('sha256', apiSecret).update(signatureOrigin, 'utf8').digest('base64');
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, 'utf8').toString('base64');
  const qs = new URLSearchParams({ authorization, host, date });
  return {
    url: `${endpoint}?${qs.toString()}`, signatureOrigin, signature, authorizationOrigin, authorization,
  };
}

/** 讯飞的正文：文本要 base64，header.status 与 payload.input_data.status 固定 3（一次传完）。 */
export function xunfeiBody({ appId, text }) {
  return JSON.stringify({
    header: { app_id: appId, status: 3 },
    parameter: { its: { from: 'en', to: 'cn', result: {} } },
    payload: {
      input_data: {
        encoding: 'utf8',
        status: 3,
        text: Buffer.from(text, 'utf8').toString('base64'),
      },
    },
  });
}

/** 回包里的译文在 `payload.result.text`，**再套一层 base64**，解开才是 `{trans_result:{dst}}`。 */
export function parseXunfeiResponse(payload) {
  const header = payload && payload.header;
  if (!header || typeof header !== 'object') return fail('bad_json', '没有 header 这个字段');
  if (Number(header.code) !== 0) return fail('http', `${header.code} ${header.message ?? ''}`.trim());
  const packed = payload?.payload?.result?.text;
  if (typeof packed !== 'string' || !packed) return fail('empty');
  let inner = null;
  try {
    inner = JSON.parse(Buffer.from(packed, 'base64').toString('utf8'));
  } catch (e) {
    return fail('bad_json', `result.text 解 base64 后不是 JSON：${e?.message ?? e}`);
  }
  return readPlainZh(inner?.trans_result?.dst);
}

/** 三家「明文一句」回包的共同收尾：非空、不超长、必须有汉字（与百度那支同一条判据）。 */
function readPlainZh(value) {
  const zh = String(value ?? '').trim();
  if (!zh) return fail('empty');
  if (zh.length > TRANS_OUT_MAX) return fail('too_long');
  if (!TRANS_HAN_RE.test(zh)) return fail('no_han');
  return { ok: true, zh };
}

/**
 * 发一发 HTTP（三家共用）。★ 域名闸门在**函数内部第一行**，不在调用方：
 * 新渠道忘了带闸门就等于给白名单开了个后门，所以这里宁可重复一次检查。
 * 返回的 errText 一律不带 URL 查询串（讯飞的 authorization、阿里的 Signature 都在串里）。
 */
async function httpCall({
  url, method, headers, body, fetchImpl, timeoutMs, stats, kind,
}) {
  const host = new URL(url).hostname;
  if (!TRANS_HOSTS.includes(host)) return fail('error', `渠道域名不在白名单：${host}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  stats.lastUrl = url;
  stats.lastMethod = method;
  stats.lastKind = kind;
  let res = null;
  let threw = null;
  const t0 = Date.now();
  try {
    res = await fetchImpl(url, { method, headers, body, signal: ac.signal });
  } catch (e) {
    threw = e;
  } finally {
    clearTimeout(timer);
    stats.lastMs = Date.now() - t0;
  }
  if (threw) {
    const timedOut = ac.signal?.aborted === true || threw?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'transport', String(threw?.message ?? threw).slice(0, 120));
  }
  if (!res?.ok) return failStatus(res);
  let payload = null;
  try {
    payload = await res.json();
  } catch (e) {
    return fail('bad_json', String(e?.message ?? e).slice(0, 120));
  }
  return payload;
}

/** 腾讯 TMT 一发。region 是登记字段里的 optional 那一栏：留空就回落 domain 里的默认地域（真源只有一处，界面与这里都不另猜）。 */
async function callTencent({ creds, src, fetchImpl, timeoutMs, now, stats }) {
  const secretId = String(creds.secret_id ?? '');
  const secretKey = String(creds.secret_key ?? '');
  if (!secretId || !secretKey) return fail('no_credential');
  const region = String(creds.region ?? '').trim() || TENCENT_DEFAULT_REGION;
  const text = normSrc(src).slice(0, TRANS_IN_MAX);
  const endpoint = TRANS_ENDPOINTS.tencent;
  const host = new URL(endpoint).hostname;
  const contentType = 'application/json';
  const ts = Math.floor(now() / 1000);
  // ★ 签名与发送吃的是**同一个 payload 字符串**：两次 JSON.stringify 之间哪怕差一个空格都会判签名不一致。
  const body = tencentPayload(text);
  const signed = tencentTc3Sign({
    secretId, secretKey, timestampSeconds: ts, service: 'tmt',
    host, action: 'TextTranslate', contentType, payload: body,
  });
  // 自证：留签名值与参与签名的那几件，**不留密钥**（密钥只在派生链里活了一瞬）。
  stats.lastSigned = { algorithm: 'TC3-HMAC-SHA256', scope: signed.credentialScope, signedHeaders: signed.signedHeaders, signature: signed.signature, timestamp: String(ts), region };
  const r = await httpCall({
    url: endpoint,
    method: 'POST',
    headers: {
      'content-type': contentType,
      Host: host,
      'X-TC-Action': 'TextTranslate',
      'X-TC-Version': '2018-03-21',
      'X-TC-Timestamp': String(ts),
      'X-TC-Region': region,
      Authorization: signed.authorization,
    },
    body,
    fetchImpl, timeoutMs, stats, kind: 'tencent',
  });
  if (r && r.ok === false) return r;
  return parseTencentResponse(r);
}

/** 阿里通用翻译一发（GET：签名在查询串末尾，AccessKeySecret 只进 HMAC）。 */
async function callAliyun({ creds, src, fetchImpl, timeoutMs, now, nonce, stats }) {
  const accessKeyId = String(creds.access_key_id ?? '');
  const accessKeySecret = String(creds.access_key_secret ?? '');
  if (!accessKeyId || !accessKeySecret) return fail('no_credential');
  const text = normSrc(src).slice(0, TRANS_IN_MAX);
  const built = aliyunUrl({
    endpoint: TRANS_ENDPOINTS.aliyun,
    text, accessKeyId, accessKeySecret,
    nonce: nonce(),
    timestamp: new Date(now()).toISOString().slice(0, 19) + 'Z',
  });
  stats.lastSigned = { algorithm: 'HMAC-SHA1', stringToSign: built.stringToSign };
  const r = await httpCall({
    url: built.url, method: 'GET', headers: { accept: 'application/json' },
    fetchImpl, timeoutMs, stats, kind: 'aliyun',
  });
  if (r && r.ok === false) return r;
  return parseAliyunResponse(r);
}

/** 讯飞机器翻译（新）一发。app_id 在正文里，api_key/api_secret 只在鉴权串里。 */
async function callXunfei({ creds, src, fetchImpl, timeoutMs, now, stats }) {
  const appId = String(creds.appid ?? '');
  const apiKey = String(creds.api_key ?? '');
  const apiSecret = String(creds.api_secret ?? '');
  if (!appId || !apiKey || !apiSecret) return fail('no_credential');
  const text = normSrc(src).slice(0, TRANS_IN_MAX);
  const auth = xunfeiAuth({
    apiKey, apiSecret, endpoint: TRANS_ENDPOINTS.xunfei,
    date: new Date(now()).toUTCString(),
  });
  stats.lastSigned = { algorithm: 'HMAC-SHA256', date: new URL(auth.url).searchParams.get('date'), signature: auth.signature };
  const r = await httpCall({
    url: auth.url,
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: xunfeiBody({ appId, text }),
    fetchImpl, timeoutMs, stats, kind: 'xunfei',
  });
  if (r && r.ok === false) return r;
  return parseXunfeiResponse(r);
}

/* ------------------------------------------------------------------ *
 * 服务本体
 * ------------------------------------------------------------------ */

/**
 * @param ctx        宿主 Context（只在这里 `inject(['llm','agentDefaultModel'])`，句柄不外发）
 * @param stores     七表仓储（这里用 entries / trans / secrets 三张 + 外部给的偏好视图）
 * @param getPrefs   现取现算的偏好视图（装配层给同步视图，测试注入函数）
 * @param getTransport `lib/net.js` 那份传输层的最近路由（`describe()`），只给状态行念，不参与判定
 * @param onWritten  译文落库后的回调（装配层用它让读侧缓存作废并重推一帧）
 */
export function createTranslateService({
  ctx, stores, getPrefs, logger, onWritten, getTransport = null,
  now = () => Date.now(),
  // ★ 默认走装配层注入的 net（代理仲裁在那一层）；测试注入假 fetch，两条路都不碰真网络。
  fetchImpl = globalThis.fetch,
  timeoutMs = TRANS_TIMEOUT_MS,
  // 阿里那一发的 SignatureNonce 是随机串：测试要能钉住它才谈得上核对 URL，所以做成注入项。
  nonce = () => randomUUID(),
} = {}) {
  let llmHandle = null;
  let modelPicker = null;
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['llm', 'agentDefaultModel'], (s) => {
      llmHandle = s && typeof s.llm?.stream === 'function' ? s.llm : null;
      modelPicker = s && typeof s.agentDefaultModel?.currentSelection === 'function' ? s.agentDefaultModel : null;
      if (!llmHandle) logger?.warn?.('[api-catalog] 宿主注入了 llm 但没有 stream，现译按"渠道不可用"处理');
    });
  }

  const stats = {
    calls: 0, cached: 0, ok: 0, failed: 0,
    lastErrKey: '', lastChannel: '', lastOpts: null, lastUrl: '',
    lastFinish: null, lastReasoningChars: 0, lastMs: 0, lastFrames: {},
    lastSigned: null, lastMethod: '', lastKind: '',
  };
  let passing = null;
  let lastPass = null;

  const prefsOf = () => {
    try { return getPrefs?.() || {}; } catch { return {}; }
  };

  function channel() {
    const c = prefsOf().transChannel;
    return TRANS_CHANNEL_IDS.includes(c) ? c : DEFAULT_TRANS_CHANNEL;
  }

  /** 快照与设置页要的那一份状态（**没有任何值**，只有形状与计数）。 */
  function status() {
    const id = channel();
    const spec = channelSpec(id) || channelSpec(DEFAULT_TRANS_CHANNEL);
    return {
      enabled: prefsOf().transEnabled === true,
      channel: spec.id,
      label: TRANS_CHANNEL_LABELS[spec.id] ?? spec.id,
      needsKey: spec.needsKey === true,
      implemented: spec.implemented === true,
      quota: spec.quota,
      note: spec.note,
      llmReady: spec.id === 'host_llm' ? Boolean(llmHandle) : null,
      // 最近一发实际从哪条路出去（没出过网时 via=idle）。免密钥的 HTTP 档靠这一格回答"到底通不通"，
      // 而不是靠"凭据已填齐"那句 —— 那一档压根没有凭据可填。
      transport: typeof getTransport === 'function' ? getTransport() : null,
      busy: Boolean(passing),
      lastPass,
    };
  }

  /**
   * 这一档现在能不能发。返回 `{can, errKey}` —— 与 `send` 里那条同式：
   * 界面的「测试连接」不许自己另猜一套（同「预设计数与点进 chips 必然同数」那条律）。
   * ★ 闸门按 `needsKey` 分，不按渠道 id 列清单：`stores.secrets.hasAll` 对**没有凭据字段**的档返回 false
   *   （一格都不缺 ≠ 全填齐了），所以免密钥的 HTTP 档必须走另一支 —— 新增一档不会漏接，手抄 id 清单会。
   */
  async function readiness() {
    const id = channel();
    const spec = channelSpec(id);
    if (!spec) return { can: false, errKey: 'no_channel' };
    if (spec.implemented !== true) return { can: false, errKey: 'not_implemented' };
    if (id === 'host_llm') {
      return llmHandle ? { can: true, errKey: '' } : { can: false, errKey: 'unavailable' };
    }
    if (spec.needsKey !== true) return { can: true, errKey: '' };
    const ok = await stores.secrets.hasAll(id).catch(() => false);
    return { can: Boolean(ok), errKey: ok ? '' : 'no_credential' };
  }

  /** 这一档走哪条发送路。真源只有这一处：界面与测试都从这里问，不再各自 if 一遍渠道名。 */
  function sender(id) {
    if (id === 'keyless') return callKeyless;
    if (id === 'baidu') return callBaidu;
    if (id === 'tencent') return callTencent;
    if (id === 'aliyun') return callAliyun;
    if (id === 'xunfei') return callXunfei;
    return null;
  }

  /** 真发一发（不看开关、不查表 —— 那两道门在 translateOne 里）。 */
  async function send(src) {
    const id = channel();
    const spec = channelSpec(id);
    if (!spec) return { ...fail('no_channel'), channel: id };
    if (spec.implemented !== true) return { ...fail('not_implemented'), channel: id };
    stats.calls += 1;
    stats.lastChannel = id;
    if (id === 'host_llm') {
      const r = await callLlm({ handle: llmHandle, modelPicker, src, timeoutMs, now, logger, stats });
      return { ...r, channel: id };
    }
    const call = sender(id);
    if (!call) return { ...fail('not_implemented', `渠道 ${id} 登记了但没有发送路`), channel: id };
    const creds = {};
    for (const f of credSpecs(id)) {
      const row = await stores.secrets.read(id, f.id).catch(() => null);
      creds[f.id] = row?.value ?? '';
    }
    const r = await call({ creds, src, fetchImpl, timeoutMs, now, logger, stats, nonce });
    return { ...r, channel: id };
  }

  /**
   * 一句原文走完闸门：开关 → 内置表 → 现译表 → 渠道 readiness → 真发 → 落库。
   * `from` 说明这句中文从哪儿来（界面落款用）：`builtin` / `trans`；失败时为当前渠道。
   */
  async function translateOne(src, { force = false } = {}) {
    const text = normSrc(src);
    if (!text) return fail('');
    if (prefsOf().transEnabled !== true) return fail('off');

    const builtin = descZhView(text);
    if (builtin.translated) {
      return {
        ok: true, zh: builtin.zh, cached: true, stored: true, from: 'builtin',
        channel: '', errKey: '', errText: '', note: '',
      };
    }

    const row = await stores.trans.read(text).catch(() => null);
    if (!force && row && row.ok === true && typeof row.zh === 'string' && TRANS_HAN_RE.test(row.zh)) {
      stats.cached += 1;
      return {
        ok: true, zh: row.zh, cached: true, stored: true, from: 'trans',
        channel: row.channel, errKey: '', errText: '', note: transZhLabel(row.channel, row.at),
      };
    }

    const ready = await readiness();
    if (!ready.can) return { ...fail(ready.errKey), channel: channel() };

    const r = await send(text);
    if (!r.ok) {
      stats.failed += 1;
      // 失败也登记（口径 5）。存不下不改变这一发的结论，所以 .catch 掉。
      await stores.trans.put({
        src: text, zh: undefined, at: now(), chars: 0, channel: r.channel, ok: false,
        errText: r.errText || r.errKey, errKey: r.errKey || undefined,
      }).catch((e) => logger?.warn?.(`[api-catalog] 现译失败行没存下来：${e?.message ?? e}`));
      return { ...r, stored: false, from: 'trans' };
    }
    stats.ok += 1;
    const at = now();
    let stored = true;
    await stores.trans.put({
      src: text, zh: r.zh, at, chars: r.zh.length, channel: r.channel, ok: true, errText: undefined,
    }).catch((e) => { stored = false; logger?.warn?.(`[api-catalog] 译文写库失败（${e?.message ?? e}），这次用完就丢`); });
    if (stored) onWritten?.();
    return {
      ok: true, zh: r.zh, cached: false, stored, from: 'trans', channel: r.channel,
      errKey: stored ? '' : 'store', errText: '', note: stored ? transZhLabel(r.channel, at) : errNote('store'),
    };
  }

  /**
   * 待译清单：内置表没命中、现译表也没有可用行、**而且原文自己就没有汉字**的那些（去重）。
   * ★ 第三条是 2026-10-07 换 CN 源后补的闸门：源文档自己写中文的行（实测 1494 行里 1443 行）不是"还没中文"，
   *   把它们排进队列等于每轮白烧 40 发把中文再译一遍，而界面那句"还剩几句没中文"也跟着虚报。
   * ★ 失败行的 cooldown 单独返回 `inCooldown` 而不是直接从 texts 里抹掉：
   *   界面要回答"还剩几句没中文"，藏掉 cooldown 的那些就是少报，而它们确实还没有中文。
   */
  async function missingSources(items = [], { at = now() } = {}) {
    const rows = await stores.trans.readAll().catch(() => []);
    const done = new Set();
    // 一条原文 → 「最近那次失败」的 {at, ms}。★ ms 按失败的种类取（U-15）：
    // 限流那档只关 TRANS_RATE_LIMIT_COOLDOWN_MS，别的错照旧关一整天 —— 同一句后来失败得更晚时，以晚的那次为准。
    const failed = new Map();
    for (const r of rows) {
      if (!r || typeof r.src !== 'string') continue;
      if (r.ok === true && typeof r.zh === 'string' && TRANS_HAN_RE.test(r.zh)) done.add(r.src);
      else {
        const at = Number(r.at) || 0;
        const cur = failed.get(r.src);
        if (!cur || at > cur.at) failed.set(r.src, { at, ms: cooldownFor(r.errKey) });
      }
    }
    const seen = new Set();
    const texts = [];
    for (const item of items) {
      const text = normSrc(item?.desc);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      if (TRANS_HAN_RE.test(text)) continue;
      if (descZhView(text).translated) continue;
      if (done.has(text)) continue;
      texts.push(text);
    }
    const inCooldown = texts.filter((t) => {
      const f = failed.get(t);
      return f && at - f.at < f.ms;
    });
    return { texts, inCooldown };
  }

  /**
   * 一轮现译（增量挂点与设置页「立即补齐」共用这一条路）。
   * ★ 不许并发第二轮：撞车时返回 `{skipped:'busy'}` 且一个请求都不发（同同步那侧的单飞口径）。
   *   开关没开 / 渠道没备好同样**在这一层就收口**，那两支连 entries 都不读。
   */
  async function runPass({ reason = 'timer', max = TRANS_MAX_PER_ROUND } = {}) {
    if (passing) return { skipped: 'busy', startedAt: passing.startedAt };
    const summary = {
      reason, at: now(), skipped: '', scanned: 0, requested: 0,
      ok: 0, failed: 0, remaining: 0, inCooldown: 0, capped: false,
    };
    if (prefsOf().transEnabled !== true) {
      summary.skipped = 'off';
      lastPass = summary;
      return summary;
    }
    const ready = await readiness();
    if (!ready.can) {
      summary.skipped = ready.errKey;
      lastPass = summary;
      return summary;
    }
    const items = await stores.entries.readAllItems().catch(() => []);
    const { texts, inCooldown } = await missingSources(items);
    const runnable = texts.filter((t) => !inCooldown.includes(t));
    summary.scanned = texts.length;
    summary.inCooldown = inCooldown.length;
    passing = { startedAt: now() };
    let wrote = 0;
    try {
      for (const text of runnable) {
        if (summary.requested >= max) { summary.capped = true; break; }
        summary.requested += 1;
        const r = await translateOne(text);
        if (r.ok) { summary.ok += 1; wrote += 1; } else summary.failed += 1;
      }
    } finally {
      passing = null;
      summary.remaining = Math.max(0, runnable.length - summary.requested);
      summary.at = now();
      lastPass = summary;
      if (wrote > 0) onWritten?.();
    }
    return summary;
  }

  /** 测试连接：一发固定原文，**不查内置表也不落库**（要验的就是"这一档现在能不能用"）。 */
  async function testConnection() {
    const id = channel();
    const ready = await readiness();
    if (!ready.can) return { ok: false, channel: id, errKey: ready.errKey, note: errNote(ready.errKey), zh: '' };
    const r = await send(TRANS_PROBE_TEXT);
    if (!r.ok) return { ok: false, channel: id, errKey: r.errKey, note: r.note, zh: '' };
    return { ok: true, channel: id, errKey: '', note: `这一档可用（译文：${r.zh}）`, zh: r.zh };
  }

  return {
    status,
    readiness,
    translateOne,
    runPass,
    missingSources,
    testConnection,
    /** 界面与测试都从这里取读数，别在界面里再造一份判定。 */
    peek: (k) => (k ? stats[k] : { ...stats, lastPass }),
    get busy() { return Boolean(passing); },
    dispose: () => { llmHandle = null; modelPicker = null; passing = null; },
  };
}
