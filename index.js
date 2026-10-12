/**
 * ============================================================
 * dsh-plugin-api-catalog —— Host Half（宿主半边）index.js
 * ============================================================
 *
 * 装配四件事（与 gh-trending 同形，业务面更小）：
 *   1. 七表仓储（entries / meta / notes / prefs / changes / trans / secrets）+ 同步服务接到 ctx；
 *   2. 按需探测宿主能力（storageDomain / timer / webServer），缺哪项就怎么降级；
 *   3. 定时器按「档位 × 退避倍率」自重挂：每轮跑完用那一轮返回的 nextDelayMs 重新排队；
 *   4. 生命周期结束时先停定时器、后关存储句柄。
 *
 * 铁律（docs/design-spec.md §0）：
 *   · 零 @deepseek-ai/* import —— link: 挂载会解析出第二份模块实例；
 *   · 零第三方依赖 —— 出网只用全局 fetch；
 *   · 对上游全程只读 GET（抓取细节在 lib/fetch.js，这里连一次 fetch 都不发）；
 *   · 不推任何通知：不碰 ctx.schedule / ctx.jobs，变化只落面板；
 *   · 校验失败/忙一律 rejected promise，装配层接住并 warn，绝不让异常从定时器回调里漏出去。
 *
 * 2026-10-06 改判（S8，用户裁定「允许」）：宿主模型句柄从「零调用」改成「**默认零调用**」——
 *   开关（`prefs.transEnabled`）出厂 false ⇒ 一次都不碰；句柄只出现在 lib/translate.js 这一个文件里，
 *   装配层通过它取服务，自己不读那一档服务。判据由 test/host-compat.test.mjs 的 hc-9 钉（白名单从目录派生，不手抄）。
 *   出网因此多了一个例外：只有翻译渠道登记表里的域名，而且只由 lib/translate.js 发。
 *
 * 为什么 inject = []：Cordis 的 Context 是代理，未 inject 的属性读了就抛；
 * 把 webServer / storageDomain / timer 写进 inject 会让「宿主缺任一服务」直接卡死插件加载。
 *
 * ⚠️ ctx.inject 的回调跑在独立 fiber，不在 apply 的同步段执行：能力位与节拍只能在回调里定，
 *    首轮同步也要往后推一档（firstSyncDelayMs），否则它会赶在 storageDomain 落地之前开跑
 *    —— 那一轮不是失败，是"假装存储在位"（sysops 病历：apply 顶层锁死能力快照）。
 *
 * S3 起：webServer 到位就注册 prefix 路由（lib/api.js）并向宿主推入口载荷（webserver/index-inject）。
 * 两者都只在注入回调里做 —— 能力没探测到时一个入口都不推（点开空白页比看不到入口更糟）。
 */
import { createCaps } from './lib/caps.js';
import { createAllStores } from './lib/stores.js';
import { createSync, nextDelayMs } from './lib/sync.js';
import { createQueryEngine } from './lib/query.js';
import { createApiHandler } from './lib/api.js';
import { createTranslateService } from './lib/translate.js';
import { createNetTransport } from './lib/net.js';
import { DESC_ZH_COUNT } from './lib/desc-zh.js';
import {
  DEFAULT_PREFS, CHECK_INTERVALS, CHECK_INTERVAL_LABELS, SOURCES, SOURCE_REJECTED, SYNC_BUSY,
  ROUTE_PREFIX, GLOBAL_KEY, AUTH_LABELS, HTTPS_LABELS, CORS_LABELS,
  PRESETS, CHANGE_KIND_LABELS, CHANGE_FILTER_KINDS, SYNC_STATUS_LABELS, NOTE_PURPOSE_MAX_LEN, TAG_MAX_LEN, TAG_MAX_COUNT,
  PARSE_NOTE,
  TRANS_CHANNELS, TRANS_CRED_FIELDS, TRANS_ERROR_LABELS,
  TRANS_SETTINGS_NOTE, SECRET_SAVED_HINT, TRANS_CRED_BOUNDARY, TRANS_COOLDOWN_NOTE, TRANS_MAX_PER_ROUND,
  PROXY_MODES, PROXY_MODE_LABELS, PROXY_MODE_HINTS, PROXY_URL_MAX, PROXY_URL_BOUNDARY,
} from './lib/domain.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'api-catalog';

