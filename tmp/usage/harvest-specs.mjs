/* tmp/usage/harvest-specs.mjs —— 用法层抓取第二趟：抓 candidates.json 里那些"页面自己引用的规范地址"，
 * 只登记**验过形状**的规范（openapi/swagger + 有 paths），其余如实记 err，不猜、不补。
 *
 * 口径（和第一趟同）：
 *  · 构建期一次性抓，运行时零抓取 ⇒ 这一份产物只是中间态，最终进 lib/usage.js 的是**抽出来的字段**，不是整份规范；
 *  · 全程 GET（curl 不带 -d/-X，也不 POST）、显式 UA、只走代理、内网/回环不碰；
 *  · 可续跑：已在 specs.jsonl 里的 spec URL 跳过；YAML 按"跳过并记数"处理，不当失败也不硬解。
 *
 * 产物：tmp/usage/specs.jsonl（一行一个规范地址）。
 * 跑法：PILOT=40 node tmp/usage/harvest-specs.mjs   /   node tmp/usage/harvest-specs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CAND = path.join(here, 'candidates.json');
const OUT = path.join(here, 'specs.jsonl');
const PROXY = process.env.USAGE_PROXY || 'http://127.0.0.1:7897';
const CONC = Number(process.env.USAGE_CONC || 6);
const MAX_MS = Number(process.env.USAGE_TIMEOUT || 15000);
const BODY_CAP = Number(process.env.USAGE_CAP || 2 * 1024 * 1024); // 截到这一格还解不开 JSON 就按 too-large 记（回捞那趟把上限调大）
const HARVESTED = '2026-10-06';

const cands = JSON.parse(fs.readFileSync(CAND, 'utf8'));
/* 同一个规范地址可能被好几个文档页引用：按 spec 归并，pages 留全（这是"谁说的"的出处，不能只留第一条）。 */
const bySpec = new Map();
for (const c of cands) {
  if (!c || !c.spec) continue;
  if (!bySpec.has(c.spec)) bySpec.set(c.spec, { spec: c.spec, pages: new Set(), via: new Set() });
  const r = bySpec.get(c.spec);
  if (c.page) r.pages.add(c.page);
  if (c.via) r.via.add(c.via);
}
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).spec); } catch { /* 半行不算 */ }
  }
}
const all = [...bySpec.values()].map((r) => ({ spec: r.spec, pages: [...r.pages], via: [...r.via] }));
/* RETRY_ERRS=too-large,timeout —— 回捞那一档：正文被体量闸门截断的**不是坏规范**，而是规范真有那么大
 * （一份 8 MB 的规范照样只要那几格）。回捞按 spec 原位替换 specs.jsonl 里的那一行，不追加第二条。 */
const RETRY = (process.env.RETRY_ERRS || '').split(',').map((s) => s.trim()).filter(Boolean);
let priorRows = null;
let work;
if (RETRY.length) {
  priorRows = fs.existsSync(OUT)
    ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const want = new Set(RETRY);
  work = priorRows.filter((r) => r.err && want.has(r.err)).map((r) => ({ spec: r.spec, pages: r.pages, via: r.via }));
} else {
  work = all.filter((r) => !done.has(r.spec));
}
const limit = Number(process.env.PILOT || 0);
if (limit && !RETRY.length) {
  work = Array.from({ length: Math.min(limit, work.length) }, (_, k) => work[Math.floor((k * work.length) / Math.min(limit, work.length))]);
}
console.log(`唯一规范 ${all.length} · 已完成 ${done.size} · 本趟 ${work.length}${RETRY.length ? '（回捞 ' + RETRY.join('、') + '）' : ''} · 并发 ${CONC} · 超时 ${MAX_MS}ms · 正文上限 ${(BODY_CAP / 1024 / 1024).toFixed(1)}MB · 代理 ${PROXY}`);

/* 与第一趟同一条闸门：文档链接是上游文本，理论上能写 127.0.0.1，抓取脚本不给它开这条路。 */
function isPublicHost(u) {
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h.startsWith('127.') || h === '::1') return false;
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  return true;
}

