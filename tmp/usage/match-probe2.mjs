/* tmp/usage/match-probe2.mjs —— 收紧匹配：只认「条目 host == 规范的服务端 host」，并剔掉共享网关 host。
 * 上一版按 swaggerUrl/x-origin 建索引，结果 amazonaws.com / rapidapi.com 这种网关 host 把一堆不相干的
 * 条目吸过去了（MeowFacts -> AWSMigrationHub）。那种行进了插件就是编造，所以宁可覆盖面小。
 * 跑法：node tmp/usage/match-probe2.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog, hostOf, normUrl } from '../../lib/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/* 共享网关：一个 host 后面挂着成千上万个不同 provider，按 host 匹配必错。 */
const GATEWAY_HOSTS = new Set([
  'amazonaws.com', 'rapidapi.com', 'api.enterprise.apigee.com', 'cloud.googleapis.com',
  'api.microsoftstream.com', 'apis.guru', 'apideck.com', 'googleapis.com', 'apis.io', 'herokuapp.com',
]);

const md = fs.readFileSync(path.join(root, 'test/fixtures/public-apis-README.md'), 'utf8');
const { entries } = parseCatalog(md);
const list = JSON.parse(fs.readFileSync(path.join(here, 'apis-guru-list.json'), 'utf8'));

/* lib 的 hostOf 先过「像不像地址」闸门（只认 http(s)/www 开头），而 apis.guru 的键是裸 host
 * （`1forge.com`），过不了那道闸会全成空串 —— 这里必须自己拆，别复用那个闸门。 */
const bareHost = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/* 规范里声明的服务端 host：OpenAPI 3 看 servers[].url，Swagger 2 看 host。
 * 索引只从「键 base host」建（list.json 里没有 servers 面，要等下-spec 再补），且都过网关黑名单。 */
const byServerHost = new Map();
const addIdx = (h, key) => {
  if (!h || GATEWAY_HOSTS.has(h)) return;
  if (!byServerHost.has(h)) byServerHost.set(h, []);
  byServerHost.get(h).push(key);
};
for (const key of Object.keys(list)) {
  addIdx(bareHost(key.split(':')[0]), key);
}

/* 命中判据：条目 host 与某个 provider 的服务端 host 同一家。 */
const hits = [];
for (const e of entries) {
  const h = hostOf(e.url);
  const keys = byServerHost.get(h);
  if (!keys || !keys.length) continue;
  hits.push({ slug: e.slug, name: e.name, url: e.url, host: h, keys: [...new Set(keys)] });
}

const multi = hits.filter((h) => h.keys.length > 1);
console.log(`条目 ${entries.length} · 可匹配的服务端 host ${byServerHost.size} · 命中 ${hits.length}（${((hits.length / entries.length) * 100).toFixed(1)}%）· 一个 host 挂多个 provider 的 ${multi.length}`);
console.log('命中样例：', hits.slice(0, 15).map((h) => `${h.host} <- ${h.name}`).join(' | '));

const cats = {};
for (const h of hits) cats[h.keys.length] = (cats[h.keys.length] || 0) + 1;
console.log('每条目对应 provider 数分布：', JSON.stringify(cats));

fs.writeFileSync(path.join(here, 'hits-strict.json'), JSON.stringify(hits, null, 1));

/* 顺手量第二个面：public-apis 条目的 URL 本身就是 JSON 规范地址的有多少（按 host 之后有 .json 尾巴）。 */
const specish = entries.filter((e) => /\.json(\?|$)/i.test(normUrl(e.url)));
console.log(`URL 尾巴就是 .json 的条目 ${specish.length}（这些多半直接就是规范文件）`);
