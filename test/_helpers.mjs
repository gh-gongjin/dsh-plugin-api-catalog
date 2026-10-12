/**
 * test/_helpers.mjs —— 零框架跑测器 + 假设施（口径继承 sysops / modelwatch / gh-trending）。
 *   node test/<x>.test.mjs 直跑；用例名含「真机」时 SKIP_LOCAL=1 跳过并打印 SKIP。
 *
 * 假 storageDomain / 假 fetch 是 gh-trending 同名文件的同源拷贝，只改了两处：
 *   · 域默认 layout 记账（per-record 的键闸门必须在离线面就撞出来，见 makeFakeFacility 的 put）；
 *   · 假 fetch 的 304 分支换成按 SHA 的"没变化"分支 —— 本插件上游是裸 CDN 文件，实测不吃 ETag。
 * makeReq / makeRes（S3 的 api.js 到位后才拷，见 gh-trending 同名文件）有两处实质差别：
 *   · makeRes 记 head = {statusCode, ...headers}（SSE 要断言 Content-Type 与 X-Accel-Buffering），
 *     并支持 failNext —— 「心跳写失败当场摘牌」只能靠 write 抛一次才测得出来；
 *   · makeReq 带真的监听表（on / emit / listenerCount）—— 「非本机 403 连请求流都不消费」和
 *     「body 必须从流里拼」这两条判据，断言的是谁在什么时候挂了 data 监听，光看返回值证不出来。
 *   · S8 起 makeFakeCtx 可选注入 llm / agentDefaultModel（默认 undefined = 宿主没给这一档）：
 *     「默认零调用」这条判据只能靠 spy 句柄的调用次数来钉，句柄不外给就没法证"真调了/真没调"。
 */
import assert from 'node:assert/strict';
import { RECORD_KEY_RE } from '../lib/domain.js';

const cases = [];
export function check(name, fn) { cases.push({ name, fn }); }