/** 零硬 inject：三项服务全部按需注入，缺了也不阻塞加载。 */
export const inject = [];

/**
 * 默认配置。panelOrder 17 排在 GitHub 热榜（16）下方。
 * firstSyncDelayMs：启动后隔多久跑第一轮 —— 给 storageDomain 的注入回调留落地窗口。
 */
export const DEFAULT_CONFIG = {
  panelId: 'api-catalog',
  panelOrder: 17,
  label: '免费 API 目录',
  intervalMin: DEFAULT_PREFS.intervalMin,
  autoSyncOnStart: true,
  firstSyncDelayMs: 5000,
};

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 逐键钳制 profile 里写的配置；只认已知键，脏值绝不带进运行时。
 * 间隔必须是档位表里的数（档位外的值没人知道该等多久）；首轮延迟钳在 [0, 5min]
 * （配成 24 小时等于把"定时更新"关了，而那该用 disabled 表达，不是靠一个延迟）。
 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG };
  const src = raw && typeof raw === 'object' ? raw : {};
  // 白名单而不是展开：把 unknown 键（比如上一版残留的 proxyUrl）原样带进运行时的话，
  // 「只认已知键」这句注释就成了谎话，而读配置的人会因为一个没人消费的键以为代理能配。
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key in src) cfg[key] = src[key];
  }
  if (!CHECK_INTERVALS.includes(Number(cfg.intervalMin))) cfg.intervalMin = DEFAULT_CONFIG.intervalMin;
  else cfg.intervalMin = Number(cfg.intervalMin);
  cfg.autoSyncOnStart = Boolean(cfg.autoSyncOnStart);
  cfg.firstSyncDelayMs = clampInt(cfg.firstSyncDelayMs, DEFAULT_CONFIG.firstSyncDelayMs, 0, 300_000);
  if (typeof cfg.label !== 'string' || !cfg.label) cfg.label = DEFAULT_CONFIG.label;
  if (typeof cfg.panelId !== 'string' || !cfg.panelId) cfg.panelId = DEFAULT_CONFIG.panelId;
  cfg.panelOrder = Number.isFinite(Number(cfg.panelOrder)) ? Math.trunc(Number(cfg.panelOrder)) : DEFAULT_CONFIG.panelOrder;
  return cfg;
}

/** 模块级最近一次装配的运行时快照，只给测试钩子 __peek 用。 */
let lastRuntime = null;

/** 测试钩子：读装配后的运行时诊断（timerBackend / nextDelayMs / busy / caps / lastResult / prefsView / api / engine / translate）。 */
export function __peek(key) {
  const rt = lastRuntime;
  if (!rt || !key) return undefined;
  try {
    if (key === 'timerBackend') return rt.timerBackend();
    if (key === 'nextDelayMs') return rt.nextDelayMs();
    if (key === 'busy') return rt.busy();
    if (key === 'lastResult') return rt.lastResult();
    if (key === 'caps') return rt.caps.read();
    if (key === 'prefsView') return rt.prefsView();
    if (key === 'runOnce') return rt.runOnce;
    if (key === 'api') return rt.api;
    if (key === 'routes') return rt.api.routes;
    if (key === 'hubSize') return rt.api.hub.size;
    if (key === 'engine') return rt.engine;
    if (key === 'translate') return rt.translate;
  } catch { return undefined; }
  return undefined;
}

