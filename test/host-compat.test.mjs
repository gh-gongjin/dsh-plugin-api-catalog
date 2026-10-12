/**
 * test/host-compat.test.mjs —— 挂载契约与铁律的源码级判据（口径继承 sysops / modelwatch / gh-trending）。
 *
 * 这一套件不发网络请求，也不碰本机 profile：
 *  · link: 挂载下宿主与插件会解析出两份模块实例 ⇒ 宿主半边零 @deepseek-ai import；
 *  · 宿主没打包机制 ⇒ 零第三方依赖，出网只用全局 fetch；
 *  · 对上游（GitHub 那一路）全程只读 GET，且绝不发 cookie / authorization / key；
 *  · 变化只落面板：不碰 ctx.schedule / ctx.jobs，也不推通知；
 *  · ★ 2026-10-06 改判（S8，用户裁定「允许」）：模型句柄从「零调用」改成「**默认零调用**」——
 *    唯一的消费者是 lib/translate.js 这一个文件，开关出厂是 false；hc-9 钉的是这条边界，不是旧的绝对禁令。
 *
 * ★ S4 之后本套件也管浏览器半边与宿主的**接缝**（hc-18~20：载荷键与 cfg() 读取点双向对齐、全局键字面量逐字一致、
 *   CSS 模板串里不打反引号 / 不打 ${）。界面本身的判据在 client.test.mjs；100vh 与"浮层只许一处"那两条是 cl-36 的活，别在这里重复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { check, runAll, assert, makeFakeFacility, makeFakeCtx, makeFakeTimer, makeFakeWebServer, makeReq, makeRes, flush } from './_helpers.mjs';
import { apply, DEFAULT_CONFIG, __peek, name as PLUGIN_NAME, inject as HARD_INJECT } from '../index.js';
import {
  DOMAIN_NAME, ROUTE_PREFIX, GLOBAL_KEY, SOURCES, SOURCE_REJECTED, DEFAULT_PREFS, CHECK_INTERVALS,
  CHECK_INTERVAL_LABELS, AUTH_LABELS, AUTH_VALUES, YESNO_VALUES, HTTPS_LABELS, CORS_LABELS,
  PRESETS, PRESET_NO_KEY, PRESET_BROWSER_DIRECT, CHANGE_ROW_KINDS, CHANGE_KIND_LABELS, CHANGE_FILTER_KINDS,
  SYNC_RESULT_KINDS, SYNC_STATUS_LABELS, SYNC_BUSY, NOTE_PURPOSE_MAX_LEN, TAG_MAX_LEN, TAG_MAX_COUNT,
  PARSE_NOTE, DOMAIN_LAYOUT, RECORD_KEY_RE,
  TRANS_CHANNELS, TRANS_CRED_FIELDS, TRANS_HOSTS, PROXY_MODES,
} from '../lib/domain.js';
import { DESC_ZH_COUNT } from '../lib/desc-zh.js';
import { API_ROUTES } from '../lib/api.js';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
/**
 * 宿主半边的文件清单：从 lib/ 目录派生，不手抄。
 * ★ 手抄那份（原来的 12 个文件名）在 S8 就悄悄过期了：lib/translate.js 与 lib/desc-zh.js 是新加的，
 *   清单没跟上 ⇒ hc-1/hc-2 这两条"零第三方依赖"的判据对新写的出网文件一个字都没看，
 *   而它绿着 —— 这正是「清单变旧却仍在报绿」的那一类假绿。
 * client.js 不在这里：它是浏览器半边，判据在 client.test.mjs 与 hc-18~20。
 */
const HOST_FILES = [
  'index.js',
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).sort().map((f) => `lib/${f}`),
];
// 派生出来的清单必须真覆盖到关键文件，否则"从目录派生"只是把漏扫换了个地方
for (const must of ['index.js', 'lib/fetch.js', 'lib/api.js', 'lib/stores.js', 'lib/translate.js', 'lib/desc-zh.js']) {
  if (!HOST_FILES.includes(must)) throw new Error(`宿主半边扫描清单派生后少了 ${must}（lib/ 目录读歪了）`);
}
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 去注释后的源码（判据扫的是语句位，不是文档位：整行注释与块注释都剔掉）。 */
const codeOf = (rel) => readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ------------------------------------------------------------------ *
 * A. 依赖与命名
 * ------------------------------------------------------------------ */

