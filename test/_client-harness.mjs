/**
 * test/_client-harness.mjs —— 浏览器半边的沙箱夹具：真装配的宿主半边 + 手搓 mini React + 假定时器。
 *
 * 为什么单列一个文件：test/client.test.mjs（判据全在那份文件头上）与 test/make-prototype.mjs（出图纸）
 * 必须走**同一条挂载路径**。图纸若是手搓的静态 HTML，改了 client.js 忘了改图纸，S5 的截图就在替一个
 * 已经不存在的界面说话 —— 所以图纸是 client.js 渲染出来的那棵树序列化出来的产物，不是第二次设计。
 *
 * ⚠️ 定时器是假的（沙箱里 setTimeout 全走本文件的 record）：防抖那 250 ms 与重连那 5 s 由调用方点名放，
 *    不靠真等。代价是「时间到了自己会响」这条测不到 —— 那一条在 assembly/host-compat 里另有判据。
 *
 * ★ 现译（S8/S9）起本夹具多两个门面：
 *  · mountServer({llm, modelPicker})：宿主给不给模型服务由用例决定（默认都不给 = 宿主没这一档）。
 *    句柄形状与 translate.test.mjs 用的是**同一份**（都在 _helpers.mjs），两边漂了会立刻红；
 *  · loadClient({ssePatch})：只把推流帧里的指定键摘掉，模拟「服务端那半边比界面旧」（改 index.js 没重启）。
 *    解析不了就抛：这一发要是没匹配上任何帧，用例等于什么都没测。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import {
  assert, fixture, flush, makeFakeFacility, makeFakeFetch, makeFakeCtx, makeFakeTimer, makeFakeWebServer,
  makeReq, makeRes
} from './_helpers.mjs';
import { apply as mountHost, __peek } from '../index.js';
import {
  noteKey
} from '../lib/keys.js';
import {
  ROUTE_PREFIX, GLOBAL_KEY, DOMAIN_NAME, TABLES, SOURCES, PREFS_KEY
} from '../lib/domain.js';

const README = await fixture('public-apis-README.md');
/**
 * 现用源（2026-10-07 裁定：llf007/public-apis-cn 为唯一目录源，英文那份留作降级候选）。
 * ★ 默认夹具**仍是英文那份**，不是疏忽：界面那条「中文标签 + 悬停里带上游原文」的判据只有英文载荷
 *   才有样本（CN 的分类名自己就是中文，`lib/categories.js` 那张表不参与）。CN 那份的形状由 `CN_*`
 *   那组常量和 client.test.mjs 里专门几条判据覆盖，两份都得是活的。
 */
const CN_README = await fixture('public-apis-cn-README.md');

/** 本轮夹具的真读数（出处：spec §9.2 台账；改夹具要一起改这里）。 */
const TOTAL = 2019;
const CATEGORIES = 51;
const NO_KEY = 963;
const BROWSER_DIRECT = 450;
const TOP_HOST = 'github.com';
const TOP_HOST_COUNT = 112;

/** CN 夹具的真读数（出处：spec §9.1s；同 query.test.mjs 那一组数字）。 */
const CN_TOTAL = 1494;
const CN_CATEGORIES = 54;
const CN_NO_KEY = 673;
const CN_BROWSER_DIRECT = 212;

/* ================================================================== *
 * 1) 宿主半边：真装配（上游 fetch 是假的，其它都是真的）
 * ================================================================== */

/** 这一份夹具正文会由链上哪一档答上 ⇒ 页头那句源名的真值（夹具与源配对，见 mountServer 里那段）。 */
const answeredIdOf = (body) => (body === CN_README
  ? SOURCES.find((s) => s.id.startsWith('cn-'))
  : SOURCES.find((s) => !s.id.startsWith('cn-'))).id;
/** 载荷里那一档的 label（页头念的就是这一串，别在浏览器半边再抄一份源名）。 */
const labelOf = (id) => (SOURCES.find((s) => s.id === id) || {}).label || '';