/**
 * 插件入口。
 * @param ctx 宿主 Context（代理对象，未 inject 的属性读了会抛）
 * @param config profile 为本插件写的 config —— 只能从第二个参数拿，读 ctx.config 会抛
 * @returns 生命周期清理器（同步执行）
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);

  /* ---- 1. 宿主服务句柄：由 ctx.inject 回调延后填入 ---- */
  let storageFacility;
  let intervalFn = null;
  let webServer;
  let timerBackend = 'none';

  /* ---- 2. 能力：现取现算（没探测过 / 探测过且缺 / 宿主架构上不提供，三者不许混） ---- */
  const getFacility = () => storageFacility;
  const caps = createCaps({ logger: ctx.logger });
  let storageOpenFailure = '';
  function syncCaps() {
    caps.mark(
      'storageDomain',
      Boolean(storageFacility) && !storageOpenFailure,
      !storageFacility ? '宿主未提供 ctx.storageDomain，抓到什么只能当场看，批注与变化史留不下来' : storageOpenFailure,
    );
    caps.mark('timer', Boolean(intervalFn), intervalFn ? '' : '宿主未提供 ctx.timer.interval，已退到 setInterval（进程退出前会显式清）');
    caps.mark('webServer', Boolean(webServer), webServer ? '' : '宿主未提供 webServer，一个入口都不注册');
  }

  /* ---- 3. 仓储、同步服务与读侧引擎 ---- */
  const stores = createAllStores({ getFacility, logger: ctx.logger });
  const sync = createSync({ stores, logger: ctx.logger });
  const engine = createQueryEngine({ stores });
  /* ---- 4. 偏好的同步视图（定时器只能同步读，不能等 promise） ---- */
  let prefsView = { intervalMin: resolved.intervalMin, sourcePriority: DEFAULT_PREFS.sourcePriority };
  /** 上一轮告诉我们的下一拍（含退避）。null = 还没跑过 ⇒ 用当前档位的基准值。 */
  let nextDelay = null;

  async function reloadPrefs() {
    try {
      // strict：装配层必须知道「读不到」是域坏了还是没写过 —— 宽容读会把前者伪装成后者，
      // 能力位就谎报「本地存储在位」，而实际上每次写都在失败。
      prefsView = await stores.prefs.read({ strict: true });
      storageOpenFailure = '';
    } catch (e) {
      if (storageFacility) {
        storageOpenFailure = '存储域 open 失败，偏好转默认值，改动落不了库';
        ctx.logger?.warn?.(`[api-catalog] 存储域不可用（${e?.message ?? e}），偏好转默认值`);
      }
    }
    syncCaps();
  }

  function currentDelayMs() {
    return nextDelay === null ? nextDelayMs(prefsView, { backoff: 0 }) : nextDelay;
  }

  /* ---- 4.4 出网传输层（S16）：只服务现译渠道那一路 ---- */
  // ★ 抓取那一路（登记表上那几档源）**没有**换到这条路上，它照旧直接用全局 fetch：
  //   2026-10-05 实测英文三档 CDN 直连 1.27s 就通，2026-10-07 换源后 CN 两档直连也各 <1s；给一条已对上账的路换传输层等于凭空多一种失败形状。
  //   换的唯一理由是「免费接口」那一档直连实测 fetch failed @10.8s、经代理 200/932ms（§9.1r）。
  const net = createNetTransport({ getPrefs: () => prefsView, logger: ctx.logger });

  /* ---- 4.5 现译服务（S8）：句柄只在这一个模块里，装配层只递偏好视图与回调 ---- */
  const translate = createTranslateService({
    ctx,
    stores,
    // 现取现算：换渠道/开关之后不需要重建服务（prefs 落库那条路已经把 prefsView 换了）。
    getPrefs: () => prefsView,
    logger: ctx.logger,
    // 渠道那几发从这里出去（直连/隧道由 net 按 prefs 现算），状态行念的也是 net 那一份路由。
    fetchImpl: net.fetch,
    getTransport: () => net.describe(),
    // 译文落了库 ⇒ 读侧那份 src→中文 的映射作废，并推一帧让界面把行里的中文补上。
    // ★ 这里不调 engine.invalidate()：条目一条没变，重建索引等于为一句译文重读 2019 行。
    onWritten: () => {
      engine.invalidateZh();
      pushUpdate();
    },
  });

  /* ---- 5. 定时器：每轮跑完按那一轮的节拍自重挂 ---- */
  let timerHandle = null;
  function stopTimer() {
    if (timerHandle === null) return;
    try {
      // 宿主 ctx.timer.interval 返回的是 disposer 函数：对它调 clearInterval 是静默 no-op ⇒ 定时器叠加
      if (typeof timerHandle === 'function') timerHandle();
      else clearInterval(timerHandle);
    } catch { /* 清不掉也只可能是已经清了 */ }
    timerHandle = null;
    timerBackend = 'none';
  }

  let lastResult = null;
  let ticking = false;
  function reschedule() {
    stopTimer();
    const ms = currentDelayMs();
    const tick = () => { void onTimerTick(); };
    if (typeof intervalFn === 'function') {
      timerHandle = intervalFn(tick, ms);
      timerBackend = 'ctx.timer';
    } else {
      timerHandle = setInterval(tick, ms);
      if (typeof timerHandle.unref === 'function') timerHandle.unref();
      timerBackend = 'setInterval';
    }
  }

  async function runOnce(trigger) {
    if (ticking) {
      // 上一轮还没结束（手动触发与定时器撞车）。这里**不等它，也不并发第二轮**：
      // sync.run() 在这一支返回 rejected promise，接住并 warn 就完事（同步 throw 会从定时器回调逃逸）。
      const why = SYNC_BUSY.message;
      ctx.logger?.warn?.(`[api-catalog] ${trigger} 触发被跳过：${why}`);
      return { ok: false, status: 'failure', code: SYNC_BUSY.code, reason: why, skipped: true };
    }
    ticking = true;
    try {
      const result = await sync.run();
      lastResult = { trigger, at: Date.now(), ...result };
      // 失败那一轮也要推：meta.lastStatus/lastError 变了，界面上"现在到底好不好"就靠这一帧。
      pushUpdate();
      if (typeof result.nextDelayMs === 'number') nextDelay = result.nextDelayMs;
      if (!result.ok) ctx.logger?.warn?.(`[api-catalog] ${trigger} 同步没成（${result.code}）：${result.reason}`);
      // 库里的档位才算数：一轮的耗时以分钟计，视图不刷的话，之后每一拍都按装配时那份默认值走。
      // 节拍本身仍用这一轮自己算出的 nextDelayMs（那一轮读的就是库里的当前档），
      // 轮次进行中改偏好是 S3 的 POST 路径的责任 —— 它落库后会立刻 reschedule。
      await reloadPrefs();
      // 增量现译（S9 的挂点）：只在**这一轮真把库读回来了**之后跑，而且不挡节拍。
      // ★ 不 await：一轮最多 40 发、每发 12 s 上限，等它等于把同步间隔拖成分钟级，
      //   而 reschedule 要看的是"上一轮同步"的耗时。跑完的那几行由 onWritten 推帧，界面自己补中文。
      //   开关没开/渠道没备好时 runPass 在第一层就收口，连 entries 都不读（代价≈0）。
      if (result.ok) {
        void translate.runPass({ reason: 'after-sync' }).catch((e) => {
          ctx.logger?.warn?.(`[api-catalog] 现译这一轮没跑成：${e?.message ?? e}`);
        });
      }
      return result;
    } catch (e) {
      // 只剩 SYNC_BUSY 会走到这里（round 的其它分支都返回结构化结果）。
      ctx.logger?.warn?.(`[api-catalog] ${trigger} 同步被拒：${e?.message ?? e}`);
      lastResult = { trigger, at: Date.now(), ok: false, status: 'failure', code: e?.code ?? 'unknown', reason: String(e?.message ?? e) };
      return lastResult;
    } finally {
      ticking = false;
    }
  }

  async function onTimerTick() {
    await runOnce('timer');
    // 节拍随退避变，所以每轮重挂；重挂必须在跑完之后（跑之前重挂等于把这一轮的时长也排进去）
    reschedule();
  }

  /* ---- 5.5 路由与推流：界面是读侧，同步是写侧，两边只在 stores 上会合 ---- */
  const api = createApiHandler({
    engine,
    stores,
    caps,
    logger: ctx.logger,
    trigger: runOnce,
    lastSync: () => lastResult,
    // 现译的快照那一块与四条 POST 路由都走这份服务（lib/api.js 里唯一的使用者）。
    translate,
    // 偏好落库后立刻按新档位重挂：等下一轮再读库的话，这一拍的间隔还是旧档（§1 那条口径）。
    onPrefsSaved: (saved) => {
      prefsView = saved;
      nextDelay = null;
      // 代理那两格改了 ⇒ 注册表那份缓存作废：不然改了地址还要等一分钟才生效，
      // 而设置页那句「这一发实际走：…」会拿着旧路由说话。
      net.invalidate();
      try {
        reschedule();
      } catch (e) {
        ctx.logger?.warn?.(`[api-catalog] 改偏好后重挂节拍失败：${e?.message ?? e}`);
      }
    },
  });

  function pushUpdate() {
    // 没人在看就不读库：一轮同步已经够忙了，为一条断掉的连接再摊一份 2019 条的快照不值。
    if (!api.hub.size) return;
    Promise.resolve(api.pushUpdate()).catch((e) => ctx.logger?.warn?.(`[api-catalog] 推流没送出去：${e?.message ?? e}`));
  }

  /* ---- 6. 生命周期收口：先停定时器，后关存储句柄 ---- */
  let startupTimer = null;
  let routeDisposer = null;
  function teardown() {
    if (startupTimer !== null) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    stopTimer();
    try {
      api.dispose();   // 长连接要先关：心跳定时器留着就是一个没人接的 write
    } catch (e) {
      ctx.logger?.warn?.(`[api-catalog] 关闭推流失败：${e?.message ?? e}`);
    }
    if (typeof routeDisposer === 'function') {
      try {
        routeDisposer();
      } catch (e) {
        ctx.logger?.warn?.(`[api-catalog] 撤销路由失败：${e?.message ?? e}`);
      }
    }
    routeDisposer = null;
    // 现译服务先 dispose：它手里那份句柄在 teardown 之后不该再有第二发出去（长尾请求会撞已关的域）。
    try {
      translate.dispose();
    } catch (e) {
      ctx.logger?.warn?.(`[api-catalog] 关闭现译服务失败：${e?.message ?? e}`);
    }
    for (const store of [stores.entries, stores.meta, stores.notes, stores.prefs, stores.changes, stores.trans, stores.secrets]) {
      Promise.resolve(store.close?.()).catch((e) => ctx.logger?.warn?.(`[api-catalog] 关闭存储句柄失败：${e?.message ?? e}`));
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => teardown, 'api-catalog:lifecycle');

  lastRuntime = {
    caps,
    stores,
    sync,
    engine,
    api,
    translate,
    teardown,
    timerBackend: () => timerBackend,
    nextDelayMs: () => currentDelayMs(),
    busy: () => sync.busy || ticking,
    lastResult: () => lastResult,
    prefsView: () => ({ ...prefsView }),
    runOnce,
  };

  /* ---- 7. 首轮不抢跑：等注入回调把设施填好 ---- */
  if (resolved.autoSyncOnStart) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void runOnce('startup').then(() => reschedule());
    }, resolved.firstSyncDelayMs);
    if (typeof startupTimer.unref === 'function') startupTimer.unref();
  }

  ctx.inject(['storageDomain'], (s) => {
    storageFacility = s.storageDomain;
    syncCaps();
    void reloadPrefs().then(() => {
      nextDelay = null;   // 库里的档位才算数，之前那份只是配置默认值
      reschedule();
    });
  });

  ctx.inject(['timer'], (t) => {
    if (t.timer && typeof t.timer.interval === 'function') intervalFn = (fn, ms) => t.timer.interval(fn, ms);
    syncCaps();
    try {
      reschedule();   // 宿主定时器就绪后重挂，能力位与实际后端不再自相矛盾
    } catch (e) {
      ctx.logger?.warn?.(`[api-catalog] 宿主定时器就绪后重挂节拍失败：${e?.message ?? e}`);
    }
  });

  ctx.inject(['webServer'], (w) => {
    webServer = w.webServer;
    syncCaps();
    if (!webServer || typeof webServer.register !== 'function') return;
    const register = () => {
      const disposer = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: api });
      return typeof disposer === 'function' ? disposer : () => {};
    };
    // 挂到注入域的 effect 上：宿主撤销那一域时路由跟着撤。有 effect 就不自己留撤销器 ——
    // 两处都撤同一发就是重复释放（宿主的 disposer 不保证幂等）。
    try {
      if (typeof w.effect === 'function') w.effect(register, 'api-catalog:route');
      else routeDisposer = register();
    } catch (e) {
      ctx.logger?.warn?.(`[api-catalog] 路由注册失败：${e?.message ?? e}`);
    }
  });

  /**
   * 入口载荷：浏览器半边读的全在这里，所以**枚举与文案只推不复制**（spec §0 一份真相）。
   * ★ 只有 webServer 到位才推：没有路由就没有接口，推一个点开后全是 404 的面板比看不到入口更糟。
   */
  ctx.on('webserver/index-inject', (table) => {
    if (!webServer || !table || typeof table.push !== 'function') return;
    syncCaps();
    table.push({
      kind: 'global',
      name: GLOBAL_KEY,
      value: {
        panelId: resolved.panelId,
        label: resolved.label,
        panelOrder: resolved.panelOrder,
        routePrefix: ROUTE_PREFIX,
        api: `${ROUTE_PREFIX}/api`,
        capabilities: caps.read(),
        // ★ 载荷只放浏览器半边真读的键：hc-18 拿 client.js 的 cfg().X 读取点双向对过。
        //   AUTH_OPTIONS / YESNO_OPTIONS / SEARCH_*_LIMIT 是宿主侧的落库与截断口径，界面那几枚芯片跟的是快照里的 facet。
        //   capabilityRows（能力位展示行）与 keepChanges / builtAt 2026-10-06 一起撤了：它们唯一的读者是
        //   变更页那张「解析台账」，卡撤了还留着推 = hc-18 那一发的「推了没人读」。
        authLabels: AUTH_LABELS,
        httpsLabels: HTTPS_LABELS,
        corsLabels: CORS_LABELS,
        presets: PRESETS,
        checkIntervals: CHECK_INTERVALS,
        intervalLabels: CHECK_INTERVAL_LABELS,
        sources: SOURCES.map((s) => ({ id: s.id, label: s.label, note: s.note })),
        sourceRejected: SOURCE_REJECTED.map((s) => ({ id: s.id, reason: s.reason })),
        defaults: { ...DEFAULT_PREFS },
        changeKindLabels: CHANGE_KIND_LABELS,
        // 筛选芯片那几枚的种类（比 kinds 少一条 'round'：本轮摘要能读能画，但不做成筛选项）。
        // ★ 判据在域里，浏览器半边不许自己数：客户端一旦硬编码这五个，加一种流水就漏一枚芯片。
        changeKindChips: CHANGE_FILTER_KINDS,
        syncStatusLabels: SYNC_STATUS_LABELS,
        notePurposeMaxLen: NOTE_PURPOSE_MAX_LEN,
        tagMaxLen: TAG_MAX_LEN,
        tagMaxCount: TAG_MAX_COUNT,
        parseNote: PARSE_NOTE,
        syncBusyCode: SYNC_BUSY.code,
        // 现译设置卡要的全套（S8）：**只有登记表与话术，一个凭据值都不在这里**。
        // 渠道表原样推：它的每一格（label/needsKey/implemented/quota/note）界面都要显示；
        // 2026-10-06 裁定三家必须接入后五档全是 implemented:true，`implemented` 这支留给以后"只登记名、签名没接"的档。
        transChannels: TRANS_CHANNELS,
        transCredFields: TRANS_CRED_FIELDS,
        transErrorLabels: TRANS_ERROR_LABELS,
        transSettingsNote: TRANS_SETTINGS_NOTE,
        secretSavedHint: SECRET_SAVED_HINT,
        transCredBoundary: TRANS_CRED_BOUNDARY,
        transCooldownNote: TRANS_COOLDOWN_NOTE,
        transMaxPerRound: TRANS_MAX_PER_ROUND,
        // 现译出网代理那一行（S16）。★ 五把键 hc-18 都要在 client.js 找得到读者：三档芯片、每档那句提示、
        // 地址那一格的长度闸门、以及"为什么不收带密码的地址"那句边界话术。
        proxyModes: PROXY_MODES,
        proxyModeLabels: PROXY_MODE_LABELS,
        proxyModeHints: PROXY_MODE_HINTS,
        proxyUrlMax: PROXY_URL_MAX,
        proxyUrlBoundary: PROXY_URL_BOUNDARY,
        // 内置表有多少句随发版变（回填过一次就不该在源码里手写 1965），界面那一句「内置 N 句」读这里。
        builtinTransCount: DESC_ZH_COUNT,
      },
    });
  });

  return teardown;
}
