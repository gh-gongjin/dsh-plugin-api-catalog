/**
 * lib/domain.js —— 一份真相：源表、区段锚点、列枚举、阈值只在这一处定义。
 *
 * 浏览器半边不许复制任何判定或枚举；要显示「免 key」这类档位名，也必须读这里的表。
 *
 * 每条带「实测」的常量都对应 spec §9.1 的 S0 读数（2026-10-05 本机采）；
 * 没量过的写「待回看」，不许假装量过。
 *
 * ⚠️ 反引号禁令不在本文件，在 client.js：那边的 CSS 整段在模板字符串里，注释里再打反引号会当场
 *    截断字符串。本文件的模板字符串与注释里的反引号都无害，但**枚举与阈值不许被浏览器半边抄一份**。
 */

import {
  defineDomain, domainTable, record,
  requiredString, optionalString, requiredInt, optionalInt,
  requiredNumber, optionalNumber, requiredBool, optionalBool,
  requiredEnum, optionalEnum, arrayOfItem, arrayOf,
} from './kv-schema.js';
// ★ 内置表的句数从表本身取，不在话术里手写数字：回填过一次之后那句话就会指着旧的数（界面照念不误）。
import { DESC_ZH_COUNT } from './desc-zh.js';

/* ------------------------------------------------------------------ *
 * 抓取源（spec §2）
 * ------------------------------------------------------------------ */

/**
 * ★ 2026-10-07 换源裁定：目录源从 `public-apis/public-apis` 换成 `llf007/public-apis-cn`
 *   （「换成 public-apis-cn 吧」+「两源互为降级候选」）。两份都登记在案，英文那份不再叫「上游」，
 *   叫「降级源」—— 它只在中文源取不到时给一份还能跑的目录，代价是描述回英文、少 109 条国内 API。
 */
export const README_PATH = 'README.md';
export const REPO_CN = 'llf007/public-apis-cn';
export const REF_CN = 'main';
export const REPO_EN = 'public-apis/public-apis';
export const REF_EN = 'master';

/**
 * 候选源，按优先级排列（第一位是真源，后面全是降级）。耗时是 2026-10-07 本机实测，
 * 括号里注明走没走代理 —— 同一台机器同一个 CDN 节点这两条路的结果不一样，只记一条就是「把一次读数写成状态」：
 *   cn-jsdelivr 200 · 191468 B · 0.98 s（直连）；cn-github-api 200 · base64 264664 B · 0.89 s（直连）；
 *   jsdelivr 200 · 294203 B · 1.18 s（直连）；jsdelivr-cf 200 · 294203 B · 0.85 s（直连，5.6 s 走代理）；
 *   api.github 返回的是 {content: base64}，要 decode 才有正文（见 decode 位）。
 * 2026-10-05 那批读数（英文源 jsdelivr 291096 B · 1.27 s）留着不算数：同一份文件已经涨到 294203 B。
 */
export const SOURCES = [
  {
    id: 'cn-jsdelivr',
    label: 'public-apis-cn · jsDelivr',
    url: `https://cdn.jsdelivr.net/gh/${REPO_CN}@${REF_CN}/${README_PATH}`,
    decode: 'text',
    note: '真源。CDN 有缓存，main 的更新不是即时可见 ⇒ 界面只说「快照取自某时刻」，不说「实时」',
  },
  {
    id: 'cn-github-api',
    label: 'public-apis-cn · GitHub Contents API',
    url: `https://api.github.com/repos/${REPO_CN}/contents/${README_PATH}`,
    decode: 'base64',
    note: '匿名 60 请求/小时 ⇒ 只在 jsDelivr 拿不到时才碰',
  },
  {
    id: 'jsdelivr',
    label: 'public-apis（英文）· jsDelivr',
    url: `https://cdn.jsdelivr.net/gh/${REPO_EN}@${REF_EN}/${README_PATH}`,
    decode: 'text',
    note: '降级：中文源两档都不通时仍能给出一份目录，代价是描述回英文、少 109 条国内 API',
  },
  {
    id: 'jsdelivr-cf',
    label: 'public-apis（英文）· jsDelivr Cloudflare 节点',
    url: `https://testingcf.jsdelivr.net/gh/${REPO_EN}@${REF_EN}/${README_PATH}`,
    decode: 'text',
    note: '',
  },
  {
    id: 'github-api',
    label: 'public-apis（英文）· GitHub Contents API',
    url: `https://api.github.com/repos/${REPO_EN}/contents/${README_PATH}`,
    decode: 'base64',
    note: '匿名 60 请求/小时 ⇒ 排在最后',
  },
];

/**
 * 明确不用的源与理由（写下来是为了下次别又把它加回候选）。
 * 同一份 CN 正文在四个入口上的实测（2026-10-07，各发一发）：
 *   cdn.jsdelivr 200/0.98s · api.github 200/0.89s · testingcf 000（两次都是 Connection reset，经代理才 200/4.0s）
 *   · raw.githubusercontent 000/0.15s（经代理 200/3.2s）。
 */
export const SOURCE_REJECTED = [
  {
    id: 'raw-github',
    url: `https://raw.githubusercontent.com/${REPO_EN}/${REF_EN}/${README_PATH}`,
    reason: '本机无代理直连失败（2026-10-05 与 2026-10-07 两次都是 000）；配了代理也不如 CDN 稳',
  },
  {
    id: 'cn-jsdelivr-cf',
    url: `https://testingcf.jsdelivr.net/gh/${REPO_CN}@${REF_CN}/${README_PATH}`,
    reason: '直连两次 Connection reset，只有经代理才 200/4.0 s；而抓取面走宿主全局 fetch、不选路 ⇒ 放进候选链只会在无代理的机器上多报一次失败',
  },
  {
    id: 'cn-raw-github',
    url: `https://raw.githubusercontent.com/${REPO_CN}/${REF_CN}/${README_PATH}`,
    reason: '直连 000/0.15 s（2026-10-07），与英文源那台同病；代理下 200/3.2 s 不算数，理由同上一条',
  },
];

/**
 * fetch 失败的类别：进 meta.lastErrorCode 与流水 detail，界面按这个说话（不许把原因塞进一句中文里再让界面去猜）。
 * ★ PARSE 不在这里 —— 正文拿到了但读不出目录，是 lib/parse.js 的 fatal，另一支。
 */
export const FETCH_FAIL = {
  TIMEOUT: 'timeout',       // 超过 FETCH_TIMEOUT_MS 没返回
  STATUS: 'status',         // 非 2xx（403 限流、404 改路径、5xx 源故障）
  TOO_LARGE: 'too_large',   // 超过 MAX_BODY_BYTES：一定不是这份文件
  DECODE: 'decode',         // base64 源给的 JSON 形状不对
  NETWORK: 'network',       // fetch 自己抛（DNS、连接被断、证书）
};

/** meta.lastErrorCode 里代表「正文没问题但目录读不出」的那一支，取值见 PARSE_FATAL。 */
export const SYNC_PARSE_ERROR = 'parse';

export const FETCH_TIMEOUT_MS = 12000;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;   // 正文 CN 191 KB / 英文降级源 294 KB，超 4 MB 一定不是这份文件

/* ------------------------------------------------------------------ *
 * 出网代理（S16：现译渠道的传输层）
 * ------------------------------------------------------------------ */