async function mountServer({ withTimer = true, facility = makeFakeFacility(), body = README, llm, modelPicker } = {}) {
  const state = { body, delay: 0 };
  // ★ 夹具与源**必须配对**：喂英文那份正文时，CN 两档要真的不通。让整条链都答同一个正文，
  //   meta.sourceId 就会说成 cn-jsdelivr，而屏幕上是英文条目 —— 页头那句源名、以及图纸上那张图，
  //   都在替一句假话背书（降级这条路本身也就没被测到）。
  const wantCn = body === CN_README;
  const upstream = makeFakeFetch(Object.fromEntries(
    SOURCES.map((s) => [s.url, () => (s.id.startsWith('cn-') === wantCn
      ? { text: state.body, after: state.delay }
      : { fail: wantCn ? '降级源这一轮不该被碰到' : '中文源这一档在夹具里不通 ⇒ 走降级' })]),
  ));
  const savedFetch = globalThis.fetch;
  globalThis.fetch = upstream;
  const ws = makeFakeWebServer();
  // llm / agentDefaultModel 默认 undefined：宿主没给这一档 ⇒ status().llmReady 是 false，界面要如实念。
  const ctx = makeFakeCtx({
    facility, ...(withTimer ? { timer: makeFakeTimer() } : {}), webServer: ws,
    llm, agentDefaultModel: modelPicker,
  });
  const teardown = mountHost(ctx, { autoSyncOnStart: false });
  // 存储域 open 的成败要等 reloadPrefs 落定才算数（strict 读，见 index.js 第 4 段）。
  // 载荷是宿主在浏览器要入口时才现算的，所以这里也等一拍再 emit —— 不等就会拿到"还没来得及探测"的那份。
  await flush(4);
  const table = [];
  ctx.emit('webserver/index-inject', table);
  return {
    state, ws, ctx, facility, upstream, teardown, savedFetch,
    payload: table[0]?.value ?? null,
    handler: () => ws.handlerFor(ROUTE_PREFIX),
    /** 真跑一轮（走 index.js 的 runOnce：差分、流水、推流全在那里）。 */
    sync: (trigger = 'manual') => __peek('runOnce')(trigger),
    /** 库里那一行笔记的**原始**内容（判据要的是落库，不是屏幕上回显）。 */
    rawNote: (slug) => facility.rawRow(DOMAIN_NAME, TABLES.notes, noteKey(slug)),
    rawPrefs: () => facility.rawRow(DOMAIN_NAME, TABLES.prefs, PREFS_KEY),
    noteRows: () => facility.rowCount(DOMAIN_NAME, TABLES.notes),
    close() { globalThis.fetch = this.savedFetch; teardown(); },
  };
}

/* ================================================================== *
 * 2) 沙箱定时器：假到能被用例点名放
 * ================================================================== */

function makeSandboxTimers() {
  const armed = new Map();
  let seq = 1;
  const api = {
    setTimeout(fn, ms) { const id = seq++; armed.set(id, { id, fn, ms, kind: 'timeout' }); return id; },
    clearTimeout(h) { armed.delete(h); },
    setInterval(fn, ms) { const id = seq++; armed.set(id, { id, fn, ms, kind: 'interval' }); return id; },
    clearInterval(h) { armed.delete(h); },
  };
  return {
    ...api,
    armed,
    live: (ms, kind = 'timeout') => [...armed.values()].filter((t) => t.kind === kind && (ms === undefined || t.ms === ms)),
    /** 放掉匹配 ms 的每一发（快照遍历：回调里新挂的定时器留给下一轮，行为更可预期）。 */
    fire(ms) {
      const hit = [...armed.values()].filter((t) => t.kind === 'timeout' && (ms === undefined || t.ms === ms));
      for (const t of hit) armed.delete(t.id);
      for (const t of hit) t.fn();
      return hit.length;
    },
    fireAll() { return this.fire(undefined); },
  };
}

/* ================================================================== *
 * 3) 迷你 React：真 hook、真重渲染、真卸载撤销
 * ================================================================== */

const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

