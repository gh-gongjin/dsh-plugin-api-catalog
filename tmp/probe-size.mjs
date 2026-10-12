import { readFileSync } from 'node:fs';
import { parseCatalog } from '../lib/parse.js';

const t = readFileSync(new URL('../test/fixtures/public-apis-README.md', import.meta.url), 'utf8');
const r = parseCatalog(t);
const strip = (e) => ({ slug: e.slug, name: e.name, url: e.url, host: e.host, desc: e.desc, auth: e.auth, https: e.https, cors: e.cors, category: e.category });
const s = r.entries.map(strip);
const out = [];
out.push(`存储形状（10 字段，无 line）JSON 总字节=${Buffer.byteLength(JSON.stringify(s))} 平均=${Math.round(Buffer.byteLength(JSON.stringify(s)) / s.length)}`);
const byCat = {};
for (const e of s) (byCat[e.category] ||= []).push(e);
const rows = Object.entries(byCat).map(([c, v]) => [c, Buffer.byteLength(JSON.stringify({ category: c, items: v })), v.length]).sort((a, b) => b[1] - a[1]);
out.push(`分类行数=${rows.length} 最大三类=${rows.slice(0, 3).map((x) => `${x[0]}:${x[1]}B/${x[2]}条`).join(', ')}`);
out.push(`最小三类=${rows.slice(-3).map((x) => `${x[0]}:${x[1]}B/${x[2]}条`).join(', ')}`);
out.push(`单行中位数=${rows.map((x) => x[1]).sort((a, b) => a - b)[Math.floor(rows.length / 2)]}B`);
console.log(out.join('\n'));
