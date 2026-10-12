import { readFileSync } from 'node:fs';
import { parseCatalog, slugOf, extractRegion, foldKey } from '../lib/parse.js';

const url = new URL('../test/fixtures/public-apis-README.md', import.meta.url);
const text = readFileSync(url, 'utf8');
const lines = text.split('\n');
const reg = extractRegion(text);
const out = [];

out.push(`region start(0b)=${reg.start} end(0b)=${reg.end} endAnchor=${reg.endAnchor}`);
// 1) 同名同分类：按「原始 URL」与「归一 URL」两种口径各数一遍，看 16 与 15 差在哪
const gRaw = new Map();
let category = '';
lines.forEach((l, i) => {
  if (i <= reg.start || i >= reg.end) return;
  if (l.trim().startsWith('### ')) { category = l.trim().slice(4).trim(); return; }
  if (!l.trim().startsWith('|')) return;
  const cells = l.split('|').slice(1);
  const m = /^\s*\[(.*?)\]\(\s*(\S+?)\s*\)\s*$/.exec(cells[0] ?? '');
  if (!m || !/^https?:\/\/|^www/i.test(m[2])) return;
  const key = `${category}::${foldKey(m[1].trim())}`;
  if (!gRaw.has(key)) gRaw.set(key, []);
  gRaw.get(key).push({ rawUrl: m[2], line: i + 1, name: m[1].trim() });
});
const multiRaw = [...gRaw.entries()].filter(([, v]) => v.length > 1);
out.push(`按原始 URL 文本分组：组数=${multiRaw.length} 行数=${multiRaw.reduce((a, [, v]) => a + v.length, 0)}`);
for (const [k, v] of multiRaw) {
  const norm = new Set(v.map((x) => x.rawUrl.replace(/\s+/g, '').replace(/\/$/, '')));
  out.push(`  ${k} n=${v.length} distinctNorm=${norm.size} :: ${v.map((x) => `${x.line}:${x.rawUrl}`).join(' | ')}`);
}
// 2) 广告表(3列带 Postman 按钮)与 MCP 表的实际行号，确认它们落在区段外
const adIdx = [];
lines.forEach((l, i) => { if (/Run In Postman|utm_campaign=Public-apis-repo-Best-sellers/.test(l)) adIdx.push(i + 1); });
out.push(`广告行(Best-sellers 签名)行号=${adIdx.join(',')}`);
const mcpIdx = [];
lines.forEach((l, i) => { if (/^\| \[[^\]]+\]\([^)]*\) \| .* \| .stdio.|, |^\| API \| Description \| Transport \| Install \|/.test(l)) mcpIdx.push(i + 1); });
out.push(`MCP 形状行=${mcpIdx.join(',')}`);
lines.forEach((l, i) => { if (/^## /.test(l)) out.push(`  L2 @${i + 1}: ${l.trim()}`); });

const r = parseCatalog(text);
out.push(`解析：rows=${r.report.rows} parsed=${r.report.parsed} dupGroups(实收)=${[...new Set(r.report.dupSlugs.map((d) => d.slug.split('::').slice(0, 2).join('::')))].length} dupSlugs 行=${r.report.dupSlugs.length} exactDups=${r.report.exactDups.length}`);
out.push(`区内是否混入广告表行：line<${reg.start + 1} 的条目=${r.entries.filter((e) => e.line < reg.start + 1).length}`);
out.push(`含 Postman 按钮 markup 的条目=${r.entries.filter((e) => /Run In Postman|pstmn\.io/.test(e.desc + e.url + e.name)).length}`);
for (const n of ['IPstack', 'Marketstack', 'Weatherstack', 'Numverify', 'Fixer']) {
  out.push(`  ${n} 在区内的条目=${r.entries.filter((e) => e.name === n).map((e) => `${e.line}:${e.url.slice(0, 46)}`).join(' | ') || 'none'}`);
}
console.log(out.join('\n'));
