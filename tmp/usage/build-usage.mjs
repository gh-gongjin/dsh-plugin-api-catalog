/* tmp/usage/build-usage.mjs —— 把验过形状的规范产物压成 `lib/usage.js`（用法层内置表）。
 *
 * 为什么压成表而不是打包整份规范：
 *  · 运行时零抓取是红线，插件体积却是要付的账 —— 一份规范动辄几百 KB，2019 条原样塞进发版包不成立；
 *  · 界面只要那几格（这一家叫什么、往哪个 base 发、鉴权是哪一类、前几条主入口），多的一格都不显示就别存。
 * 每个键都带自己的出处（spec 地址 + 抓取日），界面上那行落款念的就是它，不念就是编造。
 *
 * 挑选规则（一个文档页引用了多份规范时）：可用规范里取 pathCount 最大那份，同数按 spec 地址升序 ——
 * 确定性优先，不靠"看起来更像"。
 *
 * 跑法：node tmp/usage/build-usage.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog, normUrl } from '../../lib/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.join(here, 'specs.jsonl');
/* 条目全集用**随仓库走的那份夹具 README**（test/fixtures/public-apis-README.md），不用抓取当时那份：
 * 表要打进插件，判据要能在现树上对账 —— 用抓取当时那份会留下"表里有键、目录里没这条"的死行（上一版就是 10 个）。 */
const README = path.join(here, '..', '..', 'test', 'fixtures', 'public-apis-README.md');

const usable = [];
const unusable = [];
for (const line of fs.readFileSync(SPECS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  (r.err ? unusable : usable).push(r);
}

const { entries } = parseCatalog(fs.readFileSync(README, 'utf8'));
const keysOf = (r) => (r.pages || []).map(normUrl).filter(Boolean);
/* 文档页里写全大写或带尾斜杠的都有：键必须和读侧那条 `normUrl(e.url)` 同一个口径，否则 join 不上就是"抓到了却显示不出"。 */
const entryKeys = new Map();
for (const e of entries) {
  const k = normUrl(e.url);
  if (k && !entryKeys.has(k)) entryKeys.set(k, e.name);
}

const rank = (a, b) => (b.pathCount - a.pathCount) || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0);
const byEntry = new Map();
let orphanSpecs = 0;
for (const r of usable) {
  const ks = keysOf(r).filter((k) => entryKeys.has(k));
  if (!ks.length) { orphanSpecs++; continue; }
  for (const k of ks) {
    if (!byEntry.has(k)) byEntry.set(k, []);
    byEntry.get(k).push(r);
  }
}

const pick = (list) => [...list].sort(rank)[0];
/* base 地址里躺着 `http://localhost:3000` 这种厂商开发机形状（规范作者自己写的默认值）。
 * 界面那一栏的问题是"往哪发"，回环/内网答不了这个问题 ⇒ 这一格整条丢掉，连"厂商写了 localhost"都不解释，
 * 因为丢掉的只是永远用不上的那几条，同组里公网那条照留。 */