function makeMiniReact() {
  const instances = new Map();
  const effectQueue = [];
  let active = null;
  let dirty = false;
  let dead = false;
  let rootEl = null;
  let tree = null;

  const slotOf = (init) => {
    if (!active) throw new Error('hook 在组件之外被调用了（迷你 React 只支持函数组件体内使用）');
    const i = active.cursor++;
    if (!active.hooks[i]) active.hooks[i] = init();
    return active.hooks[i];
  };

  const React = {
    createElement: (type, props, ...children) => ({ __el: 1, type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(init) {
      const slot = slotOf(() => ({ kind: 'state', value: typeof init === 'function' ? init() : init }));
      return [slot.value, (v) => {
        if (dead) return;
        const next = typeof v === 'function' ? v(slot.value) : v;
        if (Object.is(next, slot.value)) return;
        slot.value = next;
        dirty = true;
      }];
    },
    useRef(init) {
      return slotOf(() => ({ kind: 'ref', ref: { current: init === undefined ? null : init } })).ref;
    },
    useEffect(fn, deps) {
      const inst = active;
      const i = inst.cursor++;
      const prev = inst.hooks[i];
      const slot = prev ?? { kind: 'effect', deps: undefined, cleanup: null };
      inst.hooks[i] = slot;
      // ★ 先比再写：提前把 slot.deps 赋过去，下一次比较就变成"自己和自己比"，effect 再也不重跑。
      const changed = !prev || !sameDeps(prev.deps, deps);
      slot.deps = deps;
      if (!changed) return;
      effectQueue.push(() => {
        if (typeof slot.cleanup === 'function') slot.cleanup();
        if (dead) return;
        const c = fn();
        slot.cleanup = typeof c === 'function' ? c : null;
      });
    },
    useCallback(fn, deps) {
      const slot = slotOf(() => ({ kind: 'cb', deps, fn }));
      if (!sameDeps(slot.deps, deps)) { slot.deps = deps; slot.fn = fn; }
      return slot.fn;
    },
  };

  function renderEl(el, path, touched) {
    if (el === null || el === undefined || el === false || el === true) return null;
    if (typeof el === 'string' || typeof el === 'number') return { tag: '#text', props: {}, children: [], text: String(el) };
    if (Array.isArray(el)) return el.map((c, i) => renderEl(c, `${path}/a${i}`, touched)).filter(Boolean);
    const { type, props, children } = el;
    if (typeof type === 'function') {
      const name = type.displayName || type.name || 'Anon';
      const ip = `${path}>${name}[${props.key ?? ''}]`;
      let inst = instances.get(ip);
      if (!inst) { inst = { path: ip, hooks: [], cursor: 0 }; instances.set(ip, inst); }
      inst.cursor = 0;
      touched.add(ip);
      const prev = active;
      active = inst;
      let out;
      // ★ 真 React/Preact 把 h() 的第 3 个以后的参数收进 props.children（单个给值、多个给数组），
      //   组件里解构 children 才拿得到。这里原来只把 children 留在节点对象上，于是
      //   "组件接 children"这条写法在沙箱里静默渲染成空 —— 详情对话框第一次撞出这个缺口。
      const childProps = children.length
        ? { ...props, children: children.length === 1 ? children[0] : children }
        : props;
      try { out = type(childProps); } finally { active = prev; }
      return renderEl(out, ip, touched);
    }
    const kids = [];
    children.forEach((c, i) => {
      const n = renderEl(c, `${path}/${type}[${props.key ?? i}]`, touched);
      if (Array.isArray(n)) kids.push(...n); else if (n) kids.push(n);
    });
    return { tag: type, props, children: kids };
  }

  return {
    React,
    setRoot(el) { rootEl = el; dirty = true; },
    get tree() { return tree; },
    /** 渲染 → 跑 effect → 放微任务，直到既不发请求也不重渲染。 */
    async settle(framesOf) {
      let lastFrames = framesOf ? framesOf() : 0;
      let quiet = 0;
      for (let round = 0; round < 400; round++) {
        const touched = new Set();
        tree = renderEl(rootEl, 'root', touched);
        for (const [p, inst] of [...instances]) {
          if (touched.has(p)) continue;
          for (const h of inst.hooks) if (h.kind === 'effect' && typeof h.cleanup === 'function') h.cleanup();
          instances.delete(p);
        }
        dirty = false;
        const jobs = effectQueue.splice(0, effectQueue.length);
        for (const job of jobs) job();
        await flush(2);
        const frames = framesOf ? framesOf() : 0;
        const busy = dirty || effectQueue.length || (framesOf && frames !== lastFrames);
        if (busy) { quiet = 0; lastFrames = frames; continue; }
        quiet += 1;
        if (quiet >= 2) return tree;
      }
      throw new Error('settle 不收敛（400 轮还在重渲染）—— 十有八九是 setState 写在了渲染路径上');
    },
    unmount() { dead = true; instances.forEach((inst) => { for (const h of inst.hooks) if (h.kind === 'effect' && typeof h.cleanup === 'function') h.cleanup(); }); },
    instanceCount: () => instances.size,
  };
}

/* ================================================================== *
 * 4) 假 DOM（只有 client.js 用到的那几项）
 * ================================================================== */

function makeFakeDoc({ styleAlready = false } = {}) {
  const ops = [];
  let styleEl = styleAlready ? { id: 'already-there' } : null;
  const created = [];
  const doc = {
    ops,
    created,
    // styleAlready 时按 id 一律命中：client.js 只会问它自己那一个 id（宿主那边同理），
    // 这里要测的是"已经有一份就别再塞"，不是 id 拼写。
    getElementById: (id) => (styleAlready ? { id } : styleEl && styleEl.id === id ? styleEl : null),
    createElement: (tag) => {
      const el = {
        tag, id: '', _t: '', download: '', href: '', rel: '',
        set textContent(v) { this._t = v; },
        get textContent() { return this._t; },
        remove() { ops.push('remove'); },
        click() { ops.push('click'); },
      };
      created.push(el);
      return el;
    },
    head: {
      appendChild(el) { styleEl = el; ops.push(`append:${el.id}`); },
    },
    body: {
      appendChild(el) { ops.push(`body+${el.tag}`); },
      removeChild(el) { ops.push(`body-${el.tag}`); },
    },
    // ★ 键盘监听表：详情对话框把关闭挂在 document 的 keydown 上。这张表在桩里不是摆设 ——
    //   注册进监听器的回调必须能被真调一次（emitKey），否则「Esc 能关」这句在沙箱里等于没测。
    listeners: {},
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); ops.push(`on:${type}`); },
    removeEventListener(type, fn) {
      const l = doc.listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
      ops.push(`off:${type}`);
    },
    /** 真发一次键盘事件，返回还剩几个监听器（用例用它同时验"关掉了"和"摘干净了"）。 */
    emitKey(type, ev) {
      const l = doc.listeners[type] || [];
      l.slice().forEach((fn) => fn(ev));
      return l.length;
    },
  };
  return doc;
}

