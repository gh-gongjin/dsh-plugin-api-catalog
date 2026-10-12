import { descZhView } from '../lib/desc-zh.js';
import { fixture } from '../test/_helpers.mjs';
import { parseCatalog } from '../lib/parse.js';

const README = await fixture('public-apis-README.md');
const list = parseCatalog(README).ok ? parseCatalog(README).entries : [];
let hit = 0, miss = 0, empty = 0;
const missSamples = [];
for (const it of list) {
  const d = String(it.desc || '');
  if (!d) { empty++; continue; }
  if (descZhView(d).translated) hit++;
  else { miss++; if (missSamples.length < 8) missSamples.push(`${it.name} :: ${d.slice(0, 80)}`); }
}
console.log(JSON.stringify({ total: list.length, hit, miss, empty }));
console.log(missSamples.join('\n'));