const TMP = path.join(here, 'body');
fs.mkdirSync(TMP, { recursive: true });
let tmpSeq = 0;

async function download(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { err: 'bad-url' }; }
  if (!/^https?:/i.test(parsed.protocol) || !isPublicHost(parsed)) return { err: 'skipped-host' };
  /* github 的 blob 地址是**网页**（HTML），规范正文在 raw 那一台：这是同一个声明的两种地址，
   * 不是路径猜测 —— 页面写的就是这条 blob，换成 raw 只是把"这一份文件"取到手上。 */
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/i.exec(url);
  const real = gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}/${gh[4]}` : url;
  if (gh) parsed = new URL(real);
  const out = path.join(TMP, `s${tmpSeq++}.bin`);
  const args = ['-sS', '-L', '--compressed', '--proto-redir', '-all,http,https',
    '--max-time', String(Math.floor(MAX_MS / 1000)), '-x', PROXY,
    '-A', 'api-catalog-usage-harvest/1 (build-time; one GET per documented API)',
    '-o', out, '-w', '%{http_code}\t%{content_type}\t%{size_download}', real];
  try {
    const { stdout } = await execFileP('curl', args, { timeout: MAX_MS + 8000, maxBuffer: 1 << 20 });
    const [codeS = '0', ct = '', sizeS = '0'] = stdout.split('\t');
    const code = Number(codeS);
    if (!code) { fs.rmSync(out, { force: true }); return { err: 'curl-fail', rewrote: !!gh }; }
    if (code < 200 || code >= 400) { fs.rmSync(out, { force: true }); return { code, ct, err: 'http', rewrote: !!gh }; }
    const raw = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
    fs.rmSync(out, { force: true });
    const truncated = raw.length > BODY_CAP;
    return { code, ct, bytes: Number(sizeS) || raw.length, text: raw.subarray(0, BODY_CAP).toString('utf8'), truncated, rewrote: !!gh };
  } catch (e) {
    fs.rmSync(out, { force: true });
    /* curl 的超时是数字码（28），原样落到 err 里就成了没人看得懂的"28"：按名字记，落档时才知道那一发是怎么没的。 */
    const num = Number(e.code);
    const errName = num === 28 ? 'timeout' : num ? `curl-${num}` : String(e.code || e.message || e).slice(0, 60);
    return { err: errName, rewrote: !!gh };
  }
}

/* ---- 抽取：只从**验过形状**的规范里取界面要的那几格，取不到就如实是空数组。 ---- */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

function kindsOf(doc) {
  if (typeof doc.openapi === 'string') return doc.openapi.startsWith('3') ? `openapi ${doc.openapi}` : null;
  if (typeof doc.swagger === 'string') return doc.swagger.startsWith('2') ? `swagger ${doc.swagger}` : null;
  return null;
}

function serversOf(doc, kind) {
  if (kind.startsWith('openapi')) {
    return (Array.isArray(doc.servers) ? doc.servers : [])
      .map((s) => String(s?.url || '')).filter(Boolean).slice(0, 4);
  }
  const host = String(doc.host || '');
  const base = String(doc.basePath || '');
  if (!host && !base) return [];
  const scheme = (Array.isArray(doc.schemes) && doc.schemes[0]) || 'https';
  return [`${scheme}://${host}${base === '/' ? '' : base}`].filter((s) => !/\/\/$/.test(s) || host !== '');
}

function schemesOf(doc, kind) {
  const out = [];
  if (kind.startsWith('openapi')) {
    for (const [id, s] of Object.entries(doc.components?.securitySchemes || {})) {
      out.push({ id, type: String(s?.type || ''), scheme: String(s?.scheme || ''), in: String(s?.in || ''), name: String(s?.name || '') });
    }
  } else {
    for (const [id, s] of Object.entries(doc.securityDefinitions || {})) {
      out.push({ id, type: String(s?.type || ''), scheme: String(s?.scheme || s?.flow || ''), in: String(s?.in || ''), name: String(s?.name || '') });
    }
  }
  return out.slice(0, 8);
}

