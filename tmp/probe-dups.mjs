import { readFileSync } from 'node:fs';
import { parseCatalog, slugOf } from '../lib/parse.js';

const text = readFileSync(new URL('../test/fixtures/public-apis-README.md', import.meta.url), 'utf8');
const r = parseCatalog(text);

const groups = new Map();
for (const e of r.entries) {
  const base = slugOf(e.category, e.name);
  if (!groups.has(base)) groups.set(base, []);
  groups.get(base).push(e);
}
const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
const out = [];
out.push(`rows=${r.report.rows} parsed=${r.report.parsed} entries=${r.entries.length}`);
out.push(`dupGroups=${multi.length} dupRowsInGroups=${multi.reduce((a, [, v]) => a + v.length, 0)}`);
out.push(`dupSlugs.length=${r.report.dupSlugs.length} exactDups.length=${r.report.exactDups.length} dupUrls.length=${r.report.dupUrls.length}`);
out.push('-- groups --');
for (const [base, v] of multi) out.push(`${base} :: ${v.map((e) => `${e.line}=${e.url}`).join(' | ')}`);

// 区段外的广告表 / MCP 表：按名字找，看是否真的进来了
for (const banned of ['IPstack', 'Marketstack', 'Weatherstack', 'OpenSwissData', 'Kuro']) {
  const hits = r.entries.filter((e) => e.name === banned);
  out.push(`name ${banned}: ${hits.map((e) => `${e.line}@${e.category} ${e.url}`).join(' | ') || 'none'}`);
}
out.push(`adSig(utm_campaign=Public-apis): ${r.entries.filter((e) => /utm_campaign=Public-apis/i.test(e.url) || /utm_campaign=Public-apis/i.test(e.desc)).length}`);
out.push(`glama/mcp hosts: ${r.entries.filter((e) => /glama\.ai|mcp\.so|smithery\.ai/i.test(e.url)).map((e) => e.url).join(' | ') || 'none'}`);
out.push('-- 广告表原始行（整份文件里带 utm_campaign=Public-apis 的行号）--');
text.split('\n').forEach((l, i) => { if (/utm_campaign=Public-apis/i.test(l)) out.push(`${i + 1}: ${l.slice(0, 120)}`); });
out.push(`region start=${r.report.region.start} end=${r.report.region.end}`);

const fx = readFileSync(new URL('../test/fixtures/fx-dup-slugs.md', import.meta.url), 'utf8');
const f = parseCatalog(fx);
const fgroups = new Map();
for (const e of f.entries) {
  const b = slugOf(e.category, e.name);
  fgroups.set(b, [...(fgroups.get(b) || []), e]);
}
out.push(`-- fx-dup-slugs: parsed=${f.report.parsed} dupSlugs=${f.report.dupSlugs.length} exactDups=${f.report.exactDups.length}`);
for (const [b, v] of fgroups) if (v.length > 1) out.push(`${b} :: ${v.map((e) => `${e.line}=${e.url} slug=${e.slug}`).join(' | ')}`);

console.log(out.join('\n'));
