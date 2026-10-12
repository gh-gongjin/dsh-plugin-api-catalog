/**
 * lib/fetch.js —— 抓一份 README 正文：按源优先级降级、超时、字节上限、两种解码。
 *
 * 三条口径：
 *  1. **全程只读 GET**（红线）。这里没有任何写上游的调用，也不带凭证 —— 登记表上每一档都是公开文件。
 *  2. 一个源失败就换下一个，但**失败原因逐源留着**（failures）。界面要回答「为什么今天没更新」，
 *     只回一句"失败了"就是冒充。
 *  3. 拿不到就说拿不到：非 2xx / 超时 / 超字节 / 解码不出，全部分类记进 FETCH_FAIL，
 *     不许拿上一轮的正文当本轮的（那是把快照说成实时）。
 *
 * 「有没有变」不在这里判 —— 本模块只交正文与 sha256，门在 lib/sync.js（2026-10-05 实测英文那三档都不吃 If-None-Match，
 * CN 那两档没单独测过条件请求，所以整条链一律按"拿到正文再比 sha"走，弱验证器帮不上忙，见 spec §2）。
 */
import { createHash } from 'node:crypto';
import {
  SOURCES, DEFAULT_PREFS, FETCH_TIMEOUT_MS, MAX_BODY_BYTES, FETCH_FAIL,
} from './domain.js';

/** fetch 层的失败，带 FETCH_FAIL 里的码。调用方按 code 说话，不去 parse message。 */
export class FetchFail extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FetchFail';
    this.code = code;
  }
}

/** 正文指纹：sha256 全值（不是前缀）。这就是"有没有变"的唯一判据。 */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function sourceById(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

/** prefs 里的源优先级 → 实际要试的源（未登记的 id 在这一步自然消失，不另开错误分支）。 */
export function orderedSources(priorityIds) {
  const list = Array.isArray(priorityIds) && priorityIds.length ? priorityIds : DEFAULT_PREFS.sourcePriority;
  return list.map((id) => sourceById(id)).filter(Boolean);
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * 读正文并卡在 MAX_BODY_BYTES 以内。
 * ★ 必须边读边算：先 text() 再判长度等于让源把任意大的东西灌进宿主进程 —— 上限那条注释
 *   （「超 4 MB 一定不是这份文件」）说的是判据，不是内存预算。
 * 有 content-length 就先拒（一次字节都不读）；没有就按块累计，超了立刻 cancel。
 */
async function readCappedText(res, cap) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    throw new FetchFail(FETCH_FAIL.TOO_LARGE, `源声明 ${declared} B，超过上限 ${cap} B`);
  }
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    const bytes = byteLength(text);
    if (bytes > cap) throw new FetchFail(FETCH_FAIL.TOO_LARGE, `正文 ${bytes} B，超过上限 ${cap} B`);
    return { text, bytes };
  }
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > cap) {
      await Promise.resolve().then(() => reader.cancel()).catch(() => {});
      throw new FetchFail(FETCH_FAIL.TOO_LARGE, `读到 ${total} B，超过上限 ${cap} B（已中断连接）`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytes: total };
}

/** base64 源（GitHub Contents API）：{content: "…\\n…"} → UTF-8 正文。 */
async function decodeBase64(res, cap) {
  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    throw new FetchFail(FETCH_FAIL.DECODE, `Contents API 没给出 JSON：${e?.message ?? e}`);
  }
  const b64 = typeof payload?.content === 'string' ? payload.content.replace(/\s+/g, '') : '';
  if (!b64) throw new FetchFail(FETCH_FAIL.DECODE, 'Contents API 的 content 字段是空的');
  // 先验字符集再解：Buffer.from(..., 'base64') 对非法字符是**静默丢弃**，
  // 一个坏掉的镜像会解出"合法的短正文"，让差分报出一屏「上游删了两千条」。
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
    throw new FetchFail(FETCH_FAIL.DECODE, `content 不是 base64（前 12 字符：${b64.slice(0, 12)}）`);
  }
  const raw = Buffer.from(b64, 'base64');
  if (raw.byteLength > cap) throw new FetchFail(FETCH_FAIL.TOO_LARGE, `解码后 ${raw.byteLength} B，超过上限 ${cap} B`);
  const text = raw.toString('utf8');
  if (!text) throw new FetchFail(FETCH_FAIL.DECODE, 'base64 解出来是空的');
  return { text, bytes: raw.byteLength };
}

/**
 * 单个源走一次。超时用 Promise.race + AbortController：
 * ★ 抢跑的那条 job 必须挂一个 noop catch —— 超时后它还在飞，abort 会让它 reject，
 *   没人接就是 unhandled rejection，宿主进程里凭空多一发没人负责的异常。
 */
export async function fetchOne(source, {
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  cap = MAX_BODY_BYTES,
} = {}) {
  const controller = new AbortController();
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FetchFail(FETCH_FAIL.TIMEOUT, `${source.label} 超过 ${timeoutMs} ms 没返回`));
    }, timeoutMs);
  });
  const job = (async () => {
    const res = await fetchImpl(source.url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: source.decode === 'base64' ? 'application/vnd.github+json' : 'text/plain;q=0.9,*/*;q=0.8' },
    });
    if (!res.ok) throw new FetchFail(FETCH_FAIL.STATUS, `${source.label} 给了 HTTP ${res.status}`);
    return source.decode === 'base64' ? decodeBase64(res, cap) : readCappedText(res, cap);
  })();
  job.catch(() => {});
  try {
    return await Promise.race([job, guard]);
  } catch (e) {
    if (e instanceof FetchFail) throw e;
    throw new FetchFail(FETCH_FAIL.NETWORK, `${source.label} 没连通：${e?.message ?? e}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 按优先级把候选源走一遍。
 * @returns {ok:true, sourceId, sourceUrl, label, text, bytes, sha, failures}
 *   或 {ok:false, code:'all_sources_failed', reason, failures}
 * 全失败时 failures 一条不少 —— sync 把它整份写进流水，界面才说得出是哪个源出了什么事。
 */
export async function fetchCatalog({ sourcePriority, fetchImpl, timeoutMs, cap, logger } = {}) {
  const list = orderedSources(sourcePriority);
  const failures = [];
  for (const source of list) {
    try {
      const { text, bytes } = await fetchOne(source, { fetchImpl, timeoutMs, cap });
      return {
        ok: true,
        sourceId: source.id,
        sourceUrl: source.url,
        label: source.label,
        text,
        bytes,
        sha: sha256Hex(text),
        failures,
      };
    } catch (e) {
      const code = e?.code ?? FETCH_FAIL.NETWORK;
      const reason = e?.message ?? String(e);
      failures.push({ sourceId: source.id, label: source.label, code, reason });
      logger?.warn?.(`[api-catalog] ${source.label} 取正文失败（${code}）：${reason}`);
    }
  }
  return {
    ok: false,
    code: 'all_sources_failed',
    reason: list.length ? `${list.length} 个源都没拿到正文` : '源优先级是空的，没有可试的源',
    failures,
  };
}