/* 挑哪几条 path：文档顺序（不是字母序 —— 作者把有用的放前面），最多 6 条，每个 path 只取第一个操作。
 * 依据：这一层的用途是"告诉用户这个 API 大概怎么用"，前几条最常是主入口；整份规范不进插件。 */
function pathsOf(doc) {
  const picked = [];
  for (const [p, item] of Object.entries(doc.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    const m = METHODS.find((k) => item[k] && typeof item[k] === 'object');
    if (!m) continue;
    const op = item[m];
    picked.push({
      method: m.toUpperCase(),
      path: p,
      summary: String(op.summary || op.description || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      params: Object.keys(op.parameters || (op.requestBody?.content || {}) || {}).length,
    });
    if (picked.length >= 6) break;
  }
  return picked;
}

function extract(url, dl) {
  if (dl.err) return { err: dl.err, code: dl.code, ct: dl.ct };
  const ct = String(dl.ct || '');
  const looksYaml = ct.includes('yaml') || /\.ya?ml($|\?)/i.test(url) || /^openapi:|^swagger:/m.test(String(dl.text || '').slice(0, 200));
  if (looksYaml) return { err: 'yaml-skipped', code: dl.code, ct, bytes: dl.bytes };
  let doc;
  try { doc = JSON.parse(dl.text); } catch { return { err: dl.truncated ? 'too-large' : 'not-json', code: dl.code, ct, bytes: dl.bytes }; }
  if (!doc || typeof doc !== 'object') return { err: 'not-object', code: dl.code, ct };
  const kind = kindsOf(doc);
  if (!kind) return { err: 'no-openapi-marker', code: dl.code, ct, bytes: dl.bytes };
  const pathCount = doc.paths && typeof doc.paths === 'object' ? Object.keys(doc.paths).length : 0;
  if (!pathCount) return { err: 'no-paths', code: dl.code, ct, kind };
  return {
    kind,
    code: dl.code,
    ct,
    bytes: dl.bytes,
    title: String(doc.info?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    specVersion: String(doc.info?.version || '').slice(0, 24),
    pathCount,
    servers: serversOf(doc, kind),
    schemes: schemesOf(doc, kind),
    operations: pathsOf(doc),
    globalSecurity: Array.isArray(doc.security) ? doc.security.flatMap((o) => Object.keys(o || {})).slice(0, 6) : [],
  };
}

const results = new Map();
const fh = RETRY.length ? null : fs.openSync(OUT, 'a');
let i = 0; let ok = 0; let errs = 0; let yaml = 0;
const t0 = Date.now();
async function worker() {
  while (i < work.length) {
    const c = work[i++];
    const dl = await download(c.spec);
    const x = extract(c.spec, dl);
    const line = { spec: c.spec, pages: c.pages, via: c.via, harvestedAt: HARVESTED, rewrote: !!dl.rewrote, ...x };
    if (x.err) { errs++; if (x.err === 'yaml-skipped') yaml++; } else ok++;
    if (fh) fs.appendFileSync(fh, JSON.stringify(line) + '\n'); else results.set(line.spec, line);
    if (i % 25 === 0 || i === work.length) {
      console.log(`  ${i}/${work.length} · 可用 ${ok} · 不可用 ${errs}（其中 yaml ${yaml}）· ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
if (fh) fs.closeSync(fh);
let turned = 0;
if (RETRY.length) {
  /* 整行换掉，不 Object.assign：老行里那个 `err` 要是留着，回捞成功的规范会被下一趟当"不可用"扔掉。 */
  const outRows = priorRows.map((r) => {
    const rep = results.get(r.spec);
    if (!rep) return r;
    if (!rep.err) turned++;
    return rep;
  });
  fs.writeFileSync(OUT, outRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
console.log(`[本趟 ${work.length} 发 · 可用 ${ok} · 不可用 ${errs}（yaml 跳过 ${yaml}）${RETRY.length ? ` · 回捞转可用 ${turned}` : ''}`
  + ` · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 累计行数 ${(RETRY.length ? priorRows.length : done.size + work.length)} · 产物 ${OUT}]`);
