/**
 * test/assembly.test.mjs —— 宿主半边装配（index.js）。
 *
 * 这里看的不是业务（业务在 store/sync 的用例里），只看装配会真机翻车的四类事：
 *   1. 首轮抢跑：storageDomain 的注入回调跑在独立 fiber，apply 同步段就发 fetch 会赶上"设施还没有"；
 *   2. 能力位谎报：域 open 失败被宽容读成"没写过偏好" ⇒ 界面显示「存储在位」而每次写都在失败；
 *   3. 定时器契约：宿主 timer.interval 返回 **disposer 函数**，拿它当 handle 去 clearInterval 是静默 no-op ⇒ 定时器叠加；
 *   4. 异常不许从定时器回调里漏出去（modelwatch 血案）—— 用例装一个 unhandledRejection 计数器兜全程。
 * 出网走 globalThis.fetch：装配层没有注入通口，所以这里临时替换全局 fetch 并保证还原。
 *
 * ⚠️ 假 ctx 的 inject 回调是**同步**执行的（真实宿主在独立 fiber 里跑）。所以这里不断言
 *    "apply 之后设施还没被碰"这类只有真机才成立的判据，只断言插件自己控制的那部分：发不发 fetch、挂几个定时器。
 */
import { check, runAll, assert, makeFakeFacility, makeFakeFetch, makeFakeCtx, makeFakeTimer, makeFakeWebServer, fixture, flush, sourceText } from './_helpers.mjs';
import { apply, resolveConfig, DEFAULT_CONFIG, __peek, name as PLUGIN_NAME, inject as INJECT } from '../index.js';
import {
  DOMAIN_NAME, TABLES, META_KEY, PREFS_KEY, DEFAULT_PREFS, CHECK_INTERVALS, SOURCES, SYNC_FAIL,
  ROUTE_PREFIX,
} from '../lib/domain.js';
import { KEY_RULE_VERSION } from '../lib/keys.js';

const README = await fixture('public-apis-README.md');
const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(String(e?.message ?? e)));

let fetchSaved = null;
function useGlobalFetch(fn) {
  if (fetchSaved === null) fetchSaved = globalThis.fetch;
  globalThis.fetch = fn;
}
function restoreFetch() {
  if (fetchSaved !== null) { globalThis.fetch = fetchSaved; fetchSaved = null; }
}
function routes(body = README) {
  const map = {};
  for (const s of SOURCES) map[s.url] = { text: body };
  return map;
}
const logsOf = (ctx) => ctx._internals.logs;
const manual = (...args) => __peek('runOnce')(...args);

/* ---- A. 加载契约与配置 ---- */

check('inject 是空数组：硬注入会让"宿主缺任一服务"卡死插件加载', async () => {
  assert.equal(PLUGIN_NAME, 'api-catalog');
  assert.deepEqual(INJECT, []);
});

check('resolveConfig 只认档位与形状对的值，脏值一律回落', async () => {
  assert.equal(resolveConfig({ intervalMin: 7 }).intervalMin, DEFAULT_CONFIG.intervalMin);
  assert.equal(resolveConfig({ intervalMin: 60 }).intervalMin, 60);
  assert.equal(CHECK_INTERVALS.includes(resolveConfig({ intervalMin: '60' }).intervalMin), true);
  assert.equal(resolveConfig({ firstSyncDelayMs: 99_999_999 }).firstSyncDelayMs, 300_000, '首轮延迟能配到几天就等于把定时更新关了');
  assert.equal(resolveConfig({ firstSyncDelayMs: -5 }).firstSyncDelayMs, 0);
  assert.equal(resolveConfig({ label: '' }).label, DEFAULT_CONFIG.label);
  assert.equal(resolveConfig({ panelId: 123 }).panelId, DEFAULT_CONFIG.panelId);
  assert.equal(resolveConfig({ panelOrder: 'x' }).panelOrder, DEFAULT_CONFIG.panelOrder);
  assert.equal(resolveConfig(null).autoSyncOnStart, true);
  assert.equal(resolveConfig({ autoSyncOnStart: 0 }).autoSyncOnStart, false);
  assert.equal('proxyUrl' in resolveConfig({ proxyUrl: 'http://127.0.0.1:7897' }), false, '运行期设不了代理就不该有这一个键（证据在 domain.js 的 DEFAULT_PREFS）');
});