/* ================================================================== *
 * 5) client.js 装载 + 渲染驱动
 * ================================================================== */

function makeClientCtx() {
  const effects = [];
  const registered = [];
  let slot = null;
  return {
    effects,
    registered,
    slots: {
      inject(name, cb) { slot = name; try { cb(); } finally { slot = null; } },
      register(spec, comp) {
        const rec = { slot, spec, comp, disposed: 0 };
        registered.push(rec);
        return () => { rec.disposed += 1; };
      },
    },
    effect(fn, label) {
      const rec = { label, ran: false, disposeCount: 0 };
      effects.push(rec);
      rec.ran = true;
      const d = fn();
      rec.disposer = typeof d === 'function' ? d : null;
      rec.dispose = () => { rec.disposeCount += 1; if (rec.disposer) rec.disposer(); return rec.disposeCount; };
      return rec;
    },
  };
}

function makeBridge(server, opts = {}) {
  const calls = [];
  const streams = [];
  let inflight = 0;

  // 帧的写法由 lib/api.js 决定：`event: X\ndata: {json}\n\n`；注释行（`: ok`、`: ping`）原样过。
  const patchFrame = opts.ssePatch
    ? (text) => {
      if (!text.startsWith('event:')) return text;
      const nl = text.indexOf('\ndata: ');
      if (nl < 0) throw new Error(`ssePatch 撞到一帧没有 data 段的 event：${text.slice(0, 60)}`);
      let data;
      try { data = JSON.parse(text.slice(nl + 7).replace(/\n\n$/, '')); }
      catch (e) { throw new Error(`ssePatch 解析 data 段失败（帧形状漂了）：${e?.message ?? e}`); }
      return `${text.slice(0, nl + 7)}${JSON.stringify(opts.ssePatch(data))}\n\n`;
    }
    : null;

  const frameCount = () => streams.reduce((n, s) => n + s.writes.filter((w) => w.startsWith('event:')).length, 0);
  const pendingRead = (s) => {
    if (s.queue.length) {
      const chunk = s.queue.shift();
      return Promise.resolve({ done: false, value: new TextEncoder().encode(chunk) });
    }
    if (s.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      s.waiter = () => resolve(pendingRead(s));
    });
  };

  const streamRes = (s) => ({
    statusCode: 0,
    head: null,
    writeHead(status, headers) { s.head = { statusCode: status, ...(headers || {}) }; s.onHead(status); return this; },
    write(chunk) {
      if (s.ended) throw new Error('end 之后还写');
      const text = patchFrame ? patchFrame(String(chunk)) : String(chunk);
      s.writes.push(text);
      if (text.includes('event: ')) s.opening = false;
      s.queue.push(text);
      if (s.waiter) { const w = s.waiter; s.waiter = null; w(); }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) s.queue.push(String(chunk));
      s.ended = true;
      if (s.waiter) { const w = s.waiter; s.waiter = null; w(); }
    },
    on() {}, once() {},
  });

  const impl = (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const u = new URL(url, 'http://dsh.local');
    const call = { method, url: String(url), path: u.pathname, search: u.search, body: opts.body, headers: opts.headers ?? {} };
    calls.push(call);
    const req = makeReq({ method, url: `${u.pathname}${u.search}`, body: opts.body, headers: call.headers, socket: { remoteAddress: '127.0.0.1' } });
    if (u.pathname === `${ROUTE_PREFIX}/api/stream`) {
      const s = { queue: [], waiter: null, ended: false, opening: true, head: null, writes: [], onHead: () => {} };
      streams.push(s);
      // ★ Promise 必须在调 handler 之前建好：openSse 在 handler 的同步段就 writeHead 冲缓冲，
      //   晚一步赋值就等于把这一次 fetch 永远挂住（真浏览器是收到头就 resolve，这里得同口径）。
      const p = new Promise((resolve) => {
        s.onHead = (status) => resolve({
          ok: status >= 200 && status < 300,
          status,
          body: { getReader: () => ({ read: () => pendingRead(s), cancel: () => { s.ended = true; } }) },
        });
      });
      inflight += 1;
      server.handler()(req, streamRes(s))
        .catch(() => {})
        .then(() => { inflight -= 1; s.opening = false; });
      return p;
    }
    inflight += 1;
    return (async () => {
      try {
        const res = makeRes();
        await server.handler()(req, res);
        await flush(1);   // POST 的 body 在下一拍才从流里喂进来
        return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => res.json() };
      } finally {
        inflight -= 1;
      }
    })();
  };

  impl.busy = () => inflight > 0 || streams.some((s) => (s.opening && !s.ended) || s.queue.length > 0);
  impl.frameCount = frameCount;
  impl.streams = streams;
  impl.calls = calls;
  return impl;
}

