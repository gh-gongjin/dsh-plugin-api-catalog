/* tmp/gen-desc-src.mjs —— 从真 README 夹具抽出待译原文，去重后切片。
 * 归一化口径与运行期命中判据同一个函数（normalizeSrc）：两侧必须一致，否则"逐字相同"是假的。
 * 产物：tmp/desc-src.json（全量，带命中的 slug 数）+ tmp/desc-part-NN.json（切片，喂翻译）。
 * 跑法：node tmp/gen-desc-src.mjs [片数] */
import fs from 'node:fs';
import { parseCatalog } from '../lib/parse.js';
import { descZhNorm } from '../lib/desc-zh.js';

const normalizeSrc = descZhNorm;

const md = fs.readFileSync(new URL('../test/fixtures/public-apis-README.md', import.meta.url), 'utf8');
const { entries: items } = parseCatalog(md);

const bySrc = new Map();
for (const e of items) {
  const src = normalizeSrc(e.desc);
  if (!src) continue;
  const hit = bySrc.get(src);
  if (hit) { hit.entries += 1; hit.slugs.push(e.slug); } else bySrc.set(src, { src, entries: 1, slugs: [e.slug] });
}
const rows = [...bySrc.values()];
fs.writeFileSync(new URL('./desc-src.json', import.meta.url), JSON.stringify(rows, null, 1));
console.log(`条目 ${items.length} / 有描述 ${items.reduce((a, e) => a + (normalizeSrc(e.desc) ? 1 : 0), 0)} / 唯一原文 ${rows.length} / 总字符 ${rows.reduce((a, r) => a + r.src.length, 0)}`);
console.log(`被 2 条以上共用的原文 ${rows.filter((r) => r.entries > 1).length} 种，最多一条共用 ${Math.max(...rows.map((r) => r.entries))} 次`);

const parts = Math.max(1, Number(process.argv[2] || 8));
const size = Math.ceil(rows.length / parts);
for (let i = 0; i < parts; i++) {
  const slice = rows.slice(i * size, (i + 1) * size);
  if (!slice.length) continue;
  fs.writeFileSync(new URL(`./desc-part-${String(i + 1).padStart(2, '0')}.json`, import.meta.url), JSON.stringify(slice.map((r) => r.src), null, 1));
  console.log(`part-${String(i + 1).padStart(2, '0')} ${slice.length} 条 / ${slice.reduce((a, r) => a + r.src.length, 0)} 字符`);
}