const LOCAL_SERVER_RE = /^(?:localhost|0\.0\.0\.0|127\.|\[?::1\]?)|^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;
function publicServers(list) {
  return (list || []).filter((s) => {
    if (/^\//.test(s)) return true; // 相对 base（有的规范写 `servers:[{url:"/api/v1"}]`）：厂商原文，配合条目自己的 host 才有意义，留着
    try { return !LOCAL_SERVER_RE.test(new URL(s).hostname.toLowerCase()); } catch { return false; }
  }).slice(0, 4);
}
let droppedLocalServers = 0;
const rows = new Map();
for (const [k, list] of byEntry) {
  const r = pick(list);
  const servers = publicServers(r.servers);
  droppedLocalServers += (r.servers || []).length - servers.length;
  rows.set(k, {
    title: r.title || '',
    kind: r.kind,
    specVersion: r.specVersion || '',
    pathCount: r.pathCount,
    servers,
    schemes: (r.schemes || []).map((s) => ({ id: s.id, type: s.type, in: s.in || '', name: s.name || '' })),
    globalSecurity: r.globalSecurity || [],
    operations: (r.operations || []).map((o) => ({ method: o.method, path: o.path, summary: o.summary })),
    spec: r.spec,
    at: r.harvestedAt,
  });
}

const total = entries.length;
const uniqEntryUrls = entryKeys.size;
console.log(`规范行：可用 ${usable.length} · 不可用 ${unusable.length}`);
console.log(`条目：${total} 行（文档页去重 ${uniqEntryUrls}）· 对上一份可用规范 ${rows.size} 个键（${((rows.size / uniqEntryUrls) * 100).toFixed(1)}%）`);
console.log(`对不上条目的规范 ${orphanSpecs} 份（页面不是从目录来的，或目录里那条 URL 与它引用的地址不同形）`);
console.log(`丢掉的内网/回环 base ${droppedLocalServers} 条（规范作者的开发机默认值，答不了"往哪发"）`);
const errCount = {};
for (const r of unusable) errCount[r.err] = (errCount[r.err] || 0) + 1;
console.log(`不可用明细：${Object.entries(errCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

const bytes = JSON.stringify(Object.fromEntries(rows)).length;
console.log(`表体 ${bytes} B（平均每键 ${(bytes / Math.max(1, rows.size)).toFixed(0)} B）`);
if (process.argv.includes('--dry')) {
  console.log('[--dry：没写文件]');
  for (const [k, v] of [...rows].slice(0, 3)) console.log(k, '⇒', JSON.stringify(v).slice(0, 240));
  process.exit(0);
}

const sorted = [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const body = sorted.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
const file = `/* lib/usage.js —— 用法层：构建期一次性从各家**自己声明的机器可读规范**里抽出的那几格（随发版走，运行时零抓取）。
 *
 * ★ 这张表的全部来历（读代码前先读这段，否则无法判断哪一格能信）：
 *  · 来源面只有一层：public-apis 条目自己的文档页 HTML 里**明写的**规范地址（不猜路径、不猜 host）；
 *    抓下来的文档必须带 \`openapi:3.x\` 或 \`swagger:2.x\` 且 \`paths\` 非空才算"可用"，其余一律不进表（\`no-openapi-marker\`/\`not-json\`/\`yaml-skipped\` 各按原样记数，见 §9.1l）。
 *  · YAML 规范这一版**没解**（零第三方依赖 ⇒ 没有可靠的 YAML 解析），所以表里只有 JSON 那一档；对不上的条目界面**不显用法层**，不拿猜测补。
 *  · 每个值都是厂商自己写的：\`title/specVersion/operations[].summary\` 是规范里的原文，本表不翻译、不改写、不合并。
 *    唯一的删除项是 \`servers\` 里回环/内网那几条（规范作者的开发机默认值，答不了"往哪发"），同组里公网那条照留。
 *  · 每行带 \`spec\`（出处地址）与 \`at\`（抓取日）：界面上那一行落款念的就是这两个值，念不出就是编造。
 *  · 抓取与构建脚本：\`tmp/usage/harvest-pages.mjs\` → \`candidates.json\` → \`harvest-specs.mjs\` → \`specs.jsonl\` → 本文件（\`build-usage.mjs\`）。
 *    构建期跑在用户本机（GET-only、显式 UA、内网/回环不碰、走代理），插件运行时一个请求都不发。
 *
 * 生成时间：${new Date().toISOString().slice(0, 10)} · 键 ${sorted.length} 个 · 表体约 ${(bytes / 1024).toFixed(0)} KB
 * 改这张表 = 重跑 \`tmp/usage/build-usage.mjs\`，别手改：手改的每一格都没有出处，判据也挡不住。
 */
import { normUrl } from './parse.js';

/** 抓取批次（界面上"这一格是哪一趟抓的"就念它）。 */
export const USAGE_HARVESTED_AT = '2026-10-06';

/**
 * 键 = \`normUrl(条目 url)\`（与读侧同一个口径）；值 = 那一份可用规范里抽出的几格。
 * 冻结：这张表是发版产物，运行时没有任何一层该往里写。
 */
export const USAGE = Object.freeze({
${body}
});

/** 按条目 URL 取用法层；取不到就是 null（界面据此**整块不摆**，不摆半套）。 */
export function usageFor(rawUrl) {
  const k = normUrl(rawUrl);
  return k && Object.prototype.hasOwnProperty.call(USAGE, k) ? USAGE[k] : null;
}

/** 表的规模（判据用它对账"打包了多少条"，也让界面能把命中率说成事实）。 */
export const USAGE_COUNT = Object.keys(USAGE).length;
`;
fs.writeFileSync(path.join(here, '..', '..', 'lib', 'usage.js'), file, 'utf8');
console.log(`[写了 lib/usage.js：${rows.size} 键 · ${(fs.statSync(path.join(here, '..', '..', 'lib', 'usage.js')).size / 1024).toFixed(0)} KB]`);