/**
 * 装载 client.js 并把主面板渲染起来。
 * @param server mountServer() 的结果
 * @param opts.payload 顶载荷（默认用真装配推的那一份；传 null 测「载荷没到」）
 * @param opts.ssePatch (snapData)=>snapData：只在推流帧出沙箱之前改那一份快照，用来演「服务端没这一格」
 * @param opts.blob 沙箱里有没有 Blob/URL.createObjectURL（导出的两条分支）
 * @param opts.render 渲染哪个入口组件（默认 main 槽那个）
 */
async function loadClient(server, opts = {}) {
  const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const timers = makeSandboxTimers();
  const doc = makeFakeDoc(opts);
  const bridge = makeBridge(server, opts);
  const mini = makeMiniReact();
  const loaded = {};
  const requires = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          loaded.id = id;
          loaded.exports = factory((name) => {
            requires.push(name);
            if (name === 'react') return mini.React;
            throw new Error(`client 要了白名单外的依赖：${name}`);
          });
        },
      },
    },
    document: doc,
    // ★ innerWidth：分类栏的初值按视口宽度决定（窄面板默认收起，见 client.js CategoryRail）。
    //   沙箱里不给这个键的话，那条规则会走"读不到宽度"的兜底分支，
    //   于是「窄屏要收起」这条判据在沙箱里永远测不到 —— 拿不到尺寸的环境测不出尺寸分支。
    //   缺省 1280（两栏布局那一档），用例要量窄屏时自己改t.sandbox.innerWidth。
    innerWidth: 1280,
    fetch: bridge,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    console,
    TextDecoder, TextEncoder, URL, URLSearchParams,
  };
  if (opts.blob !== false) {
    sandbox.Blob = class { constructor(parts) { this.parts = parts; this.type = ''; } };
    sandbox.URL = Object.assign(function () {}, { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
  }
  vm.createContext(sandbox);
  // ★ 载荷必须在跑代码之前就位：PANEL_ID 是 factory 顶层读的，晚塞就测不到 profile 覆盖那一条
  const payload = opts.payload === undefined ? server.payload : opts.payload;
  if (payload) sandbox[GLOBAL_KEY] = payload;
  vm.runInContext(code, sandbox);
  const exports = loaded.exports;
  const clientCtx = makeClientCtx();
  const t = {
    exports, sandbox, doc, timers, bridge, mini, clientCtx, requires, payload,
    server,
    calls: bridge.calls,
    /** 库里的偏好（判据看的是落库那一份，不是芯片上的选中态）。 */
    snapPrefs: () => server.rawPrefs(),
    /**
     * 直连问一次服务端（不经界面那条 fetch）。
     * 用途：断言要拿「同一条件下服务端单独查会回什么」当基准，与界面上累加出来的结果逐字比 ——
     * 不走界面是因为界面那条路会经过防抖与状态合并，量到的是合并后的结果而不是这一发。
     * 实现走的是真 handler（ws.handlerFor）+ 假 req/res，与 index.js 装配出来的那条路由是同一条。
     */
    async ask(query) {
      const handler = server.handler();
      if (typeof handler !== 'function') throw new Error('拿不到路由 handler，ask() 不能用');
      const chunks = [];
      let statusCode = 0;
      await handler(
        { url: `${ROUTE_PREFIX}/api/search${query || ''}`, method: 'GET', headers: {} },
        {
          writeHead(code) { statusCode = code; },
          write(c) { chunks.push(String(c)); },
          end(c) { if (c) chunks.push(String(c)); },
          on() {}, once() {}, emit() {},
        },
      );
      if (statusCode !== 200) throw new Error(`ask(${query}) 状态码 ${statusCode}：${chunks.join('').slice(0, 200)}`);
      const body = JSON.parse(chunks.join(''));
      if (!body || body.ok !== true) throw new Error(`ask(${query}) 没答上：${chunks.join('').slice(0, 200)}`);
      return body.data;
    },
    callCount(path) { return bridge.calls.filter((c) => c.path.endsWith(path)).length; },
    lastCall(path) { const list = bridge.calls.filter((c) => c.path.endsWith(path)); return list[list.length - 1]; },
    params(path) { const c = t.lastCall(path); return new URLSearchParams(c ? c.search : ''); },
    async mountMain() {
      exports.apply(clientCtx);
      const main = clientCtx.registered.find((r) => r.slot === 'main');
      if (!main) throw new Error('main 槽没注册任何东西');
      mini.setRoot(mini.React.createElement(main.comp, {}));
      await t.settle();
      return main;
    },
    settle: () => mini.settle(() => (bridge.busy() ? 1 : 0) + bridge.frameCount()),
    tree: () => mini.tree,
    unmount: () => mini.unmount(),
    async close() { mini.unmount(); server.close(); },
  };
  return t;
}

/* ---- 渲染树查询：只认 client.js 真用的 className / tag ---- */

const hasCls = (n, cls) => String(n.props.className || '').split(/\s+/).includes(cls);
const walk = (n, fn) => {
  if (!n) return;
  fn(n);
  (n.children || []).forEach((c) => walk(c, fn));
};
const findAll = (root, pred) => {
  const out = [];
  walk(root, (n) => { if (n.tag !== '#text' && pred(n)) out.push(n); });
  return out;
};
const textOf = (n) => (n.tag === '#text' ? n.text : (n.children || []).map(textOf).join(''));
const byCls = (root, cls) => findAll(root, (n) => hasCls(n, cls));
const clsText = (root, cls) => byCls(root, cls).map(textOf).join('␟');
const findTag = (root, tag) => findAll(root, (n) => n.tag === tag);
const buttonsByText = (root, label, cls) => findAll(root, (n) => n.tag === 'button'
  && (!cls || hasCls(n, cls)) && textOf(n).includes(label));

/**
 * 展开详情那一块（它不是"另一条结果"，是上面那一行的下半句）。
 * ★ 2026-10-05 版式改版：结果区从 `<table>` 换成 `<div class="ac-li">` 列表行，
 *   这里跟着从 `tr.ac-detail-row` 换成 `div.ac-detail`。
 *   ⚠️ 这一处若忘了改，症状是**所有涉及展开详情的用例一起报
 *   「Cannot read properties of undefined (reading 'props')」** ——
 *   看上去像 20 个用例各坏各的，真因只有一个：桩按旧结构找，找不到就返回 undefined。
 *   这种"一条桩坏在一处、红一片"的现象，先查桩再查实现。
 */
/** 开着的那一条行：详情在对话框里以后，列表侧只剩 .ac-li.on 这一枚选中态可指。 */
const detailRowOf = (root) => findAll(root, (n) => hasCls(n, 'ac-li') && hasCls(n, 'on'))[0];

/** 数据行：详情块不算一条结果。 */
const tbodyRows = (root) => findAll(root, (n) => hasCls(n, 'ac-li'));
/** 一行的业务键（data-slug）。**不要按名称去重**：上游真有同名条目。 */
const slugOfRow = (r) => String(r.props['data-slug'] || '');
/** 按卡片标题找到那张卡（`.ac-card-n` 在目录页签有多处：分类栏、结果卡，不定位就会拿到错的）。 */
const cardByTitle = (root, title) => byCls(root, 'ac-card').find((n) => textOf(n).includes(title));
/** 结果卡里那句「N 条命中」的数。 */
const hits = (root) => {
  const card = cardByTitle(root, '条命中');
  assert.ok(card, '结果卡没找到（界面没写出命中数）');
  return Number(textOf(byCls(card, 'ac-card-n')[0]).match(/(\d+) 条命中/)[1]);
};

async function tap(t, node) {
  if (typeof node.props.onClick !== 'function') throw new Error(`这个节点没有 onClick：${node.tag} ${JSON.stringify(node.props.className || '')}`);
  node.props.onClick();
  await t.settle();
  return t.tree();
}
async function typeIn(t, node, value) {
  node.props.onChange({ target: { value } });
  await t.settle();
  return t.tree();
}
/** 放掉防抖那一发并等渲染落定。 */
async function debounce(t) {
  const n = t.timers.fire(250);
  await t.settle();
  return n;
}
/** 点一下会改筛选条件的东西：改完要放掉 250 ms 防抖才看得到请求，不放就等于在测"没发请求"。 */
async function pick(t, node) {
  await tap(t, node);
  await debounce(t);
  return t.tree();
}


/* 树查询：详情、批注输入、标签输入（用例与图纸共用同一套读法）。 */
/** ★ 列表行没有 td：行的内容在 .ac-li-main / .ac-flags 里，按类名取，别按 tag 下标。 */
const cellAt = (r, i) => byCls(r, 'ac-flag')[i];
/** 详情对话框的内容壳（2026-10-06 起：详情在根上的 .ac-modal 里，不再长在列表行下面）。 */
const detailOf = (root) => byCls(root, 'ac-modal')[0];
/** 遮罩：只有它存在才说明浮层真的挂着（对话框没开时应当一个都没有）。 */
const maskOf = (root) => byCls(root, 'ac-modal-mask')[0];
const purposeBox = (root) => findAll(root, (n) => n.tag === 'textarea'
  && String(n.props.placeholder || '').includes('key 在哪个页面拿'))[0];
const tagInput = (root) => findAll(root, (n) => n.tag === 'input' && n.props.placeholder === '可用,已接,备用')[0];

/** 装好并跑过第一轮：屏幕上有数据的那个状态（图纸与用例都从这里起步）。 */
async function booted(extra = {}) {
  const server = await mountServer(extra);
  await server.sync();
  const t = await loadClient(server, extra.clientOpts);
  await t.mountMain();
  t.server = server;
  return t;
}

const goTab = async (t, label) => {
  const btn = buttonsByText(t.tree(), label, 'ac-tab')[0];
  await tap(t, btn);
  return t.tree();
};


/** 后台跑一轮（定时器那一支）：不是点按钮，所以没有 POST /sync 可看，只有推流帧。 */
async function server_round(t) { await t.server.sync('timer'); await t.settle(); }

/* 用例正文（client.test.mjs）与图纸生成器（make-prototype.mjs）共用的出口。 */
export {
  README, CN_README, TOTAL, CATEGORIES, NO_KEY, BROWSER_DIRECT, TOP_HOST, TOP_HOST_COUNT,
  CN_TOTAL, CN_CATEGORIES, CN_NO_KEY, CN_BROWSER_DIRECT, answeredIdOf, labelOf,
  mountServer, makeClientCtx,
  loadClient, hasCls, findAll, textOf, byCls, clsText, findTag, buttonsByText, tbodyRows,
  cardByTitle, hits, tap, typeIn, debounce, pick, booted, goTab, server_round,
  cellAt, detailOf, purposeBox, tagInput, detailRowOf, slugOfRow, maskOf
};