/**
 * ★ 这一节是 2026-10-07 的**改判**。旧口径是「本插件没有代理开关」，理由写着
 * 「全局 fetch 只在宿主启动时读代理，运行期设不了」（那句话的原文与当时的界面实话留在 §9.1n，历史不抹）。
 * 理由本身没错，错在把它当成了唯一的可能：它只对**用全局 fetch** 的那条路成立。
 * 热榜插件先做了另一条 —— 插件自己拿 `node:net` 向代理发 CONNECT，把 `node:tls` 接上去，
 * HTTP 语义交给内建 `node:https`（`dsh-plugin-gh-trending/lib/services/net.js`）⇒ 运行期就能选路，
 * 全程只用 Node 内建模块，零第三方依赖那条铁律没动。本轮把同一条路搬进 `lib/net.js`。
 *
 * 搬它的理由是这一档在这台机器上**只有经代理才通**，三发实测（2026-10-07，探针 tmp/_gprobe.mjs）：
 *  · 直连 `translate.googleapis.com`：**fetch failed @ 10.8s**；
 *  · 经 `127.0.0.1:7897`：**200 / 932ms**，回包 `[[["有关英国公共图书馆的数据。","Data about…",…]]]`；
 *  · 本机进程环境变量 `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` **全空**，而注册表写着
 *    `ProxyEnable=0x1`、`ProxyServer=127.0.0.1:7897` ⇒ 「跟随系统」必须真去读注册表，
 *    只读环境变量的实现会在这台机器上判成「没有代理」，那一档就永远是死的。
 *
 * ★ 隧道**只服务现译渠道**那一路。抓取那一路（登记表上那几档源）照旧走全局 fetch 直连：
 *   2026-10-05 实测英文三档 CDN 直连 1.27s 就通，给一条已经对上账的路换传输层，等于凭空多一种失败形状。
 */
export const PROXY_MODES = ['system', 'custom', 'direct'];
export const PROXY_MODE_LABELS = { system: '跟随系统', custom: '自定义地址', direct: '直连' };
export const PROXY_MODE_HINTS = {
  system: '先看 HTTPS_PROXY / ALL_PROXY / HTTP_PROXY，再看 Windows 注册表的系统代理；都没有就直连',
  custom: '只认下面那一行地址，形如 127.0.0.1:7897 或 http://127.0.0.1:7897；只支持 http:// 代理（CONNECT 隧道）',
  direct: '环境变量与注册表都不读，始终直连',
};
/** 地址长度上限：超长多半是「粘错了整段 PAC 脚本」，拒掉比截断诚实。 */
export const PROXY_URL_MAX = 200;
/**
 * 自定义地址那一格**不收 `user:pass@`**（写侧拒掉，报错点名这一条）。
 * 这不是洁癖而是这条插件的既有结构：`snapshotOf` 把 prefs **整份**推给浏览器（hc-14 钉着「载荷里没有凭据」），
 * 代理密码只要进了这一格就跟着首屏出去一趟。要带认证的代理请用环境变量或系统代理 —— 那两条读的是宿主进程侧，不进 prefs。
 */
export const PROXY_URL_BOUNDARY = '这一格只写 host:port：prefs 整份推给浏览器，所以带 user:pass@ 的代理密码不收（要认证请配环境变量或 Windows 系统代理）。';

/** 环境变量优先序：https 目标先看 HTTPS_PROXY，再看 ALL_PROXY，最后才退 HTTP_PROXY（很多代理一样接 CONNECT）。 */
export const PROXY_ENV_ORDER = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
/** 只读查询（`reg query`），不写；读不到/超时按「没读到」处理，不算网络故障。 */
export const PROXY_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
/** 隧道建立超时：实测经 127.0.0.1:7897 单发 932ms，8s 够宽，而且小于现译那发的 12s 总闸。 */
export const PROXY_TUNNEL_TIMEOUT_MS = 8000;
/** 注册表缓存时长：改了系统代理最多一分钟内被感知，免得每发都 spawn 一次 reg。 */
export const PROXY_REGISTRY_TTL_MS = 60000;

/** 传输路径的实话（界面直读，客户端不另写一份）。 */
export const TRANSPORT_VIA_LABELS = { proxy: '代理隧道', direct: '直连', failed: '没能出网', idle: '还没出过网' };

/**
 * 路由来源（`net.decideRoute` 的 source 键）→ 人话。
 * ★ 键是协议、话是单点：客户端只念这里给的字，别在浏览器半边再翻一遍（一处翻两处漂）。
 */
export const TRANSPORT_SOURCE_LABELS = {
  custom: '设置页的自定义地址',
  env: '环境变量',
  registry: 'Windows 系统代理',
  bypass: '命中系统代理例外',
  none: '系统里没有可用代理',
  'mode:direct': '设置页选了直连',
  'registry-unreadable': '读不到系统代理',
};

/**
 * `env:HTTPS_PROXY` 是这一组里唯一带尾巴的 source（排障要知道是哪个环境变量顶进来的），其余键整串就是表里的 key。
 * 查不到的键**原样交回** —— 界面不许猜一个翻译。
 */
export function transportSourceLabel(source = '') {
  const s = String(source ?? '');
  if (!s) return '';
  if (TRANSPORT_SOURCE_LABELS[s]) return TRANSPORT_SOURCE_LABELS[s];
  const [head, ...rest] = s.split(':');
  const tail = rest.join(':');
  const label = TRANSPORT_SOURCE_LABELS[head];
  return label && tail ? `${label} ${tail}` : s;
}

/**
 * 「这一发到底从哪条路出去了」那一整句，在**宿主**拼好（客户端只搬字）。
 * 这一行存在的意义：让「代理没生效」和「网络不通」在两行字里就分得开 —— 合成一句「出网失败」就等于把用户支出去自己复现。
 */