check('hc-1 宿主半边零 @deepseek-ai import（link: 挂载会解析出第二份实例）', () => {
  const importRe = /^[ \t]*(?:import|export)[^\n]*?from\s+['"]@deepseek-ai/m;
  const reqRe = /^[ \t]*require\(\s*['"]@deepseek-ai/m;
  for (const f of HOST_FILES) {
    const src = codeOf(f);
    assert.ok(!importRe.test(src) && !reqRe.test(src), `${f} 里出现了对 @deepseek-ai/* 的 import/require`);
  }
});

check('hc-2 宿主半边 import 只允许相对路径与 node: 内置（零第三方依赖）', () => {
  const re = /from\s+['"]([^'"]+)['"]/g;
  for (const f of HOST_FILES) {
    let m;
    while ((m = re.exec(codeOf(f)))) {
      const spec = m[1];
      assert.ok(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:'),
        `${f} 引了第三方：${spec}`);
    }
    assert.ok(!/\brequire\s*\(\s*['"](?!\.)/.test(codeOf(f)), `${f} 里出现了非相对路径的 require`);
  }
});

check('hc-3 package.json：零依赖，导出面与 bundle 声明齐（client.js 还没写 ⇒ 先钉声明别写错）', () => {
  const pkg = JSON.parse(readSrc('package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.devDependencies, undefined, '跑测只用 node 内置，引 dev 依赖就等于给宿主加一份要解析的实例');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'].default, './client.js');
  assert.equal(pkg.dsh.bundle.patch, 'cordis.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.main, 'index.js');
  // files 里列了 client.js：这条是提醒 S4 别把它删了蒙混过去（宿主按 exports 取，缺文件就是加载失败）
  assert.ok(pkg.files.includes('client.js'), 'package.json 的 files 里必须有 client.js');
});

check('hc-4 cordis.yml 的 id/name 与插件导出名一致', () => {
  const yml = readSrc('cordis.yml');
  assert.match(yml, new RegExp(`id: ${PLUGIN_NAME}\\b`));
  assert.match(yml, /name: dsh-plugin-api-catalog/);
});

check('hc-5 域名与三个约定字符串：形状与取值都对得上宿主的闸门', () => {
  assert.equal(ROUTE_PREFIX, '/api-catalog');
  assert.equal(GLOBAL_KEY, '__API_CATALOG__');
  assert.equal(DOMAIN_NAME, 'api_catalog');
  assert.match(DOMAIN_NAME, /^[a-z][a-z0-9_]*$/, '域名必须过宿主的 ^[a-z][a-z0-9_]*$（连字符当场被拒）');
  assert.match(ROUTE_PREFIX, /^\/[a-z0-9-]+$/, '前缀要能直接拼进 URL，别带需要转义的东西');
  assert.equal(DOMAIN_LAYOUT, 'per-record', 'single 布局下一轮同步会把整域重写 51 遍（spec §9.1b）');
  assert.ok(RECORD_KEY_RE.test('api_catalog'), '键闸门本身要能吃下这里用到的字面量');
});

check('hc-6 零硬 inject：export const inject = []（缺任一服务都不许卡死加载）', () => {
  assert.deepEqual(Array.from(HARD_INJECT), []);
});

/* ------------------------------------------------------------------ *
 * B. 只读 GET 与"不推通知"
 * ------------------------------------------------------------------ */

check('hc-7 只读 GET 铁律：出网那一发写死 GET，不带任何凭据', () => {
  const src = codeOf('lib/fetch.js');
  assert.match(src, /method: 'GET'/, '出网必须显式写 GET');
  assert.ok(!/method:\s*['"]?(POST|PUT|DELETE|PATCH)/i.test(src), '对上游不许有任何写方法');
  for (const banned of ['cookie', 'authorization', 'token', 'client_secret', 'access_key', 'apikey:']) {
    assert.ok(!new RegExp(`['"\\[\\s]${banned}`, 'i').test(src), `lib/fetch.js 里出现了 ${banned}（本插件匿名只读，不带凭据）`);
  }
  assert.ok(!/\bzip\b|git clone|codeload|archive\//.test(src), '不下载 zip、不 clone');
  assert.ok(!/child_process|spawn\w*\(|execSync|execFile/.test(src), '不起子进程');
  assert.ok(!/require\(\s*['"]undici/.test(src), 'undici 从插件 require 不到（spec §9.1），别写"代理可由插件设置"这种假话');
});

check('hc-8 带 scheme 的地址只留在 domain 的源表里：抓取与读侧一处都不许硬写', () => {
  const src = codeOf('lib/fetch.js');
  assert.match(src, /import \{[\s\S]*?SOURCES[\s\S]*?\} from '\.\/domain\.js'/);
  // parse.js 里那三处 https:// 是解析用的形状闸门（补协议 / 去尾斜杠），不在被查的这几个文件里
  // 抓取的假基地 `http://127.0.0.1`（api.js 里 new URL 的第二参）不算出网地址，除此之外不许出现任何主机名
  const addrRe = /https?:\/\/(?!127\.0\.0\.1|localhost)[^'"`\s]+/;
  for (const f of ['index.js', 'lib/fetch.js', 'lib/sync.js', 'lib/api.js', 'lib/query.js']) {
    assert.equal(addrRe.test(codeOf(f)), false, `${f} 里硬写了非本机地址：改源该只改 domain 一处`);
  }
  for (const s of SOURCES) assert.ok(s.url.startsWith('https://'), `${s.id} 不是 https`);
  // 被明确拒掉的源不许被任何文件当抓取入参用回去（逐文件判：拼在一起判会让 [^)]* 跨过文件边界）
  for (const r of SOURCE_REJECTED) {
    for (const f of ['index.js', 'lib/fetch.js', 'lib/sync.js']) {
      assert.ok(!codeOf(f).includes(r.url.split('/master/')[0].replace('https://', '')), `${f} 里出现了 ${r.id} 的主机名`);
    }
    assert.ok(!SOURCES.some((s) => s.id === r.id), `${r.id} 又回到了候选源表`);
  }
});

check('hc-9 变化只落面板 + 模型句柄只有一个消费者：宿主半边不碰 schedule / jobs / notify / session', () => {
  // 词边界是必须的：装配层自己就有一个叫 reschedule 的函数，不带边界等于天天误报。
  const banned = [/\bschedule\s*\(/, /ctx\.schedule/, /ctx\.jobs/, /\bnotify\w*\(/, /sessionLog/];
  for (const f of HOST_FILES) {
    const src = codeOf(f);
    for (const re of banned) {
      assert.equal(re.test(src), false, `${f} 里出现了 ${re}（裁定 ③：变化只落面板，不推任何通知）`);
    }
  }
});

check('hc-9b 模型句柄的唯一入口是 lib/translate.js：别处一次都不许取（S8 改判「默认零调用」）', () => {
  // 2026-10-06 用户裁定「允许」用宿主模型做现译，换来的是这条更窄的边界：
  //  · 只有 lib/translate.js 能 inject 模型服务（真调与不调的用例在 test/translate.test.mjs，出厂开关是 false）；
  //  · 装配层 index.js 只把 ctx 递给那个工厂，自己不碰句柄，也不写第二处 inject；
  //  · 任何别处出现 llm / agentDefaultModel 的取值点，这一条就当红：多一处消费者就多一处能烧 token 的地方。
  const ONLY = 'lib/translate.js';
  const takeRe = /ctx\.inject\(\s*\[[^\]]*['"](llm|agentDefaultModel)['"]/;
  const useRe = /\bllm\s*\(|\bagentDefaultModel\b|\.llm\b/;
  let takers = 0;
  for (const f of HOST_FILES) {
    const src = codeOf(f);
    const takes = (src.match(new RegExp(takeRe, 'g')) || []).length;
    takers += takes;
    if (f === ONLY) {
      assert.equal(takes, 1, `${ONLY} 里取模型句柄的调用点应当只有一条，多了就是另开一路`);
      continue;
    }
    assert.equal(takes, 0, `${f} 里也 inject 了模型服务：现译的闸门就散了两处`);
    assert.equal(useRe.test(src), false, `${f} 里出现了模型句柄的取值点（改判后只许 ${ONLY} 一处）`);
  }
  assert.equal(takers, 1, '整个宿主半边应当只有一处 inject 模型服务，实测 ' + takers + ' 处');
  // 装配层的现译只经这一个工厂：留一条判据保证 index.js 没有绕过它直接发
  assert.match(codeOf('index.js'), /createTranslateService\s*\(/);
  assert.ok(!/\.stream\s*\(\s*\{/.test(codeOf('index.js')), 'index.js 里不该有第二处 stream 调用点');
});

check('hc-9c 现译出网的闸门与形状（2026-10-06 三家接入后的新口径）：域名仍是封闭集合，写方法只许厂商要的那两档', () => {
  const src = codeOf('lib/translate.js');
  const flat = src.replace(/\s+/g, ' ');
  assert.ok(/TRANS_HOSTS\.includes/.test(src), '现译那一发没有域名白名单闸门：渠道一改就能往任意主机发凭据');
  // ★ 闸门在 httpCall **内部第一行**，不在调用方：新渠道忘了带闸门就等于给白名单开后门。
  assert.ok(/async function httpCall\(\{ [\s\S]{0,220}?TRANS_HOSTS\.includes/.test(flat),
    '域名闸门挪回调用方了：加一档就可能漏一档，闸门得长在最窄的那道口上');
  // 目录抓取那一路的「全程只读 GET」红线**没有**放宽；放宽的只有渠道侧，而且只到官方形状要求的 POST：
  assert.equal((src.match(/method: 'POST'/g) || []).length, 2,
    'POST 该只有腾讯 TMT 与讯飞机器翻译（新）两处（它们官方就吃 POST），实测不是 2 处');
  assert.ok(/method: 'GET'/.test(src), '百度与阿里两档仍是 GET');
  assert.ok(!/method:\s*['"]?(PUT|DELETE|PATCH)/i.test(src), '翻译侧出现 PUT/DELETE/PATCH：那不是厂商形状，是越界');
  // 密钥不泄漏那一条是**行为**判据（拿录下来的 URL/头/正文/peek/日志逐样自证），住在 test/translate.test.mjs；
  // 这里只钉结构，别在两个文件里各数一遍。
  for (const host of ['translate.fanyi', 'api.deepseek', 'openai']) {
    assert.ok(!codeOf('lib/fetch.js').includes(host), `lib/fetch.js（抓取那一路）里出现了 ${host}：抓取与出网到第三方是两件事`);
  }
  // 白名单是从登记表派生的，不是这里手抄的（加一台就得改一处 = 早晚会漏那一处）
  assert.match(codeOf('lib/domain.js'), /TRANS_HOSTS\s*=/);
  assert.ok(/TRANS_HOSTS\s*=[\s\S]{0,200}TRANS_ENDPOINTS/.test(codeOf('lib/domain.js').replace(/\s+/g, ' '))
    || /Object\.values\(TRANS_ENDPOINTS\)/.test(codeOf('lib/domain.js')),
  'TRANS_HOSTS 不是从 TRANS_ENDPOINTS 派生的：端点改了而白名单没跟上，闸门就形同虚设');
});

/* ------------------------------------------------------------------ *
 * C. 装配出来的路由
 * ------------------------------------------------------------------ */

function mount(opts = {}) {
  const f = opts.facility ?? makeFakeFacility();
  const ws = makeFakeWebServer();
  const ctx = makeFakeCtx({ facility: f, timer: makeFakeTimer(), webServer: ws });
  const teardown = apply(ctx, { autoSyncOnStart: false, ...opts.config });
  return { f, ws, ctx, teardown };
}

check('hc-10 路由是宿主那一种：一条 prefix，handler 就是 api.js 那一个，能直接答 snapshot', async () => {
  const { ws, teardown } = mount();
  assert.equal(ws.openCount(), 1);
  const handler = ws.handlerFor(ROUTE_PREFIX);
  assert.equal(handler, __peek('api'));
  const req = makeReq({ url: `${ROUTE_PREFIX}/api/snapshot` });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().data.index.total, 0, '空库也是 200：界面靠 capabilities 说话，不靠有没有行');
  teardown();
});

check('hc-11 路由表拼上前缀就是客户端要打的地址：一一对得上，没有孤儿', () => {
  for (const key of Object.keys(API_ROUTES)) {
    const [method, sub] = key.split(' ');
    assert.ok(sub.startsWith('/api/'), `${key} 不在 /api 子树里，客户端的 api 基址拼不出它`);
    const url = new URL(`http://127.0.0.1${ROUTE_PREFIX}${sub}`);
    assert.equal(url.pathname, `${ROUTE_PREFIX}${sub}`);
    assert.ok(method === 'GET' || method === 'POST', `${key} 用了这两种之外的方法，宿主那边只按 (req,res) 派发`);
  }
  assert.ok(API_ROUTES['GET /api/stream'], '客户端要订阅，没有这一条就只能轮询');
  assert.ok(Object.keys(API_ROUTES).some((k) => k === 'POST /api/sync'), '手动跑一轮的口子必须在');
});

/* ------------------------------------------------------------------ *
 * D. 入口载荷（浏览器半边唯一的取数口）
 * ------------------------------------------------------------------ */

const PAYLOAD_KEYS = ['panelId', 'label', 'panelOrder', 'routePrefix', 'api', 'capabilities',
  'authLabels', 'httpsLabels', 'corsLabels', 'presets',
  'checkIntervals', 'intervalLabels', 'sources', 'sourceRejected', 'defaults',
  'changeKindLabels', 'changeKindChips', 'syncStatusLabels', 'notePurposeMaxLen', 'tagMaxLen', 'tagMaxCount',
  'parseNote', 'syncBusyCode',
  // ★ S8：设置页「中文说明」那一卡的取数口。hc-18 会反过来查这些键有没有读者 —— 推了没人读就是这一条红。
  'transChannels', 'transCredFields', 'transErrorLabels', 'transSettingsNote',
  'secretSavedHint', 'transCredBoundary', 'transCooldownNote', 'transMaxPerRound', 'builtinTransCount',
  // ★ S16：设置页「现译出网」那一行的取数口（三档 + 每档条件 + 长度闸门 + 不收密码那句边界话术）。
  'proxyModes', 'proxyModeLabels', 'proxyModeHints', 'proxyUrlMax', 'proxyUrlBoundary'];

function pushPayload({ webServer = makeFakeWebServer(), config = {} } = {}) {
  const ctx = makeFakeCtx({ facility: makeFakeFacility(), timer: makeFakeTimer(), webServer });
  const teardown = apply(ctx, { autoSyncOnStart: false, ...config });
  const table = [];
  ctx.emit('webserver/index-inject', table);
  return { ctx, table, teardown };
}

check('hc-12 载荷键全集：手抄的清单与 index.js 推的那一份必须同集合', () => {
  const { table, teardown } = pushPayload();
  assert.equal(table.length, 1);
  assert.equal(table[0].kind, 'global');
  assert.equal(table[0].name, GLOBAL_KEY);
  const pushed = Object.keys(table[0].value);
  assert.deepEqual(pushed.slice().sort(), PAYLOAD_KEYS.slice().sort(),
    '载荷键变了：index.js 的推送与本清单要一起改（客户端读不到的键才是真事故）');
  teardown();
});

check('hc-13 载荷里的枚举与话术表同集合：界面显示 undefined 就是从这两张表对不上来的', () => {
  const { table, teardown } = pushPayload();
  const v = table[0].value;
  assert.deepEqual(Object.keys(v.authLabels).sort(), [...AUTH_VALUES].sort(), '落库枚举里的每一项都要有中文话术（含 unknown）');
  assert.deepEqual(Object.keys(v.httpsLabels).sort(), [...YESNO_VALUES].sort());
  assert.deepEqual(Object.keys(v.corsLabels).sort(), [...YESNO_VALUES].sort());
  assert.deepEqual(v.presets, PRESETS);
  assert.deepEqual(v.presets.map((p) => p.id), [PRESET_NO_KEY.id, PRESET_BROWSER_DIRECT.id]);
  for (const p of v.presets) assert.ok(p.hint && p.label, `${p.id} 的预设要把条件念出来，不许只显示一个名字`);
  assert.deepEqual(Object.keys(v.changeKindLabels).sort(), [...CHANGE_ROW_KINDS].sort(), '流水按 kind 过滤的芯片少一类就有一类行看不见');
  // ★ U-17：'round'（本轮摘要）进 labels（画得出）但不进芯片（不做成筛选项）。两头都断言：
  //   少发 changeKindChips ⇒ 客户端只能硬编码那五个；chips 里混进 round ⇒ 界面上多一枚没用的芯片。
  assert.deepEqual(v.changeKindChips, CHANGE_FILTER_KINDS, '芯片种类没从域里派生（客户端不许自己数）');
  assert.deepEqual([...CHANGE_FILTER_KINDS].sort(), [...CHANGE_ROW_KINDS].filter((k) => k !== 'round').sort());
  for (const k of v.changeKindChips) assert.ok(v.changeKindLabels[k], `芯片 ${k} 没有中文话术`);
  assert.deepEqual(Object.keys(v.syncStatusLabels).sort(), [...SYNC_RESULT_KINDS].sort());
  assert.deepEqual(v.checkIntervals, CHECK_INTERVALS);
  assert.deepEqual(Object.keys(v.intervalLabels).sort(), CHECK_INTERVALS.map(String).sort(), '每一档都得有话术，界面上不能出现裸的 720');
  // 代理三档（S16）：labels 与 hints 都必须**逐档齐**。少一句 hints 就是屏幕上少一行条件 ——
  // 而「跟随系统」这一档不念条件就会被读成"一定走代理"（同「常用API 条件写在屏幕上」那条律）。
  assert.deepEqual(Object.keys(v.proxyModeLabels).sort(), [...PROXY_MODES].sort(), '代理档位少一句中文，那一排就有一枚裸 id');
  assert.deepEqual(Object.keys(v.proxyModeHints).sort(), [...PROXY_MODES].sort(), '代理档位少一句条件');
  teardown();
});

check('hc-14 载荷里的源表与阈值：源的 note 只留界面要说的，凭据类字段一个都不带', () => {
  const { table, teardown } = pushPayload();
  const v = table[0].value;
  assert.deepEqual(v.sources, SOURCES.map((s) => ({ id: s.id, label: s.label, note: s.note })));
  assert.equal(v.sources.length, SOURCES.length);
  assert.ok(v.sources.every((s) => !('url' in s)), '客户端不需要 URL，就别把出网地址推到浏览器半边');
  assert.deepEqual(v.sourceRejected, SOURCE_REJECTED.map((s) => ({ id: s.id, reason: s.reason })));
  assert.deepEqual(v.defaults, DEFAULT_PREFS);
  // 代理两格的出厂值单独钉：地址非空等于替用户选了一台机器，模式不是 system 等于替他决定要不要跟系统走。
  assert.equal(v.defaults.proxyMode, 'system');
  assert.equal(v.defaults.proxyUrl, '', '出厂就带着一台代理机器：这一格必须是空的');
  assert.ok(String(v.proxyUrlBoundary).includes('user:pass@'),
    '那句「不收带密码的代理地址」得在载荷里：界面上不念它，用户就会往这格里粘一个带密码的串');
  assert.equal(v.api, `${ROUTE_PREFIX}/api`);
  assert.equal(v.routePrefix, ROUTE_PREFIX);
  assert.equal(v.panelOrder, DEFAULT_CONFIG.panelOrder, '排在 GitHub 热榜下方这一条是定过的，别漂');
  assert.equal(v.panelId, DEFAULT_CONFIG.panelId);
  assert.equal(v.notePurposeMaxLen, NOTE_PURPOSE_MAX_LEN);
  assert.equal(v.tagMaxLen, TAG_MAX_LEN);
  assert.equal(v.tagMaxCount, TAG_MAX_COUNT);
  assert.equal(v.parseNote, PARSE_NOTE);
  assert.equal(v.syncBusyCode, SYNC_BUSY.code, '409 那一支界面要按码识别，不能去猜中文');
  // ★ 2026-10-06 撤「解析台账」那张卡时一起撤掉的三个键（口径就是 hc-18：推了没人读就是红）。
  //   留着它们等于把一张已经不存在的卡养在载荷里，每装一次插件都摊一份没人读的数组。
  for (const dead of ['capabilityRows', 'keepChanges', 'builtAt']) {
    assert.equal(dead in v, false, `${dead} 又回到首屏载荷里了：浏览器半边没有读者`);
  }

  /* ---- S8：现译这一路的载荷同样不许带凭据，而且出厂必须是"关" ---- */
  assert.equal(v.defaults.transEnabled, false, '载荷把开关推成 true = 每次装插件都默认开始烧宿主模型');
  assert.equal(v.builtinTransCount, DESC_ZH_COUNT, '设置页那句「内置已备 N 句」数的就是这张表，别拿快照里的行数糊');
  assert.deepEqual(v.transChannels, TRANS_CHANNELS.map((c) => ({ ...c })));
  for (const c of v.transChannels) {
    assert.equal('value' in c, false, `${c.id} 的登记表里出现了 value`);
    assert.equal(typeof c.implemented, 'boolean', '这一格决定芯片点不点得动，载荷里就得说清楚，界面不许猜');
  }
  // 凭据字段推的是**清单**（id/label/max/secret + 可选的 optional/hint），不是值：逐字段核形状，多一个键就当红
  const specKeys = new Set(['id', 'label', 'max', 'secret', 'optional', 'hint']);
  const listed = [];
  assert.deepEqual(Object.keys(v.transCredFields), Object.keys(TRANS_CRED_FIELDS),
    '凭据字段的渠道清单与登记表不同集合同顺序：设置页会渲染出没登记的一栏，或漏掉一栏');
  for (const channel of Object.keys(v.transCredFields)) {
    const fields = v.transCredFields[channel];
    assert.deepEqual(fields, TRANS_CRED_FIELDS[channel].map((f) => ({ ...f })));
    for (const f of fields) {
      listed.push(`${channel}.${f.id}`);
      for (const k of Object.keys(f)) assert.ok(specKeys.has(k), `${channel}.${f.id} 的清单里多了键 ${k}（这一份是要进浏览器的）`);
    }
  }
  assert.equal(listed.length, Object.values(TRANS_CRED_FIELDS).reduce((n, fs) => n + fs.length, 0),
    '凭据清单少一栏 = 设置页少一个输入框，用户只会看到"未配置"却不知道缺什么');
  // 结构性的那一道：整个载荷序列化以后，不许出现任何"凭据键名 : 值"的形状
  const dumped = JSON.stringify(v);
  const credValueRe = /"(?:value|secret_key|access_key_secret|api_secret|client_secret|password)"\s*:\s*"[^"]+"/i;
  assert.equal(credValueRe.test(dumped), false, '入口载荷里出现了凭据值：这一份浏览器半边读得到，也回得去');
  for (const host of TRANS_HOSTS) {
    assert.equal(dumped.includes(host), false,
      `入口载荷里出现了出网域名 ${host}：打哪一台是宿主半边的事，note 里要说明就写服务名，别把主机名抄进浏览器能读到的地方`);
  }
  teardown();
});

check('hc-15 profile 的 label / panelId 会进载荷：改了配置，界面与路由用的还是同一份', () => {
  const { table, teardown } = pushPayload({ config: { label: 'API 手册', panelId: 'api-manual' } });
  assert.equal(table[0].value.label, 'API 手册');
  assert.equal(table[0].value.panelId, 'api-manual');
  assert.equal(table[0].value.routePrefix, ROUTE_PREFIX, '前缀是插件自己钉的，改 panelId 不该把路由一起改掉');
  teardown();
});

check('hc-16 能力位如实进载荷：没 webServer 就一发起都不推，没存储就在载荷里说清', async () => {
  const ws = makeFakeWebServer();
  const ctx = makeFakeCtx({ facility: makeFakeFacility(), timer: makeFakeTimer() });
  const teardown = apply(ctx, { autoSyncOnStart: false });
  const t1 = [];
  ctx.emit('webserver/index-inject', t1);
  assert.equal(t1.length, 0, '没 webServer 就不推入口载荷（点开全是 404 的面板比看不到入口更糟）');
  teardown();

  const broken = { open: async () => { throw new Error('backend 拒绝了这份声明'); } };
  const ctx2 = makeFakeCtx({ facility: broken, timer: makeFakeTimer(), webServer: ws });
  const teardown2 = apply(ctx2, { autoSyncOnStart: false });
  await flush(20);
  const t2 = [];
  ctx2.emit('webserver/index-inject', t2);
  assert.equal(t2.length, 1, '存储坏了也要推：界面要能显示降级行，空白页更难诊断');
  assert.equal(t2[0].value.capabilities.storageDomain, false);
  // ★ 2026-10-06：载荷里那份**展示行**（capabilityRows）随「解析台账」那张卡一起撤了。
  //   降级这件事本身两条都还在：浏览器半边靠 capabilities 这一份布尔在页头说话（cl-7 / cl-35 钉），
  //   服务端给的原因改由宿主日志那一行带出去 —— 撤卡不许把原因也撤成没有读者。
  assert.equal('capabilityRows' in t2[0].value, false, '能力位展示行又回到载荷里：那张卡已经不在了');
  const warn = ctx2._internals.logs.warn.find((m) => m.includes('storageDomain'));
  assert.ok(warn, `存储缺位没在宿主日志里说出口：${ctx2._internals.logs.warn.join(' | ') || '(一条 warn 都没有)'}`);
  assert.ok(warn.includes('存储域 open 失败'), `日志里没带降级的原因：${warn}`);

  // 路由的撤销器由**注入域**持有（w.effect(register)），teardown 不再撤第二发：
  // 宿主的 prefix disposer 不保证幂等，两处都撤就是重复释放。
  const routeEffect = ctx2._internals.effects.find((e) => e.name === 'api-catalog:route');
  assert.equal(ws.openCount(), 1, 'effect 当场跑过才会有一条在架路由');
  teardown2();
  assert.equal(ws.openCount(), 1, '宿主撤销注入域之前，路由照常在架（这是设计，不是漏）');
  routeEffect.dispose();
  assert.equal(ws.openCount(), 0);
  assert.equal(ws.history[0].disposeCount, 1, `撤销器被调了 ${ws.history[0].disposeCount} 次`);
});

check('hc-17 真机：profile 的 link: 挂载与端口以本机 dsh 为准，本用例只声明口径不碰本机', () => {
  // 挂载 / 重启是用户确认后的动作（spec §9）；探针一律 GET-only。
  assert.ok(true);
});

/* ------------------------------------------------------------------ *
 * E. 接缝：宿主推的那一份 ↔ 浏览器半边读的那一份（S4 补的三条）
 * ------------------------------------------------------------------ */

check('hc-18 载荷键 ↔ cfg() 读取点双向对齐：推了没人读、读了没人推，都算这一条红', () => {
  const read = new Set([...codeOf('client.js').matchAll(/\bcfg\(\)\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
  assert.ok(read.size >= 20, `client.js 里只抓到 ${read.size} 个 cfg().X 读取点：写法变了，这条判据的靶子也要跟着改`);
  const { table, teardown } = pushPayload();
  const pushed = new Set(Object.keys(table[0].value));
  teardown();
  assert.deepEqual([...read].filter((k) => !pushed.has(k)), [], '客户端读的键载荷里没有：真机上就是 undefined 画进界面');
  assert.deepEqual([...pushed].filter((k) => !read.has(k)), [], '载荷推了客户端从不读的键：宿主侧口径别顺手塞进浏览器半边');
});

check('hc-19 全局键字面量两边逐字一致，且浏览器半边零 import（它靠 require 拿 react）', () => {
  const src = codeOf('client.js');
  const m = src.match(/const GLOBAL_KEY = '([^']+)'/);
  assert.ok(m, 'client.js 里找不到 GLOBAL_KEY 字面量：换写法了就把这条一起改');
  assert.equal(m[1], GLOBAL_KEY, '差一个字符 ⇒ 客户端永远读不到入口载荷，面板只会说「宿主还没推进来」');
  assert.equal(/^\s*import\s/m.test(src), false, '浏览器半边有任何 import 都装不进宿主的 bundle：依赖只许 require(\'react\')');
});

check('hc-20 CSS 是一整段模板串：块内不打反引号、不打 ${，否则样式会断或漏一块', () => {
  const src = readSrc('client.js');
  const at = src.indexOf('const CSS = `');
  assert.ok(at > 0, '找不到 CSS 模板串的锚点（这条判据不许悄悄永真）');
  // ★ 2026-10-05 重写取块的方式。**原来用 indexOf(反引号+分号) 找块尾** ——
  //   块内一旦有反引号，找到的就是那个反引号，块被截短，真凶落在取出来的 body 之外，
  //   下面那条断言反而报"通过"。实测两次（都是我在注释里写带反引号的示例代码）：
  //   hc-20 全绿，而 make-prototype 与整个 client 套件一起崩在 SyntaxError。
  //   这就是「量尺量到自己脚下」的第二例（第一例是 cl-37 把 CSS 注释里的类名当选择器）。
  //   改法：**逐字符扫到块尾再验形态** —— 从锚点之后找第一个反引号，
  //   再看它后面紧不紧跟分号：紧跟才是真块尾（body 取到它之前，安全），
  //   不紧跟就说明块内有提前出现的反引号，字符串在那里已经断了（当场报出来）。
  //   ⚠️ 扫描范围只限 CSS 块，**不能扫全文** —— 后半段普通 JS 里有合法模板串
  //   （fmtAgo 那几行），扫全文会误报。
  const START = 'const CSS = `'.length;
  const after = src.slice(at);
  const bodyEnd = after.indexOf('`', START);
  assert.ok(bodyEnd > 0, 'CSS 块没有收尾反引号：模板串没闭合');
  assert.equal(after[bodyEnd + 1] === ';', true,
    'CSS 块在偏移 ' + bodyEnd + ' 处就断了（反引号后面不是分号）：块内出现了提前的反引号'
    + '——注释里也不许写反引号示例，这轮已经因此连踩两次');
  const body = after.slice(START, bodyEnd);
  assert.equal(body.includes('`'), false, 'CSS 里打了反引号：模板串在这里断掉，整份 client.js 变成语法错误');
  assert.equal(body.includes('${'), false, 'CSS 里打了 ${：这一段会被当插值，注进 document 的样式就少一块');
  // 反引号也意味着这份文件在 vm 里根本装不上 —— 真装一次，别只信正则。
  assert.equal(canParse(src), true, 'client.js 语法不成立：多半是 CSS 模板串被反引号或插值截断了');
  assert.equal(/100vh/.test(body), false, '100vh 的判据在 cl-36，这里只兜一句：别从 CSS 侧绕回来');
  // ★ 2026-10-06 改判：原来这条连 position:fixed 一起兜（那时口径是"零浮层"）。
  //   现在浮层有一处是裁定要的东西（详情对话框），兜底也就跟着收窄成"只许遮罩那一发"。
  // ★ 先剥注释再扫：这一发当场被自己咬了一次 —— 说明遮罩口径的那段 CSS 注释里就写着 position:fixed，
  //   不剥注释的话注释会被当成一条规则（cl-36 那条同判据剥了，这条兜底没剥，两边口径要一致）。
  const cssOnly = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const fixedSel = [...cssOnly.matchAll(/([^{}]+)\{[^{}]*position\s*:\s*fixed[^{}]*\}/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  assert.deepEqual(fixedSel.filter((s) => s !== '.ac-modal-mask'), [],
    `fixed 从 CSS 侧绕回来了（${fixedSel.join(' | ') || '一发没有'}）：浮层的判据在 cl-36，只许详情遮罩一处`);
  assert.ok(fixedSel.length >= 1, '一条 fixed 规则都扫不到：遮罩那一发漂了，上面那条兜底正在空转');
});

/** 真编译一遍，不只信正则：new Function 只编译不执行，不会碰宿主侧。 */
function canParse(src) {
  try { new Function(src); return true; }
  catch (e) { return /SyntaxError|Unexpected|Invalid or unexpected|missing/.test(String(e)) ? false : true; }
}

await runAll('host-compat');