check('index.js 里零 @deepseek-ai import、零第三方 require、零写方法', async () => {
  const src = await sourceText('index.js');
  // 整行注释（含 /** * */ 块）先剔掉再查：文件头那段铁律里就写着 ctx.schedule、@deepseek-ai 这些字样，
  // 连着注释判就是自己判死自己；只剔整行而不剔行尾，是为了不把 'https://…' 这类字符串里的 // 当注释吃掉。
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/['"`][^'"`]*@deepseek-ai\//.test(code), false);
  assert.equal(/\brequire\s*\(/.test(code), false);
  assert.equal(/method:\s*['"]POST['"]/.test(code), false);
  assert.equal(/ctx\.(schedule|jobs|llm)/.test(code), false, '不推通知、不接 LLM（spec §0 裁定）');
});

/* ---- B. 首轮节拍 ---- */

check('首轮不抢跑：apply 的同步段一发 fetch 都不发', async () => {
  const f = makeFakeFacility();
  const fetchImpl = makeFakeFetch(routes());
  useGlobalFetch(fetchImpl);
  try {
    const ctx = makeFakeCtx({ facility: f, timer: makeFakeTimer() });
    const teardown = apply(ctx, { firstSyncDelayMs: 20 });
    assert.equal(fetchImpl.seen.length, 0, '同步段就开跑会赶上设施还没落地的那一档');
    await flush(80);
    assert.ok(fetchImpl.seen.length >= 1, '延迟到位后首轮该自己跑起来');
    assert.equal(f.rowCount(DOMAIN_NAME, TABLES.entries), 51);
    assert.equal(__peek('lastResult').trigger, 'startup');
    teardown();
  } finally { restoreFetch(); }
});

check('autoSyncOnStart:false 就不起首轮（用户要的是"我自己点"）', async () => {
  const f = makeFakeFacility();
  const fetchImpl = makeFakeFetch(routes());
  useGlobalFetch(fetchImpl);
  try {
    const ctx = makeFakeCtx({ facility: f, timer: makeFakeTimer() });
    const teardown = apply(ctx, { autoSyncOnStart: false, firstSyncDelayMs: 10 });
    await flush(40);
    assert.equal(fetchImpl.seen.length, 0);
    assert.equal(__peek('lastResult'), null);
    teardown();
  } finally { restoreFetch(); }
});

/* ---- C. 能力位与降级 ---- */

check('宿主没给 storageDomain：一轮如实报 storage_unavailable，不崩也不 reject', async () => {
  const fetchImpl = makeFakeFetch(routes());
  useGlobalFetch(fetchImpl);
  try {
    const ctx = makeFakeCtx({ timer: makeFakeTimer() });
    const teardown = apply(ctx, { autoSyncOnStart: false });
    const res = await manual('startup');
    assert.equal(res.ok, false);
    assert.equal(res.code, SYNC_FAIL.STORAGE);
    assert.equal(__peek('caps').storageDomain, false);
    assert.ok(logsOf(ctx).warn.some((l) => l.includes('同步没成')), '降级要在日志里留痕');
    teardown();
  } finally { restoreFetch(); }
});

check('域 open 失败不许被读成"没写过偏好"：能力位转 false 并 warn', async () => {
  const fetchImpl = makeFakeFetch(routes());
  useGlobalFetch(fetchImpl);
  const broken = { open: async () => { throw new Error('backend 拒绝了这份声明'); } };
  try {
    const ctx = makeFakeCtx({ facility: broken, timer: makeFakeTimer() });
    const teardown = apply(ctx, { autoSyncOnStart: false });
    await flush(20);
    assert.equal(__peek('caps').storageDomain, false, '存储坏掉了却报"在位"，就是冒充');
    assert.ok(logsOf(ctx).warn.some((l) => l.includes('存储域不可用')), logsOf(ctx).warn.join('\n'));
    assert.equal(__peek('prefsView').sourcePriority.length, SOURCES.length, '读不到偏好也要有一份能跑的默认值');
    teardown();
  } finally { restoreFetch(); }
});

check('webServer 到位：只登记一条前缀路由，撤销注入域时 handler 跟着下线', async () => {
  const ws = makeFakeWebServer();
  const ctx = makeFakeCtx({ facility: makeFakeFacility(), timer: makeFakeTimer(), webServer: ws });
  const teardown = apply(ctx, { autoSyncOnStart: false });
  assert.equal(__peek('caps').webServer, true);
  assert.equal(ws.openCount(), 1, '其余路径都在 lib/api.js 的表里分派，不该各占一条宿主路由');
  assert.equal(ws.registered[0].kind, 'prefix');
  assert.equal(ws.registered[0].path, ROUTE_PREFIX);
  assert.equal(ws.registered[0].handler, __peek('api'), '注册进去的 handler 必须就是 api.js 那一个');
  const routeEffect = ctx._internals.effects.find((e) => e.name === 'api-catalog:route');
  assert.equal(routeEffect?.ran, true, 'effect 的函数体在宿主那边是当场跑的（cordis/lib/index.js:1169 起）');
  assert.equal(typeof routeEffect.disposer, 'function', 'register 的返回值就是撤销器');
  routeEffect.dispose();
  assert.equal(ws.openCount(), 0);
  teardown();
  assert.equal(ws.history[0].disposeCount, 1, '撤销器被两处持有（effect 与 teardown）⇒ 宿主那边重复释放');
});

check('宿主没给 webServer：能力位如实标缺，一条路由都不登记（点开全是 404 的面板比没入口更糟）', async () => {
  const ctx = makeFakeCtx({ facility: makeFakeFacility(), timer: makeFakeTimer() });
  const teardown = apply(ctx, { autoSyncOnStart: false });
  await flush(20);
  assert.equal(__peek('caps').webServer, false);
  const table = [];
  ctx.emit('webserver/index-inject', table);
  assert.equal(table.length, 0);
  teardown();
});

/* ---- D. 定时器契约 ---- */

check('定时器只留一发：重挂先 dispose 旧的（宿主 timer 的返回值是 disposer）', async () => {
  const timer = makeFakeTimer();
  const ctx = makeFakeCtx({ facility: makeFakeFacility(), timer });
  const teardown = apply(ctx, { autoSyncOnStart: false });
  await flush(20);   // storageDomain 回调里的 reloadPrefs 会再重挂一次
  assert.equal(__peek('timerBackend'), 'ctx.timer');
  assert.ok(timer.armed.length >= 2, `两处都该重挂过：只挂了 ${timer.armed.length} 发`);
  assert.equal(timer.liveCount(), 1, `活着的定时器有 ${timer.liveCount()} 发 ⇒ 每轮叠加，节拍会越走越快`);
  assert.equal(timer.armed.filter((j) => j.disposeCount > 1).length, 0, '同一发 disposer 被调了不止一次');
  const live = timer.armed.filter((j) => !j.disposed)[0];
  assert.ok(Number.isFinite(live.ms) && live.ms > 0, `节拍不是正数：${live.ms}`);
  teardown();
  assert.equal(timer.liveCount(), 0, 'teardown 之后定时器还活着');
});

check('宿主没给 timer：退到 setInterval 并显式清掉，能力位如实标缺', async () => {
  const ctx = makeFakeCtx({ facility: makeFakeFacility() });
  const teardown = apply(ctx, { autoSyncOnStart: false });
  await flush(20);
  assert.equal(__peek('timerBackend'), 'setInterval');
  assert.equal(__peek('caps').timer, false);
  assert.ok(logsOf(ctx).warn.some((l) => l.includes('退到 setInterval')), '降级要当场说清');
  teardown();
  teardown();
});

check('定时 tick 跑完按本轮结果重挂，节拍随退避变', async () => {
  const f = makeFakeFacility();
  const timer = makeFakeTimer();
  const allDown = {};
  for (const s of SOURCES) allDown[s.url] = { fail: '连不上' };
  useGlobalFetch(makeFakeFetch(allDown));
  try {
    const ctx = makeFakeCtx({ facility: f, timer });
    const teardown = apply(ctx, { autoSyncOnStart: false });
    await flush(20);
    const before = timer.armed.length;
    const live = timer.armed.filter((j) => !j.disposed);
    assert.equal(live.length, 1);
    const job = live[0];
    const msBefore = job.ms;
    timer.fireLast();
    await flush(40);
    assert.equal(job.disposed, true, 'tick 里重挂时没先停自己那一发');
    assert.equal(timer.armed.length, before + 1, '重挂没多出一发');
    assert.equal(timer.liveCount(), 1);
    const res = __peek('lastResult');
    assert.equal(res.code, SYNC_FAIL.FETCH);
    const base = DEFAULT_PREFS.intervalMin * 60_000;
    assert.equal(msBefore, base, '第一轮之前的节拍该是档位基准值');
    assert.equal(__peek('nextDelayMs'), base * 2, `失败一轮该退到 2 倍：${__peek('nextDelayMs')}`);
    assert.equal(timer.armed[timer.armed.length - 1].ms, base * 2, '重挂的那一发用的还是老节拍');
    teardown();
  } finally { restoreFetch(); }
});

check('库里存的档位才算数：读回来的 intervalMin 决定下一拍', async () => {
  const f = makeFakeFacility();
  const timer = makeFakeTimer();
  useGlobalFetch(makeFakeFetch(routes()));
  try {
    const ctx = makeFakeCtx({ facility: f, timer });
    const teardown = apply(ctx, { autoSyncOnStart: false });
    await manual('manual');
    f.seed(DOMAIN_NAME, TABLES.prefs, PREFS_KEY, { intervalMin: 60, sourcePriority: SOURCES.map((s) => s.id) });
    const res = await manual('manual');
    assert.equal(res.status, 'noChange', '第二轮该走哈希门：' + JSON.stringify(res));
    assert.equal(__peek('prefsView').intervalMin, 60);
    assert.equal(__peek('nextDelayMs'), 3600_000, `没吃到库里的 60 分钟档：${__peek('nextDelayMs')}`);
    assert.equal(f.calls.open, 1, '五张表各开一次域就撞 already-open 了');
    teardown();
  } finally { restoreFetch(); }
});

/* ---- E. 单飞与异常收口 ---- */

check('跑一轮的过程中再触发：跳过并 warn，不并发第二轮，也不外抛', async () => {
  const f = makeFakeFacility();
  const slow = {};
  for (const s of SOURCES) slow[s.url] = { text: README, after: 40 };
  const fetchImpl = makeFakeFetch(slow);
  useGlobalFetch(fetchImpl);
  try {
    const ctx = makeFakeCtx({ facility: f, timer: makeFakeTimer() });
    const teardown = apply(ctx, { autoSyncOnStart: false });
    const first = manual('manual');
    await flush(5);   // 仓储那几步是纯微任务，但假 fetch 的 after 是宏任务：不给这一转的话，第一发还没发出去就能过断言
    assert.equal(__peek('busy'), true, '一轮在飞的时候 busy 得是真的');
    const second = await manual('timer');
    assert.equal(second.skipped, true, '撞车那一发被当成第二轮跑了');
    assert.equal(fetchImpl.seen.length, 1, '并发发出了不止一发');
    assert.ok(logsOf(ctx).warn.some((l) => l.includes('被跳过')));
    await first;
    assert.equal(__peek('busy'), false, '跑完没释放锁，之后每一轮都会被跳过');
    teardown();
  } finally { restoreFetch(); }
});

check('键规则对不上：装配层照实报，一行库都不写', async () => {
  const f = makeFakeFacility();
  useGlobalFetch(makeFakeFetch(routes()));
  try {
    const ctx = makeFakeCtx({ facility: f, timer: makeFakeTimer() });
    const teardown = apply(ctx, { autoSyncOnStart: false });
    await manual('manual');
    f.seed(DOMAIN_NAME, TABLES.meta, META_KEY, { keyRule: KEY_RULE_VERSION + 1, sha: '旧规则那份' });
    const putsBefore = f.calls.puts;
    const res = await manual('manual');
    assert.equal(res.code, SYNC_FAIL.KEY_RULE);
    assert.equal(f.calls.puts, putsBefore, '这一支一行都不许写');
    teardown();
  } finally { restoreFetch(); }
});

check('生命周期撤销器就是 teardown，且宿主半边只注册这一发全局 effect', async () => {
  const ctx = makeFakeCtx({ facility: makeFakeFacility(), timer: makeFakeTimer() });
  const teardown = apply(ctx, { autoSyncOnStart: false });
  const effects = ctx._internals.effects;
  assert.equal(effects.length, 1, `全局位只该有一条生命周期 effect：${effects.map((e) => e.name).join(',')}`);
  assert.equal(effects[0].name, 'api-catalog:lifecycle');
  assert.equal(effects[0].ran, true, 'effect 的函数体当场跑（宿主口径），这里跑出来的就是 teardown 本身');
  assert.equal(effects[0].disposer, teardown, 'effect 的返回值是撤销器，宿主靠它收');
  teardown();
  assert.equal(__peek('timerBackend'), 'none', 'teardown 之后定时器还活着');
});

check('全程没有 unhandled rejection（异常从定时器回调漏出去就是宿主崩）', async () => {
  await flush(120);
  assert.deepEqual(rejections, [], `漏出去了：${rejections.join(' | ')}`);
});

await runAll('assembly');
restoreFetch();
