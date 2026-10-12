/* tmp/usage/harvest-pages.mjs —— 用法层抓取第一趟：读每条目的文档页，只登记「页面自己引用的机器可读规范地址」。
 *
 * 为什么这样抓：public-apis 的表格里只有名称/URL/描述/auth/https/cors 五列，没有任何用法层；
 * apis.guru 按 host 严格对上号只有 74 条（3.6%）。所以改从厂商自己的文档页找规范入口 ——
 * ★ 不做路径猜测（不去试 /openapi.json 这种"也许在"的位置）：猜来的规范一旦 host 复用就是编造。
 * 页面里引用到的规范地址是厂商声明的事实，抓不到就如实记 0 条。
 *
 * 产物：tmp/usage/pages.jsonl（一行一个文档页，可续跑：已在文件里的 URL 跳过）。
 * 跑法：PILOT=40 node tmp/usage/harvest-pages.mjs   /   node tmp/usage/harvest-pages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCatalog, normUrl } from '../../lib/parse.js';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'pages.jsonl');
const PROXY = process.env.USAGE_PROXY || 'http://127.0.0.1:7897';
const CONC = Number(process.env.USAGE_CONC || 6);
const MAX_MS = Number(process.env.USAGE_TIMEOUT || 12000);
const BODY_CAP = 600 * 1024;

const md = fs.readFileSync(path.join(here, 'upstream-README.md'), 'utf8');
const { entries } = parseCatalog(md);

const uniq = new Map();
for (const e of entries) {
  const u = normUrl(e.url);
  if (!u || uniq.has(u)) continue;
  uniq.set(u, { name: e.name, category: e.category });
}
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).url); } catch { /* 半行不算 */ }
  }
}
const queue = [...uniq.keys()].filter((u) => !done.has(u));
const limit = Number(process.env.PILOT || 0);
/* 试点要按全表等距抽，不能取前 N 条 —— 前 40 条全落在同一个分类里，命中率代表不了整体。 */
const work = limit
  ? Array.from({ length: Math.min(limit, queue.length) }, (_, k) => queue[Math.floor((k * queue.length) / Math.min(limit, queue.length))])
  : queue;
console.log(`唯一文档页 ${uniq.size} · 已完成 ${done.size} · 本趟要抓 ${work.length} · 并发 ${CONC} · 超时 ${MAX_MS}ms · 代理 ${PROXY}`);

/* 规范入口的识别面：只认"页面里明写的地址"。每条都给 reason，落档时能区分是谁说的。 */
const SPEC_RE = [
  ['spec-url', /spec-url\s*=\s*["']([^"'\s]+)["']/gi],
  ['link-rel', /<link[^>]+rel=["'](?:swagger|openapi|api-spec)["'][^>]*href=["']([^"']+)["']/gi],
  ['href-json', /(?:href|src|data-url|urls\.primaryUrl)\s*=\s*["']([^"']+\.(?:json|yaml|yml|raml)(?:\?[^"']*)?)["']/gi],
  ['href-word', /["']([^"']*(?:openapi|swagger)[^"']*\.(?:json|ya?ml))["']/gi],
  ['js-url', /\b(?:url|specUrl|swaggerUrl|baseUrl|definition)\s*[:=]\s*["']([^"']+\.(?:json|ya?ml))["']/gi],
];

function pickSpecs(html, baseUrl) {
  const found = new Map();
  for (const [reason, re] of SPEC_RE) {
    re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(html)) && guard++ < 60) {
      const raw = m[1];
      if (!raw || raw.length > 300 || /(^data:|javascript:)/i.test(raw)) continue;
      let abs;
      try { abs = new URL(raw, baseUrl).href; } catch { continue; }
      if (!/^https?:/i.test(abs)) continue;
      if (!found.has(abs)) found.set(abs, { url: abs, via: reason });
    }
  }
  const kind = /swagger-ui|SwaggerUIBundle/i.test(html) ? 'swagger-ui'
    : /redoc-element|<redoc[\s>]|rapidoc/i.test(html) ? 'redoc/rapidoc'
    : /api-explorer/i.test(html) ? 'api-explorer' : 'plain';
  return { specs: [...found.values()].slice(0, 8), kind, bytes: html.length };
}

/* 内网/回环一律不抓：文档链接是上游文本，理论上能写 127.0.0.1 这种东西，抓取脚本不给它开这条路。 */
function isPublicHost(u) {
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h.startsWith('127.') || h.startsWith('::1')) return false;
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  return true;
}

const TMP = path.join(here, 'body');
fs.mkdirSync(TMP, { recursive: true });
let tmpSeq = 0;

async function grab(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { url, err: 'bad-url' }; }
  if (!/^https?:/i.test(parsed.protocol) || !isPublicHost(parsed)) return { url, err: 'skipped-host' };
  const out = path.join(TMP, `b${tmpSeq++}.bin`);
  const args = ['-sS', '-L', '--compressed', '--proto-redir', '-all,http,https',
    '--max-time', String(Math.floor(MAX_MS / 1000)), '-x', PROXY,
    '-A', 'api-catalog-usage-harvest/1 (build-time; one GET per documented API)',
    '-o', out, '-w', '%{http_code}\t%{content_type}\t%{size_download}', url];
  try {
    const { stdout } = await execFileP('curl', args, { timeout: MAX_MS + 6000, maxBuffer: 1 << 20 });
    const [codeS = '0', ct = '', sizeS = '0'] = stdout.split('\t');
    const code = Number(codeS);
    const size = Number(sizeS);
    if (!code || code < 200 || code >= 400) {
      fs.rmSync(out, { force: true });
      return { url, code, ct, err: code ? 'http' : 'curl-fail' };
    }
    let body = '';
    if (fs.existsSync(out)) {
      const fd = fs.openSync(out, 'r');
      const len = Math.min(BODY_CAP, fs.fstatSync(fd).size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      fs.rmSync(out, { force: true });
      body = buf.toString('utf8');
    }
    if (/^application\/json/i.test(ct) && /openapi|"paths"/i.test(body)) {
      // 文档页本身就是规范文件
      return { url, code, ct, bytes: size, specs: [{ url, via: 'page-is-json' }], kind: 'json-spec-page' };
    }
    return { url, code, ct, bytes: size, ...pickSpecs(body, url) };
  } catch (e) {
    fs.rmSync(out, { force: true });
    return { url, err: String(e.code || e.message || e).slice(0, 60) };
  }
}

const fh = fs.openSync(OUT, 'a');
let i = 0; let withSpec = 0; let errs = 0;
const t0 = Date.now();
async function worker() {
  while (i < work.length) {
    const url = work[i++];
    const r = await grab(url);
    r.fetchedAt = '2026-10-06';
    if (r.err) errs++; else if (r.specs.length) withSpec++;
    fs.appendFileSync(fh, JSON.stringify(r) + '\n');
    const n = done.size + i;
    if (i % 20 === 0 || i === work.length) {
      console.log(`  ${i}/${work.length} · 有规范入口 ${withSpec} · 失败 ${errs} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
fs.closeSync(fh);
console.log(`[本趟 ${work.length} 发 · 有规范入口 ${withSpec}（${((withSpec / Math.max(1, work.length)) * 100).toFixed(1)}%）· 失败 ${errs} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 累计行数 ${done.size + work.length}]`);