export async function runAll(suiteLabel) {
  const skipLocal = process.env.SKIP_LOCAL === '1';
  let pass = 0; let skip = 0; const fails = [];
  const names = new Set();
  for (const c of cases) {
    if (names.has(c.name)) throw new Error(`用例名重号：${c.name}`);
    names.add(c.name);
  }
  for (const c of cases) {
    if (skipLocal && c.name.includes('真机')) { skip += 1; console.log(`SKIP ${c.name}`); continue; }
    const t0 = Date.now();
    try {
      await c.fn();
      pass += 1;
      console.log(`ok   ${c.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      fails.push({ name: c.name, e });
      console.log(`FAIL ${c.name}\n  ${e?.message ?? e}`);
    }
  }
  console.log(`\n[${suiteLabel}] pass ${pass} / fail ${fails.length} / skip ${skip}`);
  if (fails.length) process.exitCode = 1;
}

export { assert };

/** 读夹具文本（UTF-8）。 */
export async function fixture(name) {
  const fs = await import('node:fs');
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return fs.readFileSync(url, 'utf8');
}

/** 扫源码判据（图纸与纯常量文件 require 不出来跑，只能逐字钉）。 */
export async function sourceText(rel) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

/**
 * 假 storageDomain 设施：open 计数 + already-open 语义（域名排他，同 sysops 血案口径）。
 * handle.table(name) → { get, put, delete, entries, keys }
 *
 * ★ 与 gh-trending 版唯一的实质差别：put 会**按域的 layout 重现宿主的 per-record 键闸门**
 *   （宿主 `dsh-storage-json/lib/index.js:535` 不过 SAFE_KEY_RE 就抛）。
 *   本插件的键是 lib/keys.js 现算的，闸门不重现的话，编码层写错在离线面全绿、真机上才炸。
 */
export function makeFakeFacility() {
  const openDomains = new Map();
  const calls = { open: 0, close: 0, puts: 0 };
  return {
    calls,
    async open(domain) {
      calls.open += 1;
      if (openDomains.has(domain.name)) throw new Error(`already-open: ${domain.name}`);
      const perRecord = domain.layout === 'per-record';
      const tables = new Map();
      const state = { closed: false };
      const handle = {
        table(name) {
          if (state.closed) throw new Error('CLOSED');
          if (!domain.tables[name]) throw new Error(`域 '${domain.name}' 没声明表 '${name}'`);
          if (!tables.has(name)) {
            const rows = new Map();
            tables.set(name, {
              get: (k) => (rows.has(k) ? rows.get(k) : undefined),
              put: async (k, v) => {
                if (perRecord && !RECORD_KEY_RE.test(k)) {
                  throw new Error(`unit '${domain.name}': per-record key '${k}' is not path-safe (must match ${RECORD_KEY_RE})`);
                }
                rows.set(k, v);
                calls.puts += 1;
              },
              delete: async (k) => { rows.delete(k); },
              // ★ 真实宿主这里返回 lazy iterator；故意也返回迭代器，逼调用方写 [...t.entries()]
              entries: () => rows.entries(),
              keys: () => rows.keys(),
              _rows: rows,
            });
          }
          return tables.get(name);
        },
        async close() { state.closed = true; openDomains.delete(domain.name); calls.close += 1; },
      };
      openDomains.set(domain.name, handle);
      return handle;
    },
    /** 测试专用：直接看某表当前行数（不参与插件逻辑）。 */
    rowCount(domainName, table) {
      const h = openDomains.get(domainName);
      if (!h) return -1;
      return h.table(table)._rows.size;
    },
    /** 测试专用：读某表一行的**原始**内容（不经仓储的合并与钳制）。 */
    rawRow(domainName, table, key) {
      const h = openDomains.get(domainName);
      if (!h) return undefined;
      return h.table(table)._rows.get(key);
    },
    /**
     * 测试专用：往已打开的域里塞一行**未经 schema 校验**的原始数据。
     * 用途是模拟"上一版插件写的行 / 手工改过的库"——这类脏行只有绕开 put 才进得去，
     * 而读路径（clampPrefs / metaOf）必须扛住它。
     */
    seed(domainName, table, key, value) {
      const h = openDomains.get(domainName);
      if (!h) throw new Error(`域未打开，塞不进行：${domainName}`);
      h.table(table)._rows.set(key, value);
    },
  };
}

/**
 * 假 HTTP：按 URL 前缀路由到预置响应；记录请求（url + headers + signal）。
 * 响应形状 { status, text | json, stream, chunkSize, headers:{ 'content-length', ... } }，
 * 也可以给函数 (url, opts) => 同形。routes 值带 `fail: '...'` ⇒ fetch 直接 reject（断网/DNS 那一类）。
 *
 * ★ 默认给 res.body 提供 getReader()，因为真实宿主用的全局 fetch 就是流式的 ——
 *   只有流式读才拦得住「源把 100 MB 灌进宿主进程」，text() 之后判长度拦不住。
 *   要测"没有 body 的 fetch 实现"那条兜底路径，路由里写 stream:false。
 * ★ 没有 304 通道：登记表上那几档实测都是裸文件下载（jsDelivr 吃缓存但不吃 If-None-Match），
 *   「有没有变」由正文 SHA-256 判（lib/sync.js），所以这里不重现 gh-trending 的 ETag 分支。
 */
export function makeFakeFetch(routes) {
  const seen = [];
  // 读取计数：断言"声明超限就连一个字节都不读"这类判据要用它，光看返回值证不出来。
  const counts = { reads: 0, cancels: 0, textCalls: 0, jsonCalls: 0 };
  const makeBody = (text, chunkSize) => {
    const buf = Buffer.from(text, 'utf8');
    const size = Number(chunkSize) > 0 ? Number(chunkSize) : 65536;
    let at = 0;
    return {
      getReader() {
        return {
          read: async () => {
            counts.reads += 1;
            if (at >= buf.length) return { done: true, value: undefined };
            const value = new Uint8Array(buf.subarray(at, Math.min(at + size, buf.length)));
            at += value.length;
            return { done: false, value };
          },
          cancel: async () => { counts.cancels += 1; at = buf.length; },
        };
      },
    };
  };
  const fetchFn = async (url, opts = {}) => {
    seen.push({ url, headers: opts.headers || {}, signal: opts.signal, method: opts.method });
    if (opts.signal?.aborted) throw new Error('请求发出时已被 abort');
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) throw new Error(`假 fetch 没登记这个 URL：${url}`);
    let r = routes[key];
    if (typeof r === 'function') r = await r(url, opts);
    if (r.fail) {
      // 支持"慢失败"：模拟超时用（定时器先到就已经判 TIMEOUT，这条 promise 之后才 reject）
      if (r.after) await new Promise((resolve) => setTimeout(resolve, r.after));
      throw new Error(r.fail);
    }
    if (r.after) await new Promise((resolve) => setTimeout(resolve, r.after));
    const status = r.status ?? 200;
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
    const text = r.text ?? '';
    if (!headers.has('content-length') && typeof text === 'string') {
      headers.set('content-length', String(Buffer.byteLength(text, 'utf8')));
    }
    const body = r.stream === false ? undefined : makeBody(text, r.chunkSize);
    return {
      ok: status >= 200 && status < 300,
      status,
      body,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
      text: async () => {
        counts.textCalls += 1;
        if (status >= 400) throw new Error('非 2xx 不该读正文');
        return text;
      },
      json: async () => {
        counts.jsonCalls += 1;
        if (status >= 400) throw new Error('非 2xx 不该读正文');
        return r.json;
      },
    };
  };
  fetchFn.seen = seen;
  fetchFn.counts = counts;
  return fetchFn;
}

/** 跑掉微任务队列（假 fetch 之后断言用）。 */
export async function flush(ms = 5) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * 假宿主定时器：`interval(fn, ms)` 返回 **disposer 函数**（不是 handle）—— 这条契约必须在离线面重现，
 * 对它调 clearInterval 是静默 no-op，插件就会攒出一堆叠加的定时器（gh-trending 装配病历同条）。
 */
export function makeFakeTimer() {
  const armed = [];
  return {
    armed,
    api: {
      interval(fn, ms) {
        const job = { fn, ms, disposed: false, disposeCount: 0 };
        job.dispose = () => { job.disposeCount += 1; if (job.disposeCount === 1) job.disposed = true; };
        armed.push(job);
        return job.dispose;
      },
    },
    /** 测试专用：手动敲最后挂上的那一发。 */
    fireLast() { const job = armed[armed.length - 1]; if (!job) throw new Error('一个定时器都没挂上'); job.fn(); return job; },
    liveCount() { return armed.filter((j) => !j.disposed).length; },
  };
}

/**
 * 宿主模型句柄的 spy（S8 起 translate.test.mjs 与 _client-harness.mjs **共用这一份**）：
 * 帧序列由用例给，调用次数与交给 stream 的 opts 都留痕（口径同 gh-trending 的 llm 用例）。
 * 两处各抄一份的话，真宿主换帧形状时只会有一边跟着改 —— 界面上那条「宿主没给出模型服务」就测不到了。
 */
export function makeLlmHandle(frames = [{ type: 'text-delta', text: '英国的公共图书馆数据。' }, { type: 'finish' }]) {
  const calls = [];
  const handle = {
    calls,
    async *stream(opts) {
      calls.push(opts);
      for (const f of frames) {
        if (f?.throw) throw new Error(f.throw);
        if (f?.wait) await f.wait;
        yield f;
      }
    },
  };
  return handle;
}

/** agentDefaultModel 的 spy：`currentSelection` 给值 / 抛异常 / 记调用次数，三种分支都由用例点。 */
export function makeModelPicker(sel) {
  const calls = { n: 0 };
  return {
    calls,
    currentSelection() {
      calls.n += 1;
      if (sel instanceof Error) throw sel;
      return sel;
    },
  };
}

/**
 * 假 ctx：只装本插件装配用到的门面（inject 立刻执行、effect **也立刻执行**、on/emit 记账）。
 * 真实宿主把 inject 跑在独立 fiber 里（不在 apply 同步段执行），这里同步执行是**故意宽松**的：
 * 装配代码不许假设回调同步跑完 —— 但回调里填句柄的顺序两边一致，所以离线断言仍然成立。
 *
 * ★ effect 的口径是从宿主源码抄的（`@deepseek-ai/cordis/lib/index.js:1169` 起，末了 `task = this._execute(runner)`）：
 *   函数体**当场跑**，它返回的那个函数才是挂到 scope 上的撤销器。之前这里只收不发，
 *   于是 S3 的路由注册会变成"用例以为注册过了，其实那个函数一次都没跑"—— 正好是最需要测的那一步。
 */
export function makeFakeCtx({ facility, timer, webServer, llm, agentDefaultModel } = {}) {
  const logs = { warn: [], info: [], error: [] };
  const logger = {
    warn: (m) => logs.warn.push(String(m)),
    info: (m) => logs.info.push(String(m)),
    error: (m) => logs.error.push(String(m)),
  };
  const effects = [];
  const injected = [];
  const handlers = new Map();
  function addEffect(fn, name) {
    const rec = { fn, name, ran: false, disposer: null, disposeCount: 0 };
    rec.dispose = () => { rec.disposeCount += 1; if (typeof rec.disposer === 'function') rec.disposer(); return rec.disposeCount; };
    effects.push(rec);
    rec.ran = true;
    const returned = fn();
    if (typeof returned === 'function') rec.disposer = returned;
    return rec;
  }
  const ctx = {
    logger,
    inject(keys, cb) {
      injected.push([...keys].join(','));
      const payload = { logger, effect: (fn, name) => addEffect(fn, name) };
      if (keys.includes('storageDomain')) payload.storageDomain = facility;
      if (keys.includes('timer')) payload.timer = timer ? timer.api : undefined;
      if (keys.includes('webServer')) payload.webServer = webServer;
      // 现译那两档（S8）：**默认不给** —— 不给就等于宿主没提供这一档服务，
      // 用例要"宿主有模型"时必须自己递一个 spy 句柄进来，并断言它被真调了几次（只数公共方法等于没测）。
      if (keys.includes('llm')) payload.llm = llm;
      if (keys.includes('agentDefaultModel')) payload.agentDefaultModel = agentDefaultModel;
      cb(payload);
      return Promise.resolve();
    },
    effect(fn, name) { return addEffect(fn, name); },
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); },
    emit(ev, arg) { for (const fn of [...(handlers.get(ev) || [])]) fn(arg); },
    _internals: { logs, effects, injected, handlers },
  };
  return ctx;
}

/**
 * 假 res：捕获 writeHead / write / end。
 *  · head 是 {statusCode, ...headers} —— SSE 那两条判据要断言 Content-Type 与 X-Accel-Buffering，
 *    只留 body 就测不出"头写歪了"（浏览器会一直卡在等首帧）。
 *  · failNext：下一次 write 抛一次（心跳/广播写失败当场摘牌那条只能靠真抛测出来）。
 *  · write-after-end 直接抛：长连接被 end 掉之后还继续写，界面上表现为"帧还在动但连接早关了"。
 */
export function makeRes() {
  const res = {
    statusCode: 0, head: null, body: '', ended: false, writes: [], failNext: false,
    writeHead(status, headers) {
      if (this.ended) throw new Error('end 之后还 writeHead');
      this.statusCode = status;
      this.head = { statusCode: status, ...(headers || {}) };
      return this;
    },
    write(chunk) {
      if (this.ended) throw new Error('write after end');
      if (this.failNext) { this.failNext = false; throw new Error('假 res：这一发写不出去'); }
      this.writes.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.ended = true;
    },
    on() {},
    once() {},
    get headersSent() { return this.head !== null; },
    json() { try { return JSON.parse(this.body); } catch { return null; } },
  };
  return res;
}

/**
 * 假 req：带**真的**监听表，body 在下一拍从流里发（宿主只传 (req,res)，POST body 必须自己拼）。
 * 之所以要 listenerCount：「非本机 403 不消费请求流」这条判据断言的是 data 监听数为 0 ——
 * 只看返回值的话，"读完了再拒"也能返回同一个 403。
 */
export function makeReq({ method = 'GET', url = '/', body, socket = { remoteAddress: '127.0.0.1' }, headers = {} } = {}) {
  const listeners = new Map();
  const req = {
    method, url, socket, headers, destroyed: false,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return this; },
    off(ev, fn) { const l = listeners.get(ev); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; },
    listenerCount(ev) { return (listeners.get(ev) || []).length; },
    emit(ev, arg) { for (const fn of [...(listeners.get(ev) || [])]) fn(arg); return listeners.has(ev); },
    destroy() { this.destroyed = true; },
    setTimeout() {},
  };
  // 下一拍再喂：注册监听发生在同一拍的同步段，所以顺序与真实宿主一致。
  setTimeout(() => {
    if (body !== undefined) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', Buffer.from(text, 'utf8'));
    }
    req.emit('end');
  }, 0);
  return req;
}

/**
 * 假 webServer：register 收 {kind:'prefix',path,handler} 并返回**撤销器**（宿主口径）。
 * already-registered 故意做成抛：同一路径注册两发，宿主那边是后一发顶掉前一发，界面会打到"已经不在的那个 handler"。
 */
export function makeFakeWebServer() {
  const registered = [];
  const history = [];
  return {
    registered,
    /** 撤掉之后条目会从 registered 里消失，history 留着看 disposeCount。 */
    history,
    register(spec) {
      if (!spec || spec.kind !== 'prefix' || typeof spec.handler !== 'function') {
        throw new Error(`假 webServer 只认 {kind:'prefix', path, handler}，收到 kind=${spec?.kind} handler=${typeof spec?.handler}`);
      }
      if (registered.some((r) => r.path === spec.path)) throw new Error(`already-registered: ${spec.path}`);
      const entry = { ...spec, disposeCount: 0 };
      registered.push(entry);
      history.push(entry);
      return () => {
        entry.disposeCount += 1;
        const i = registered.indexOf(entry);
        if (i >= 0) registered.splice(i, 1);
      };
    },
    /** 测试专用：按前缀拿 handler（跑路由判据用）。 */
    handlerFor(path) { const r = registered.find((x) => x.path === path); return r ? r.handler : undefined; },
    openCount() { return registered.length; },
  };
}
