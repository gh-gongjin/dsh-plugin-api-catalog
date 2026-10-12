/* tmp/usage/match-probe.mjs —— 实测匹配率：public-apis 的 2019 条里有多少条能对上一份真 OpenAPI 规范。
 * 目的不是产出数据，是在写抓取脚本之前把「用法层能覆盖多少」这个数拿到手。
 * 跑法：node tmp/usage/match-probe.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from '../../lib/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const md = fs.readFileSync(path.join(root, 'test/fixtures/public-apis-README.md'), 'utf8');
const { entries } = parseCatalog(md);

const list = JSON.parse(fs.readFileSync(path.join(here, 'apis-guru-list.json'), 'utf8'));

const hostOf = (u) => {
  if (!u) return '';
  try {
    const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return x.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/* apis.guru 的键是**服务端 host**（不是文档 host），所以一个键要按三个地址面去建索引。 */
const byHost = new Map();           // host -> Set<key>
const add = (h, key) => {
  if (!h) return;
  if (!byHost.has(h)) byHost.set(h, new Set());
  byHost.get(h).add(key);
};
for (const [key, v] of Object.entries(list)) {
  add(hostOf(key.split(':')[0]), key);
  for (const ver of Object.values(v.versions || {})) {
    add(hostOf(ver.swaggerUrl), key);
    for (const o of (ver.info && ver.info['x-origin']) || []) add(hostOf(o.url), key);
    add(hostOf(ver.info && ver.info.contact && ver.info.contact.url), key);
  }
}

const buckets = { '键 host': 0, 'swaggerUrl host': 0, 'x-origin host': 0, 'contact host': 0, '无': 0 };
const matched = [];
const unmatched = [];
for (const e of entries) {
  const h = hostOf(e.url);
  const keys = byHost.get(h);
  if (keys && keys.size) {
    matched.push({ slug: e.slug, name: e.name, url: e.url, keys: [...keys] });
  } else {
    unmatched.push({ slug: e.slug, name: e.name, host: h });
  }
}

// 键 host 单独数一次，看主要来源是哪一面
for (const [key, v] of Object.entries(list)) if (key.split(':')[0] && !key.includes('/')) buckets['键 host'] += 0;
void buckets;

console.log(`条目 ${entries.length} · 唯一服务端 host 索引 ${byHost.size}`);
console.log(`apis.guru 收录 ${Object.keys(list).length} 个 provider`);
console.log(`对上号 ${matched.length}（${((matched.length / entries.length) * 100).toFixed(1)}%）· 对不上 ${unmatched.length}`);
const keys = new Set();
for (const m of matched) for (const k of m.keys) keys.add(k);
console.log(`用到的 provider 键 ${keys.size}`);
console.log('样例命中：', matched.slice(0, 8).map((m) => `${m.name} -> ${m.keys[0]}`).join(' | '));
console.log('样例未命中：', unmatched.slice(0, 12).map((m) => m.host).join(' | '));

const hosts = {};
for (const u of unmatched) hosts[u.host] = (hosts[u.host] || 0) + 1;
console.log('未命中里条目数最多的 host：', Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([h, n]) => `${h}(${n})`).join(' | '));

fs.writeFileSync(path.join(here, 'matched.json'), JSON.stringify(matched, null, 1));
fs.writeFileSync(path.join(here, 'unmatched.json'), JSON.stringify(unmatched, null, 1));
