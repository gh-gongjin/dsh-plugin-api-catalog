/**
 * tmp/gen-desc-zh.mjs —— 生成内置离线预译表 lib/desc-zh.js。
 *
 * 输入：tmp/desc-src.json（1965 条唯一原文，来自 parseCatalog 的真解析结果）
 *      tmp/desc-zh-part-NN.json（8 片译文，每片 [{en, zh}]，en 与输入逐字对齐）
 * 这条流水线是**一次性**的：译文由人工编排的批次产出并逐片对账（tmp/verify-desc-zh.mjs），
 * 之后新增/变更的描述走 lib/translate.js 的渠道层落进 trans 表，不回这张表。
 *
 * 跑法：node tmp/gen-desc-zh.mjs
 */
import fs from 'node:fs';
import { descZhNorm } from '../lib/desc-zh.js';

// ★ 归一化口径只有一处定义（lib/desc-zh.js 的 descZhNorm）：生成器与运行期共用，
//   否则「逐字相同才命中」是假的。表首版由 --bootstrap 那次手写落盘，之后不必再走那条路。
const norm = descZhNorm;
const srcs = JSON.parse(fs.readFileSync('tmp/desc-src.json', 'utf8')).map((r) => r.src);
const SLICES = 8;

const rows = [];
for (let i = 0; i < SLICES; i++) {
  const part = String(i + 1).padStart(2, '0');
  const slice = JSON.parse(fs.readFileSync(`tmp/desc-zh-part-${part}.json`, 'utf8'));
  const start = rows.length;
  slice.forEach((r, j) => {
    const src = norm(srcs[start + j]);
    if (!src) throw new Error(`第 ${part} 片第 ${j + 1} 条在 desc-src.json 里没有对应原文（切片总数对不上）`);
    if (norm(r.en) !== src) throw new Error(`第 ${part} 片第 ${j + 1} 条 en 与原文不逐字相同：\n  原文 ${src}\n  回显 ${norm(r.en)}`);
    const zh = norm(r.zh);
    if (!zh) throw new Error(`第 ${part} 片第 ${j + 1} 条 zh 为空`);
    rows.push([src, zh]);
  });
}
if (rows.length !== srcs.length) throw new Error(`行数 ${rows.length} != 原文数 ${srcs.length}`);

const seen = new Map();
for (const [src] of rows) {
  if (seen.has(src)) throw new Error(`原文重复（命中判据要靠它做主键）：${src.slice(0, 60)}`);
  seen.set(src, 1);
}

// 整条只有专有名词的（zh 里一个汉字都没有）**照原样进表**，且把 zh 归成与 src 逐字相同：
//   那批译文里有的把 "SEPTA APIs" 写成 "SEPTA API"、有的把半角括号换成全角，留着会让「这是预译」的标签撒谎。
// 表因此能被一条硬判据钉住 —— 真 README 里每一条原文都查得到，漏一条就挂
//   （若把这 22 条剔出去，判据就得靠"多短算专有名词"这类启发式，实测那种判据会放走整句话）。
const rows2 = rows.map(([src, zh]) => (/[\u4e00-\u9fff]/.test(zh) ? [src, zh] : [src, src]));
const kept = rows2;
const echoes = rows2.filter(([, zh]) => !/[\u4e00-\u9fff]/.test(zh));

const body = kept.map(([src, zh]) => `  ${JSON.stringify([src, zh])},`).join('\n');

const head = `/**
 * lib/desc-zh.js —— 内置**离线**预译描述表。
 *
 * ★ 数据段由 \`tmp/gen-desc-zh.mjs\` 生成，**别手改**：要改就改生成器再复跑（改完对不上账看不出来）。
 *
 * 三条口径：
 *  1. **离线**：表在编译期落定，运行期零模型调用、零额外出网。这一句是给用户的定心丸，不是装饰。
 *  2. **带来源与时间戳**：界面上那句 DESC_ZH_NOTE 说清「这是预译、什么时候整理的」，不冒充现译。
 *  3. **原文变了就退回原文**：主键就是整理当时的原文（归一化空白后逐字），上游把描述改一个词
 *     就查不到 → 退回英文原文。宁可少一句中文，不指鹿为马。
 *
 * 覆盖：真 README 的 ${srcs.length} 种唯一原文**全在表里**（一条判据钉死：查不到就挂用例）。
 * 其中 ${echoes.length} 种整条就是个专有名词（如 "TfL API"），译文与原文同形 —— 界面按「与原文相同就不标预译」处理。
 */

/** 表整理的时间戳（界面上那句说明里的日期只有这一份）。 */
export const DESC_ZH_AT = '2026-10-06';

/** 来源说明。*/
export const DESC_ZH_ORIGIN = '插件内置离线词表';

/** 界面用的整句来源说明。*/
export const DESC_ZH_NOTE = \`中文说明为\${DESC_ZH_ORIGIN}预译（\${DESC_ZH_AT} 整理），不是现译；上游改过原文、或整条本来就是个名字，就只显示原文。\`;

/** 短标签。*/
export const DESC_ZH_LABEL = \`内置离线预译 · \${DESC_ZH_AT}\`;

/** [整理当时的原文（已归一化空白）, 译文] —— 生成物，勿手改。 */
export const DESC_ZH_ROWS = [
`;

const tail = `];

const BY_SRC = new Map(DESC_ZH_ROWS);

/** 原文归一化：折叠空白。★ 生成器、运行期、用例三处必须同一口径，所以只在这一个函数里定义。 */
export function descZhNorm(s) {
  return String(s ?? '').replace(/\\s+/g, ' ').trim();
}

/**
 * 取译文。命中判据 = 归一化原文逐字相同；不命中返回空串。
 * ★ 返回空串而不是原文：让调用方决定怎么显示，「没译」和「译成空」在界面上不会是两种样子。
 */
export function descZhFor(desc) {
  const key = descZhNorm(desc);
  if (!key) return '';
  return BY_SRC.get(key) || '';
}

/**
 * 界面取用：{ zh, translated }。
 * ★ translated=false 有两种：表里没这条（原文改过），或整条本来就是个名字、中文与原文同形。
 *   界面上「这是预译」那句标签只在 translated=true 时出现，否则是给英文原文贴了个假标签。
 */
export function descZhView(desc) {
  const src = descZhNorm(desc);
  const zh = src ? (BY_SRC.get(src) || '') : '';
  return { zh: zh || src, translated: !!zh && zh !== src };
}

/** 一批原文 → { 原文: 译文 }，只收命中的。 */
export function descZhHits(texts = []) {
  const hits = {};
  for (const t of texts) {
    const zh = descZhFor(t);
    if (zh) hits[descZhNorm(t)] = zh;
  }
  return hits;
}

/** 词表条目数（用例与文档要对账用，别让「表有多少条」变成口头数字）。 */
export const DESC_ZH_COUNT = BY_SRC.size;
`;

fs.writeFileSync('lib/desc-zh.js', head + body + '\n' + tail);
const kb = (fs.statSync('lib/desc-zh.js').size / 1024).toFixed(1);
console.log(`[lib/desc-zh.js 写出：入库 ${kept.length} 条 / 原样退回的专有名词 ${echoes.length} 条 / ${kb}KB]`);