export function transportLine(route) {
  if (!route || route.via === 'idle') return '还没出过网：点「测试连接」才知道走哪条路';
  const src = transportSourceLabel(route.source);
  if (route.via === 'failed') return `没能出网：${route.reason || '代理配置不合法，包一个字节都没发'}`;
  if (route.via === 'proxy') return `经代理隧道 · ${src} · ${route.proxy || '地址没解析出来'}`;
  return `直连 · ${src}${route.reason ? ` · ${route.reason}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * 解析区段与列（spec §4）
 * ------------------------------------------------------------------ */

/**
 * 正文只吃目录区：起点锚**整行相等**，右界是起点之后的第一个二级标题，没有下一个二级标题就到文件尾。
 * ★ 2026-10-07 换源带来的改判：`## 目录`（CN 源）整份文件只有一个二级标题，目录区天然到 EOF。
 *   旧口径把"右界收不住"判成 fatal（`END_ANCHOR_MISSING`），本轮**撤销这一支**：
 *   CN 的真文档就是这份形状，按旧口径它一条都读不出来。守卫没有变弱 —— 起点锚仍然必须命中
 *   （`INDEX_ANCHOR_MISSING` 留着），一行表格都没读到 / 解析率低于阈值仍然停写库。
 * 每对记的是实测出处，`end:null` 就是"实测到文件尾"，不是"没查"：
 *   · `## Index` → `## License`（英文源 fixture sha256:7cdfa2a5 实测，Index 在 93 行、License 在 2533 行）
 *   · `## 目录` → 文件尾（CN 源 191468 B 实测，全文只有 3 个非三级标题行：两行 `# ` 加这一行 `## 目录`）
 * 与配对的右界不一致时只登记（report.endAnchorUnexpected），不阻断 —— 目录内容仍然可信。
 */
export const ANCHOR_PAIRS = [
  { start: '## Index', end: '## License' },
  { start: '## 目录', end: null },
];
export const LEVEL2_PREFIX = '## ';

/** 分类头（三级标题）。英文源整份文件有 52 个，CN 源有 54 个，都在目录区内。 */
export const CATEGORY_PREFIX = '###';

/**
 * 区段外必须被排除的东西（实测都在 Index 之前，靠区段过滤天然不吃）：
 * APILayer 广告表 3 列、MCP Servers 表 5 列但语义是 Name/Description/Auth/Transport/Install。
 * ★ CN 源把这两段删掉了（「去掉广告」写在他们的项目介绍里）⇒ 这一份现在只对降级源起作用，
 *   留着是因为降级那一档随时可能被走到，不是因为这里"顺手留着没关系"。
 */
export const EXCLUDED_SECTIONS = [
  { anchor: '## MCP Servers', reason: '列语义不同（Transport / Install 顶替 HTTPS / CORS），混进目录会把筛选facet 污染' },
  { anchor: '## APILayer APIs', reason: '供应商广告表，3 列且全带 utm 参数' },
];

/** REST 表头行的首格文案（用来识别表头并跳过，不计入 rows）。CN 源的表头首格也是 `API`，两边共用。 */
export const HEADER_CELL = 'API';

/** 分隔行特征（实测形态是 `|:---|:---|:---|:---|:---|`，不是 `|---`）。 */
export const SEPARATOR_MARK = ':---';

/**
 * 列数：分隔行有几列，这一档表就有几列。
 * 实测两种形状并存 —— CN 的「AI模型」是 4 列中文表头（`| API | 描述 | 认证方式 | 支持HTTPS |`，23 行），
 * 其余 53 个分类仍是 5 列；英文源全是 5 列。所以"列数不足"的尺子必须跟着分隔行走，
 * 不能写死 5：写死 5 的话 CN 那 23 行会全被判成脏行，解析率 0 ⇒ 整轮停写库。
 * `MIN_TABLE_COLS` 是地板：低于 4 列就一定是别的东西（广告表 3 列），不认。
 */
export const DEFAULT_TABLE_COLS = 5;
export const MIN_TABLE_COLS = 4;
export const COLUMNS = ['name', 'desc', 'auth', 'https', 'cors'];
export const COLUMN_LABELS = { name: 'API', desc: '用途', auth: '鉴权', https: 'HTTPS', cors: 'CORS' };

/**
 * CN 源的取值是**半翻译**的：同一列里中英文并存（实测 1494 行 ——
 *   HTTPS 列 `Yes` 1317 / `是` 61 / `No` 89 / `否` 3 / `YES` 1；
 *   CORS 列 `Unknown` 899 / `未知` 50 / `Yes` 393 / `No` 115 / `是` 10 / `否` 3；
 *   鉴权列 `No` 662 / `apiKey` 643 / `OAuth` 149 / `否` 9）。
 * 只认这三组对得上语义的：`是`→Yes、`否`→No、`未知`→Unknown。
 * ★ 鉴权列的「是」**不在这里** —— 「认证方式：是」回答不了是哪种方式，猜成 apiKey 会把没查过的说成查过的，
 *   所以它照旧落 unknown 并把原值留在 authRaw（口径同第 3 条硬规矩：不许冒充）。
 *   鉴权列的「否」与「无」语义唯一（都是"不需要认证"），映射进 AUTH_ZH_TO_EN：实测 CN 源里 否 9 行、无 2 行。
 */
export const YESNO_ZH_TO_EN = { '是': 'Yes', '否': 'No', '未知': 'Unknown' };
export const AUTH_ZH_TO_EN = { '否': 'No', '无': 'No' };

/** 上游允许的鉴权取值（英文源夹具 sha256:7cdfa2a5 实测分布：No 963 / apiKey 898 / OAuth 150 / X-Mashape-Key 6 / User-Agent 2，合计 2019）。 */
export const AUTH_OPTIONS = ['No', 'apiKey', 'OAuth', 'X-Mashape-Key', 'User-Agent'];
export const AUTH_LABELS = {
  No: '无需鉴权',
  apiKey: '需 API key',
  OAuth: '需 OAuth',
  'X-Mashape-Key': '需 X-Mashape-Key 头',
  'User-Agent': '需带 User-Agent',
  unknown: '鉴权方式未列',
};

export const YESNO_OPTIONS = ['Yes', 'No', 'Unknown'];
export const HTTPS_LABELS = { Yes: '支持 HTTPS', No: '不支持 HTTPS', unknown: 'HTTPS 情况未记' };
export const CORS_LABELS = { Yes: '浏览器可直连', No: '浏览器不能直连（需服务端代理）', unknown: 'CORS 未知，别假设能直连' };

/** 归一化后的第三态：不是 Yes 也不是 No。实测 cors 列有 `–`、空、`Unknown` 外加反引号包裹等脏值。 */
export const UNKNOWN = 'unknown';

/* ------------------------------------------------------------------ *
 * 阈值与降级文案（spec §4）
 * ------------------------------------------------------------------ */

/**
 * 上游描述口径是 ≤100 字（CONTRIBUTING），实测最长 128 字、均值 54 字 ⇒
 * 超长**照收并登记**，绝不截断（截断会把一句话改半，而用户以为自己看的是全文）。
 */
export const DESC_SOFT_LIMIT = 100;

/** parsed/rows 低于它就不再写库：八成以上是「上游表结构变了」而不是零星脏行。 */
export const MIN_PARSE_RATIO = 0.9;

export const PARSE_FATAL = {
  EMPTY_TEXT: '正文是空的，没得解析',
  INDEX_ANCHOR_MISSING: '正文里既没有「## Index」也没有「## 目录」这一行，读不出目录区（源文档可能改了章节名）',
  ROWS_ZERO: '目录区里一条表格行都没读到，形状肯定变了',
  BELOW_RATIO: '解析率低于阈值，已停写库并保留上一次快照',
};

export const PARSE_NOTE =
  '来源：llf007/public-apis-cn 的 README.md 目录区（取不到时降级到 public-apis 英文原文），条目文字照源文档给；本插件不改写描述，只做分类归组与字段归一。'
  + '中文源自己就把分类翻成了中文，所以 `lib/categories.js` 那份映射只对降级源起作用；两边都没有映射的分类只显原文，不猜译。';

/** 「浏览器直连可用」预设档（英文源实测 450 条；CN 源换档后要重新点数，别照念这个数）。三条件缺一不可，界面上必须把条件念出来。 */
export const PRESET_BROWSER_DIRECT = {
  id: 'browser-direct',
  label: '浏览器直连可用',
  hint: '免鉴权 + 支持 CORS + 支持 HTTPS（条数按载荷给，源数据日更，数字会漂）',
  facets: { auth: 'No', cors: 'Yes', https: 'Yes' },
};

/**
 * 「免 key」预设档。★ hint 里不写条数：数字由载荷现算（英文源实测 963 条，CN 源实测 671 条），
 * 写死一个数就会在换源/日更那天变成界面上一句假话。
 */
export const PRESET_NO_KEY = {
  id: 'no-key',
  label: '免 key',
  hint: '鉴权列为 No（条数按载荷给，源数据日更，数字会漂）；CORS 与 HTTPS 不在这一档里筛',
  facets: { auth: 'No' },
};

export const PRESETS = [PRESET_NO_KEY, PRESET_BROWSER_DIRECT];

/** 存储主键分隔符（slug = 分类::名称归一，见 lib/parse.js 的 slugOf）。 */
export const SLUG_SEP = '::';

/* ------------------------------------------------------------------ *
 * 路由与读侧阈值（spec §1 与 §6）
 * ------------------------------------------------------------------ */

/**
 * 命名两侧必须逐字一致：宿主注册的是这个前缀，客户端拼的也是它。
 * ★ GLOBAL_KEY 在 client.js 里必须是**字面量**（不能在运行时从这里取）—— 客户端半边不 import 域文件，
 *   两侧对齐由 test/host-compat.test.mjs 用源码正则钉住（同 gh-trending 的 hc-5）。
 */
export const ROUTE_PREFIX = '/api-catalog';
export const GLOBAL_KEY = '__API_CATALOG__';

/** 一次查询最多回多少行（spec §6「返回 ≤200 行 + total + truncated」）。 */
export const SEARCH_LIMIT_MAX = 200;
export const SEARCH_DEFAULT_LIMIT = 100;

/**
 * offset 的上界闸门：`?offset=999999` 不该被原样带进 slice（那只是浪费，不是错），
 * 但也不该无限制 —— 上游把 offset 当整数直接用，一个 1e15 会让 slice 的起点远大于长度，
 * 结果是空数组且看不出是"翻过头了"。夹到这里之后，界面拿到的永远是合法切片起点。
 */
export const SEARCH_OFFSET_MAX = 100_000;

/**
 * 同 host 聚合：条数门槛与首屏截断。
 * 门槛 2 是因为"只出现一次的供应商"占九成，全列出来等于把「一家散在多个分类」这个信号淹掉；
 * 首屏只带前 20 家（完整清单走 GET /api-catalog/api/hosts）—— 快照那一发要给首屏，不该背上几百行 host。
 */
export const HOST_AGG_MIN = 2;
export const HOST_AGG_TOP = 20;

/* ------------------------------------------------------------------ *
 * 存储（spec §5 与 §9.1b：layout 的裁定是 U-4，2026-10-05 定为 per-record）
 * ------------------------------------------------------------------ */

/** 域名与表名要过 UNIT_NAME_RE（`^[a-z][a-z0-9_]*$`），所以是 api_catalog 而不是 api-catalog。 */
export const DOMAIN_NAME = 'api_catalog';
export const DOMAIN_VERSION = 1;

/**
 * 落盘布局：`per-record` ⇒ 每条记录一个 `<root>/api_catalog/<table>/<key>.json`，
 * 写一类只碰一个文件（宿主源码 `dsh-storage-json/lib/index.js:461-465`）。
 * 选它而不选 single 的理由全在 §9.1b：single 下任何一次 put 都把整域文档重写一遍（源码原文
 * "republishes the whole file"），"按分类切 51 行"在 single 下不但不省磁盘，反而一轮同步整档重写 51 次。
 */
export const DOMAIN_LAYOUT = 'per-record';

/**
 * per-record 布局的键闸门（宿主 `dsh-storage-json/lib/index.js:302` 的 SAFE_KEY_RE，不过就抛，见 :534-536）。
 * ★ 上游的分类名带空格与 &（实测 17 个），slug 带 `::` ⇒ 一律不能直接当键，编码见 lib/keys.js。
 */
export const RECORD_KEY_RE = /^[a-zA-Z0-9_-]+$/;

export const TABLES = {
  entries: 'entries', meta: 'meta', notes: 'notes', prefs: 'prefs', changes: 'changes',
  trans: 'trans', secrets: 'secrets',
};

/** meta 与 prefs 各只有一行，键是固定字面量（本来就更 SAFE_KEY_RE）。 */
export const META_KEY = 'snap';
export const PREFS_KEY = 'prefs';

/** entries 表里「分类」这一行的形状版本；上游换了列语义要升版本，不要静默改字段。 */
export const ENTRY_ROW_VERSION = 1;

/** 两档定时之外的偏好默认值（间隔档见 CHECK_INTERVALS）。 */
export const CHECK_INTERVALS = [60, 360, 720, 1440];

/** 档位的中文说法只在界面显示时用（存进库的永远是分钟数，不是这个 label）。 */
export const CHECK_INTERVAL_LABELS = { 60: '1 小时', 360: '6 小时', 720: '12 小时', 1440: '24 小时' };

/**
 * 偏好五项。前两项管抓取，后三项管中文说明（开关出厂**关**，见下面 TRANSLATE 那一段的理由）。
 * ★ `proxyMode` / `proxyUrl` 是 2026-10-07 加的两格，它**改判**了这里原来那条
 *   「这里没有代理开关，是有证据的删除不是忘了：全局 fetch 只在宿主启动时读代理」——
 *   那条对"用全局 fetch"成立，而 `lib/net.js` 那条 CONNECT 隧道路把它推翻了（证据与来龙去脉在上面 PROXY 那一节）。
 *   代理地址不是凭据（它是本机/内网的一个 host:port），所以它可以进 prefs、可以回显；
 *   ★ 但**带 `user:pass@` 的地址不收**（写侧拒掉，见 PROXY_URL_BOUNDARY）—— 否则密码就跟着 prefs 整份出到浏览器。
 * ★ 仍然**没有任何厂商凭据字段**：翻译渠道的 AppID/密钥一律走 secrets 表（S8 裁定）。
 *   这条不是洁癖：`lib/api.js` 的 snapshotOf 把 prefs **整份**推给浏览器，
 *   密钥只要进过 prefs 就必然跟着首屏出去一趟，靠"发之前记得摘掉"兜不住。
 */
export const DEFAULT_PREFS = {
  intervalMin: 720,
  sourcePriority: SOURCES.map((s) => s.id),
  transEnabled: false,
  transChannel: 'host_llm',
  proxyMode: 'system',
  proxyUrl: '',
};

/** 单飞锁占用中再触发：必须返 rejected promise，同步 throw 会从定时器回调逃逸（modelwatch 崩 5 次的根因）。 */

/**
 * 一轮同步的三种收尾。★ 'noChange' 单独有码不是为了统计好看：
 * lastError 是"最近一次失败的原因"且**成功不清空**（界面要能回答上次为什么失败），
 * 没有这一支的话，故障之后的第一次"没变化"会被界面读成"还在故障中"。
 * 真机复核 U-1b 要看的就是这三行怎么落库。
 */
export const SYNC_RESULT_KINDS = ['success', 'noChange', 'failure'];
export const SYNC_NO_CHANGE = 'no_change';

export const SYNC_BUSY = { code: 'AC_SYNC_BUSY', http: 409, message: '上一轮同步还没结束，本轮不并发触发' };

/**
 * 一轮同步的失败码（进 round 结果的 code；界面按这个选文案，不许去猜 reason 里的中文）。
 *  · FETCH   —— 正文没拿到，具体是哪个源怎么断的看 meta.lastErrorCode（取值是 FETCH_FAIL.* 或 all_sources_failed）
 *  · parse   —— 正文拿到了但读不出目录，见 SYNC_PARSE_ERROR
 *  · STORAGE —— 域不可用或写不进，附 storageCode
 *  · KEY_RULE—— 库里那份快照的键规则与本机不一致。**这一支一行都不写**：
 *              在旧键规则的 notes 还在库里时把新键写下去，等于把用户的批注变成看不见的文件（U-2b 的钩子）。
 */
export const SYNC_FAIL = {
  FETCH: 'fetch',
  STORAGE: 'storage_unavailable',
  KEY_RULE: 'key_rule',
};

/** 退避节拍：1 → 2 → 4 → 8 档，封顶 8；成功归零（spec §3）。 */
export const BACKOFF_STEPS = [1, 2, 4, 8];

/** 差分流水的三种 + 一条分类搬家（category 变了 ⇒ slug 跟着变，笔记必须迁移，不许当成删一条加一条）。 */
export const CHANGE_KINDS = ['added', 'removed', 'changed', 'moved'];

/** 流水与状态行的中文表头（界面只取这里，不许自己再写一份"新增/删除"）。 */
export const CHANGE_KIND_LABELS = {
  added: '新增', removed: '源里删掉了', changed: '字段变化', moved: '换了分类', source_error: '源故障',
  round: '本轮摘要',
};

/**
 * meta.lastStatus 的一句话读法。★ 三支缺一不可：故障恢复后的第一次「没变化」如果落进 'failure'
 * 那一支，界面就会在一切正常的时候继续说"上次没成功"（§5 里 lastError 不清空正是为了留证据）。
 */
export const SYNC_STATUS_LABELS = {
  success: '上次同步：已更新',
  noChange: '上次检查：源内容没变',
  failure: '上次同步没成功',
};

/** 批注标签的上限（界面显示计数器，服务端写侧拒绝，两边取同一个数）。 */
export const TAG_MAX_LEN = 40;
export const TAG_MAX_COUNT = 20;

/** 批注正文上限：界面要显示同一个数，所以也放这里（schema 与 client 共用，不许两处各写一遍）。 */
export const NOTE_PURPOSE_MAX_LEN = 2000;

/* ------------------------------------------------------------------ *
 * 中文说明（S8：内置预译 + 现译渠道）
 * ------------------------------------------------------------------ */

/**
 * 现译渠道的**封闭登记表**。数组顺序就是设置页那一排的顺序；界面只认这里的 id，
 * 选中的 id 不在表里 ⇒ 写侧 400，读侧回落出厂档（同「检查间隔必须是档位之一」那条律）。
 *
 * ★ 2026-10-06 改判：用户裁定「腾讯，阿里，讯飞必须接入」，五档全部 `implemented:true`。
 *   当初只接百度的理由是「没有真 key 就验不了签名」，裁定给的口径是**官方算例先钉签名、
 *   真发等用户填 key 后点「测试连接」**：三家的签名链各自用官方文档里的固定算例钉在
 *   test/translate.test.mjs（腾讯 TC3 连 SecretDate/SecretService/SecretSigning 三层派生的十六进制都逐层对，
 *   阿里是 testid/testsecret 那组假设参数，讯飞是 apisecretXXX… 那组），
 *   所以「拼错了离线全绿、真机每一发 401」这一条已经不像当初说得那么不可验。
 *   仍然如实登记的边界：**请求体形状**（Action/版本/字段名）来自厂商文档，
 *   只有真 key 那一发才算对上账 —— 新接的三家 note 里各写着这一句。
 * ★ 2026-10-07 再加一档并**挪了顺序**：用户裁定「增加『免费接口』是 Google 的网页版翻译，像 github 热榜插件一样」
 *   +「排第一，和热榜一样」⇒ `keyless` 站第一位（数组顺序就是设置页那一排的顺序）。
 *   出厂默认**没跟着改**，仍是 `host_llm`：那一档不依赖代理、也不看厂商脸色，而这一档在这台机器上离了代理发不出去。
 */
export const TRANS_CHANNELS = [
  {
    id: 'keyless',
    label: '免费接口',
    needsKey: false,
    implemented: true,
    quota: '免注册免密钥，但没有承诺的额度（它不是官方授权接口）',
    note: '★ Google 的**网页版**翻译（`translate_a/single` + `client=gtx`）：不是官方授权接口，对方随时可能改形状 ⇒ 回包读不出那个嵌套数组就点名 `bad_json`，不许圆成「没译出来」。本机直连实测 fetch failed @10.8s、经代理 200/932ms ⇒ 这一档离了代理就是发不出去，走哪条路看设置页「现译出网」那一行。',
  },
  {
    id: 'host_llm',
    label: '宿主模型',
    needsKey: false,
    implemented: true,
    quota: '花宿主 profile 的模型额度，不另注册',
    note: '出厂默认。实测关思考的写法是 reasoningEffort:"off"（思考字符归零、单发 12 token），见 spec §9.1j。',
  },
  {
    id: 'baidu',
    label: '百度翻译',
    needsKey: true,
    implemented: true,
    quota: '通用版免费额度 5 万字符/月（用户 2026-10-06 贴的额度表）',
    note: '要 AppID 与密钥。官方接口里只有它是 GET，签名 = MD5(AppID + 原文 + salt + 密钥)。',
  },
  {
    id: 'tencent',
    label: '腾讯翻译',
    needsKey: true,
    implemented: true,
    quota: '免费 500 万字符/月（同上口径）',
    note: 'API 3.0 签名 v3（TC3-HMAC-SHA256），POST，Action=TextTranslate / Version=2018-03-21。SecretKey 只进派生链，不进 URL 也不进日志。字段名照官方接口描述，填 key 后点「测试连接」才算对上账。',
  },
  {
    id: 'aliyun',
    label: '阿里机器翻译',
    needsKey: true,
    implemented: true,
    quota: '免费 200 万字符/月（同上口径）',
    note: 'RPC 签名（HMAC-SHA1 + Base64），GET。AccessKeySecret 只做 HMAC 的 key，一个字符都不进查询串。Action/字段名照官方接口描述，填 key 后点「测试连接」才算对上账。',
  },
  {
    id: 'xunfei',
    label: '讯飞开放平台',
    needsKey: true,
    implemented: true,
    quota: '免费 200 万字符/年（同上口径）',
    note: '机器翻译（新），POST + 鉴权参数在查询串里（HMAC-SHA256 + Base64 两层）。APISecret 只做 HMAC 的 key；★ APIKey 按官方协议进那段 base64（base64 不是加密 ⇒ 这一家确实把 APIKey 摆在查询串里，是厂商口径，不是本插件的选择）。Action/字段名照官方文档，填 key 后点「测试连接」才算对上账。',
  },
];

export const TRANS_CHANNEL_IDS = TRANS_CHANNELS.map((c) => c.id);
export const TRANS_CHANNEL_LABELS = Object.fromEntries(TRANS_CHANNELS.map((c) => [c.id, c.label]));
export const DEFAULT_TRANS_CHANNEL = 'host_llm';

/** 腾讯 TMT 的默认地域：地域留空时发送侧回落它，界面那句提示也拼这一个值（两处不许各写一遍）。 */
export const TENCENT_DEFAULT_REGION = 'ap-guangzhou';

/** 渠道 → 需要填的凭据字段。id 只能是小写字母数字下划线（它是 secrets 表键的一段，见 lib/keys.js）。
 *  `optional:true` 的字段**不挡闸门**（stores 的 hasAll 跳过它），留空由发送侧回落默认值；
 *  `hint` 是界面要念的那一句，值与发送侧回落的那个字符串同源。 */
export const TRANS_CRED_FIELDS = {
  baidu: [
    { id: 'appid', label: 'AppID', max: 32 },
    { id: 'key', label: '密钥', max: 64, secret: true },
  ],
  tencent: [
    { id: 'secret_id', label: 'SecretId', max: 64 },
    { id: 'secret_key', label: 'SecretKey', max: 64, secret: true },
    // ★ optional：留空由 lib/translate.js 回落 TENCENT_DEFAULT_REGION（闸门不挡它，见 stores 的 hasAll）。
    { id: 'region', label: '地域', max: 32, optional: true, hint: `留空 = ${TENCENT_DEFAULT_REGION}` },
  ],
  aliyun: [
    { id: 'access_key_id', label: 'AccessKeyId', max: 64 },
    { id: 'access_key_secret', label: 'AccessKeySecret', max: 64, secret: true },
  ],
  xunfei: [
    { id: 'appid', label: 'APPID', max: 32 },
    { id: 'api_key', label: 'APIKey', max: 64, secret: true },
    { id: 'api_secret', label: 'APISecret', max: 64, secret: true },
  ],
};

export const TRANS_CRED_MAX = 128;

/**
 * 端点只写在这一处（hc-8 的口径：带 scheme 的地址不许散进别的文件）。
 * `host_llm` 没有端点：它走宿主的 llm 句柄，本插件一次网都不出。
 * ★ 这一张表同时是**出网域名白名单**的唯一来源 —— translate.js 只允许往表里的 host 发，
 *   判据从这里派生，不许在测试里手抄一份域名清单。
 * 地址逐家对过官方文档（2026-10-06）：腾讯 `tmt.tencentcloudapi.com`（接口描述第一行）、
 * 阿里 `mt.cn-hangzhou.aliyuncs.com`（官方 endpoints 元数据里 cn-hangzhou 的 public 项）、
 * 讯飞 `itrans.xf-yun.com/v1/its`（机器翻译（新）的请求行 `POST /v1/its HTTP/1.1`；
 * 注意这家新接口是 **xf-yun.com** 带连字符的域，旧版文档里的 itrans.xfyun.cn 不是同一个）。
 * `keyless` 那一档**没有官方文档可核**（网页版接口本来就不对外承诺形状），地址与参数是照热榜插件
 * 那发实测抄来的，并且本轮在这台机器上重跑过一遍：经代理 200 / 932ms（读数在上面 PROXY 那一节）。
 */
export const TRANS_ENDPOINTS = {
  host_llm: '',
  keyless: 'https://translate.googleapis.com/translate_a/single',
  baidu: 'https://fanyi-api.baidu.com/api/trans/vip/translate',
  tencent: 'https://tmt.tencentcloudapi.com/',
  aliyun: 'https://mt.cn-hangzhou.aliyuncs.com/',
  xunfei: 'https://itrans.xf-yun.com/v1/its',
};

export const TRANS_HOSTS = Object.values(TRANS_ENDPOINTS).filter(Boolean).map((u) => new URL(u).hostname);

/** 一发的闸门。上游描述实测最长 128 字，300 已经给它留了翻倍的空间。 */
export const TRANS_TIMEOUT_MS = 12000;
export const TRANS_IN_MAX = 300;
export const TRANS_OUT_MAX = 600;
/** 一轮现译最多发几发。★ 一次一句，不做"多句拼一发"：机器翻译把整段拼过去后回包怎么切回每句没有可靠判据，切错的后果是把 A 的描述挂到 B 上。 */
export const TRANS_MAX_PER_ROUND = 40;
/** 同一句失败原文多久才允许再试（挡住"每轮同步都把接口打一遍"）。 */
export const TRANS_FAIL_COOLDOWN_MS = 24 * 3600_000;
/**
 * 限流（429）那一支单独设短一档。★ 它和别的失败不是同一种病：500/形状不对是"这发没戏"，
 * 429 是"这会儿太多了"—— 按 24 h 冷却就等于自己把自己关一整天，而通常几分钟就好。
 * 但也不能不留窗口：一失败就重试会把限流那台越打越死（真机当晚就是这么从 200 掉进 429 的，§9.1r）。
 */
export const TRANS_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;

/** 现译失败的封闭取值（界面按这个选文案，不许去 parse 中文原因）。 */
export const TRANS_ERROR_KEYS = [
  'off', 'no_channel', 'not_implemented', 'no_credential', 'unavailable', 'no_model',
  'transport', 'timeout', 'http', 'rate_limited', 'bad_json', 'empty', 'no_han', 'too_long', 'store', 'error',
  'busy',
];
export const TRANS_ERROR_LABELS = {
  off: '现译开关没开，一句都没发（在设置页「中文说明」里打开）',
  no_channel: '内部：现译渠道取到了没登记的值',
  not_implemented: '这一档的签名还没接，接口一次都没发（原文照给）',
  no_credential: '这一档要 AppID 与密钥，设置页里还没填齐，没有发出请求',
  unavailable: '宿主没给出这一档要的服务，原文照给',
  no_model: '宿主没设默认模型（现译要知道发给哪个 provider），原文照给',
  transport: '没能连上翻译接口，原文照给',
  timeout: '翻译接口超时，原文照给',
  http: '翻译接口回了错误状态，原文照给',
  rate_limited: '翻译接口在限流（回 429），原文照给；这一档的冷却比别的错短，过一会儿自己会好',
  bad_json: '翻译接口的回包读不出结构（接口形状变了），原文照给',
  empty: '翻译接口答了，但读不出一句话，原文照给',
  no_han: '回来的没有汉字（模型把原文吐回来了），按没译成处理，原文照给',
  too_long: '回来的一大段不像一句描述，原文照给',
  store: '译文没存下来（本地存储不可用），这次用完就丢',
  error: '现译这一路没被派活（内部），原文照给',
  // runPass 的 `skipped:'busy'` 走的是同一张话术表：界面拿 skipped 直接查，不另猜一句（判据同「预设计数与 chips 必然同数」）。
  busy: '上一轮现译还在跑，这一发没有排队（跑完再点）',
};

/** 译文落款：`现译 · 百度翻译 · 10-06 12:30`。跟着**行里那一档渠道**走，换档不改旧行的署名。 */
export function transZhLabel(channel, at) {
  const prefix = `现译 · ${TRANS_CHANNEL_LABELS[channel] ?? channel}`;
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return prefix;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return prefix;
  const p = (x) => String(x).padStart(2, '0');
  return `${prefix} · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 设置页那一句（密钥为什么不在 prefs、为什么留空表示不改动，都说在这里）。 */
export const TRANS_SETTINGS_NOTE =
  '中文说明有两层：内置离线预译表（随插件发版，' + DESC_ZH_COUNT + ' 条原文逐字对得上就命中，一次网都不出）'
  + '与现译（只有内置表没命中的那句才发，按原文逐字存本机，改过原文才重译）。'
  + 'AppID 与密钥只写进本机的 secrets 表：它不在偏好里，没有任何读接口能把它带回浏览器，界面上也只显示「已配置 · N 位」。';

/** 密钥输入框那一句：输入框留空 = 不改动（浏览器半边永远拿不回原值，没有"填回原值"这条路）。 */
export const SECRET_SAVED_HINT = '库里已存（留空表示不改动，点「清除」才删）';

/** 官方渠道那一句边界话：填之前就要看见。 */
export const TRANS_CRED_BOUNDARY = '密钥只发给所选渠道的域名，不发给 GitHub、不进日志、不回显在界面上。';

/** 「还剩几句没中文」里那个 cooldown 数字的解释 —— 话术在域里，浏览器半边不许自己造（一份真相）。
 *  两个数字都是从常量算出来的：文案里手写「24」的话，改闸门时这句话会留在屏上说旧数字。
 *  ★ 限流那一支单独一档（U-15）：429 与 500 在屏幕上是两种排障方向，冷却也不该同长。 */
export const TRANS_COOLDOWN_NOTE =
  `这一轮没译成的那句，${TRANS_FAIL_COOLDOWN_MS / 3600_000} 小时内不再重试（否则每轮同步都会把接口再打一遍）；`
  + `接口回 429（限流）的那句短一档，${TRANS_RATE_LIMIT_COOLDOWN_MS / 60_000} 分钟后就再试。`;

/** 一句 desc 有没有"能用的中文"：内置表与现译表共用同一条判据（逐字相同 + 含汉字）。 */
export const TRANS_HAN_RE = /[\u4e00-\u9fff]/;

/* ------------------------------------------------------------------ *
 * 落库形状（spec §5）：七表 schema 只在这里写一份
 * （S8 起多两张：trans 存现译出来的句子，secrets 存渠道凭据。后者任何读接口都碰不到。）
 * ------------------------------------------------------------------ */

/**
 * 鉴权列的**落库**枚举 = 上游认识的那五个 + unknown。
 * ★ 为什么不能直接用 AUTH_OPTIONS：normAuth 把枚举外的脏值归成 'unknown'，
 *   schema 只认上游五个的话，第一条脏值就把整分类行挡成 INVALID（一行的脏值拖死 201 条）。
 */
export const AUTH_VALUES = [...AUTH_OPTIONS, UNKNOWN];

/**
 * Yes/No 列的落库枚举。★ 这里**没有** 'Unknown'：上游写 Unknown 的格子经 normYesNo 也归成 'unknown'。
 * YESNO_OPTIONS 是「上游原文的认识表」，这份是「库里的形状」，语义不同，别合并成一个。
 */
export const YESNO_VALUES = ['Yes', 'No', UNKNOWN];

/**
 * 流水行的种类（与 CHANGE_KINDS 不同处：源故障那一行不属于任何分类，kind 另开一支）。
 * ★ 'source_error' 是"这一轮什么都没改成"的那一行 —— 界面要回答「上次为什么失败」，
 *   光靠 meta.lastError 只有一条，看不出连续失败了几轮。
 */
export const CHANGE_ROW_KINDS = [...CHANGE_KINDS, 'source_error', 'round'];

/**
 * 界面上那排筛选芯片的种类。★ 与 CHANGE_ROW_KINDS 差一条：'round'（本轮摘要）能读、能画，
 * 但不做成芯片 —— 点它只会筛出"每轮一行"，那不是筛选，是第二个视图（红线：界面不许多此一举）。
 */
export const CHANGE_FILTER_KINDS = [...CHANGE_KINDS, 'source_error'];

/** 差分流水保留多少行（append-only + 每轮 trim，同 gh-trending 的 events 口径）。 */
export const KEEP_CHANGES = 200;

/**
 * 流水 detail 的上限。★ 超长是**在这一层就截**（不是报错）：它是给人看的一句话，
 * 不是数据本体 —— 变化本身已经按 kind + 七个可比字段各自登记过，句子长过这一格只是噪音。
 * 200 → 320 是 2026-10-07 换源那天的实测：登记表涨到 5 档之后，「整条链全断」那一行是 209 字，
 * 被 200 截掉的正好是最后一档源的名字 —— 那条流水的作用就是"逐个说得出是谁没通"，截它等于把守卫截了。
 * 再加源不用回来改这里：test/sync.test.mjs 那条用例按登记表逐档断言，少一档就红。
 */
export const CHANGE_DETAIL_MAX_LEN = 320;

/**
 * 一条 API。parse.js 的 entries 比这里多带 line / categoryLine / authRaw ——
 * record() 会**丢弃未声明字段**（不是原样保留），所以落库自然只剩这一份形状：
 * 行号是「这一份 README」的坐标，存进下一份快照就是假线索。
 */
const entryItem = record({
  slug: requiredString('主键'),
  name: requiredString('名称'),
  url: requiredString('文档地址'),
  host: optionalString('主机名'),
  desc: optionalString('用途一句话'),
  auth: requiredEnum('鉴权', AUTH_VALUES),
  https: requiredEnum('HTTPS', YESNO_VALUES),
  cors: requiredEnum('CORS', YESNO_VALUES),
  category: requiredString('分类'),
  firstSeenAt: requiredNumber('本机首次见到这条的时刻'),
  lastSeenAt: requiredNumber('最近一次仍在目录里的时刻'),
}, '条目');

/**
 * entries 表的一行 = 一个分类（51 行）。
 * ★ 切行只在 per-record 布局下有意义：改一个分类只重写它自己那个文件；
 *   single 下任何一次 put 都整域重写，切 51 行反而变成一轮同步把全档写 51 遍（实测约 26 MB，见 §9.1b）。
 * items 允许空数组：「这一类被清空但还没删档」是真实中间态，写空不该炸，删档由 sync 决定。
 */
const entriesRow = record({
  category: requiredString('分类名'),
  rowVersion: requiredInt('行形状版本'),
  updatedAt: requiredNumber('本行重写时刻'),
  items: arrayOfItem('条目清单', entryItem, { required: true }),
}, '分类行');

/**
 * meta 表的一行：快照坐标 + 台账摘要 + 退避档位。
 * counts 存分类清单（51 项 ≈ 2 KB），让「分类过滤器」不读 entries 就能出；
 * 鉴权/HTTPS/CORS 分布不另存 —— 读侧从 entries 现算，两处存数必然漂移。
 */
const metaRow = record({
  keyRule: requiredInt('键规则版本（与 lib/keys.js 的 KEY_RULE_VERSION 对上才许直接读，对不上走迁移）'),
  sha: optionalString('正文 SHA-256'),
  sourceId: optionalString('本轮成功的源 id'),
  sourceUrl: optionalString('本轮成功的 URL'),
  fetchedAt: optionalNumber('拿到正文的时刻'),
  lastCheckedAt: optionalNumber('上一次检查的时刻（含没变化的检查）'),
  total: optionalInt('条目总数'),
  parseRatio: optionalNumber('解析率'),
  endAnchor: optionalString('右界锚点：实测英文源是 ## License，CN 源到文件尾（这一格就写实际收口的那一行，没有就写 (EOF)）'),
  counts: arrayOf('分类清单', { name: requiredString('分类名'), count: requiredInt('条数') }),
  /**
   * 最近一轮的收尾（取值 SYNC_RESULT_KINDS）。★ 这一支是界面唯一能回答「现在到底是好的还是在故障中」的依据：
   * lastError 按口径**成功与没变化都不清空**（它是"最近一次失败的原因"这段历史，不是当前状态），
   * 没有 lastStatus 的话，故障恢复之后的第一次「没变化」会被读成还在故障里。
   */
  lastStatus: optionalEnum('最近一轮收尾', SYNC_RESULT_KINDS),
  lastError: optionalString('最近一次失败的原因（成功不清空，界面要能回答“上次为什么失败”）'),
  lastErrorCode: optionalString('最近一次失败的码'),
  backoff: optionalInt('退避档位（0 = 正常；取值是 BACKOFF_STEPS 的下标，不是失败次数）'),
}, '快照元数据');

/**
 * notes 表的一行 = 一条个人批注。键是 noteKey(slug)（带 :: 的 slug 过不了宿主闸门）。
 * purpose 超长是报错不是截断（optionalString 的口径）—— 笔记是用户写的，悄悄改半句最不能接受。
 */
const noteRow = record({
  slug: requiredString('主键'),
  category: requiredString('分类名（搬家时靠它算新行，不靠查 entries）'),
  // 写批注那一发从**在册条目**快照一份人话名：slug 尾巴是按 norm(name) 生成的（breedhealthscore），
  // 上游删掉条目后只剩这一份能看。在册时界面优先用条目里的 live name，这份只是 orphan 的兜底。
  name: optionalString('名称快照（上游删条目后界面还显示人话）'),
  purpose: optionalString('用途说明', { maxLength: NOTE_PURPOSE_MAX_LEN }),
  tags: arrayOfItem('标签', requiredString('标签')),
  starred: optionalBool('置顶'),
  hidden: optionalBool('默认结果里隐藏'),
  orphan: optionalBool('上游已删但笔记保留（笔记是用户资产，不跟着删）'),
  updatedAt: requiredNumber('最近修改时刻'),
}, '批注');

/**
 * prefs 表的一行。★ sourcePriority 的默认值是一份**数组**，别顺手改成 requiredString 之类：
 * 这里只收整数与字符串数组，脏行由 createPrefsStore 的 clampPrefs 钳回可用值再落库。
 */
/**
 * 差分流水一行。detail 是给人看的一句话（「鉴权 No → apiKey」「分类 Books → Books & Magazines」），
 * 不是结构化 diff —— 结构化要把五种字段各来一对 old/new，界面反而更难显示，且这行不会被查询逻辑消费。
 */
const changeRow = record({
  id: requiredString('流水 id'),
  at: requiredNumber('时刻'),
  kind: requiredEnum('种类', CHANGE_ROW_KINDS),
  slug: optionalString('主键（源故障那一行没有）'),
  name: optionalString('名称'),
  category: optionalString('分类'),
  detail: optionalString('变化内容', { maxLength: CHANGE_DETAIL_MAX_LEN }),
}, '流水行');

const prefsRow = record({
  intervalMin: requiredInt('检查间隔(分)'),
  sourcePriority: arrayOfItem('源优先级', requiredString('源 id'), { required: true }),
  transEnabled: optionalBool('现译开关（出厂关）'),
  transChannel: optionalEnum('现译渠道', TRANS_CHANNEL_IDS),
  // ★ 两格都是 optional：宿主的 schema 只在 open() 读存量时生效，老库里那一行没有它们 ⇒
  //   必须能读出来（读侧由 clampPrefs 补默认），一条坏行会拖死整个域（spec §5 的存储不可用就是这么来的）。
  proxyMode: optionalEnum('现译出网代理模式', PROXY_MODES),
  proxyUrl: optionalString('自定义代理地址（只 proxyMode=custom 时用；不收 user:pass@）', { maxLength: PROXY_URL_MAX }),
}, '偏好');

/**
 * 现译表的一行 = **一句原文**（不是一条条目）：上游两条条目共用一句话时只译一遍，
 * 键取自折叠空白后的原文（lib/keys.js 的 transKey），所以命中判据就是逐字相同 —— 措辞一改就重译，
 * 绝不拿旧句子冒充新描述。
 * `ok:false` 的失败行**照存**：里面是"这句在 <at> 试过、因 errText 没成"，
 * 不存的话每轮同步都会把同一句再打一遍接口（而 cooldown 判据要靠 at 才有得比）。
 * ★ zh 用 optionalString 是因为失败行压根没有译文；长度闸门在这里（600），写侧不必再夹一遍。
 */
const transRow = record({
  src: requiredString('原文（折叠空白后逐字）'),
  zh: optionalString('译文', { maxLength: TRANS_OUT_MAX }),
  at: requiredNumber('这一行写下的时刻'),
  chars: requiredInt('译文字数（失败行为 0）'),
  channel: requiredEnum('这一行是谁译的', TRANS_CHANNEL_IDS),
  ok: requiredBool('成功行还是失败行'),
  errText: optionalString('失败原因（接口给的那一句）', { maxLength: 200 }),
  // U-15：冷却时长按失败种类分档，所以种类得留在行上。★ optional 不是可省的设计判断：
  // 宿主只在 open() 读存量时套 schema，写成 required 会让这一列加之前的旧失败行整域读不出来
  // （同 §5 里 `notes.name` 那一发的口径：`optionalString` 对"没填"给 `undefined`，`record()` 再丢掉它）。
  errKey: optionalEnum('失败种类（成功行没有）', TRANS_ERROR_KEYS),
}, '译文行');

/**
 * secrets 表的一行 = 某个渠道的某个凭据字段。
 * ★ value 的**长度闸门不在 schema**：`requiredString` 没有 maxLength 参数，而 kv-schema.js 是
 *   五个插件的同源拷贝，不为这一条去改它、更不为它加一处漂移。闸门写在 lib/stores.js 的
 *   writeSecret（超限就 rejected，界面收到 400），字段上限见 TRANS_CRED_FIELDS。
 * value 是这个域里唯一"不能出现在任何读接口"的字段：判据在 test/api.test.mjs 与 hc-14，
 * 靠的是"没有任何 GET 路由引用 secrets"这一条结构事实，不是靠发之前记得摘。
 */
const secretRow = record({
  channel: requiredEnum('渠道', TRANS_CHANNEL_IDS),
  field: requiredString('字段 id'),
  value: requiredString('字段值'),
  at: requiredNumber('写入时刻'),
  chars: requiredInt('值的长度（界面只显示这个数）'),
}, '凭据');

export const AC_DOMAIN = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: DOMAIN_LAYOUT,
  invalidRecords: 'backup-and-skip',
  tables: {
    [TABLES.entries]: domainTable(entriesRow),
    [TABLES.meta]: domainTable(metaRow),
    [TABLES.notes]: domainTable(noteRow),
    [TABLES.prefs]: domainTable(prefsRow),
    [TABLES.changes]: domainTable(changeRow),
    [TABLES.trans]: domainTable(transRow),
    [TABLES.secrets]: domainTable(secretRow),
  },
});

