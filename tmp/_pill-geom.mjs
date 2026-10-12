/* tmp/_pill-geom.mjs —— 量 U-19 那颗变长的状态 pill：页头标题行会不会折行、pill 会不会顶到「立即同步」。
   现场取真装配渲染出来的 .ac-head（不是手搓 HTML）：跑两轮同步让 lastStatus 落在 noChange，
   再把库存的 fetchedAt 拨回三小时前 ⇒ 屏幕上就是真机今天那一态「上次检查：源内容没变 · M/D HH:MM」。
   跑法：node tmp/_pill-geom.mjs [宽1 宽2 ...]（默认 1440 1080 900 720）。用完即删，产物是 stdout 读数。 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { mountServer, loadClient, byCls, textOf } from '../test/_client-harness.mjs';
import { DOMAIN_NAME, TABLES, META_KEY } from '../lib/domain.js';
import { connect } from './cdp-lib.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9243;
const WIDTHS = (process.argv.slice(2).length ? process.argv.slice(2) : ['1440', '1080', '900', '720']).map(Number);

/* ---- 1) 离线面现造一份"真机今天那一态"的页头，序列化成一份最小 HTML ---- */
const server = await mountServer();
await server.sync();
await server.sync();
const raw = server.facility.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
if (raw.lastStatus !== 'noChange') throw new Error(`夹具没造出 noChange 那一态：${raw.lastStatus}`);
server.facility.seed(DOMAIN_NAME, TABLES.meta, META_KEY, { ...raw, fetchedAt: raw.lastCheckedAt - 3 * 3600_000 });
const t = await loadClient(server);
await t.mountMain();
const head = byCls(t.tree(), 'ac-head')[0];
if (!head) throw new Error('页头没渲染出来');
const CSS = t.exports.__test.CSS;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ser = (n) => {
  if (n === null || n === undefined || n === false || n === '') return '';
  if (typeof n === 'string' || typeof n === 'number') return esc(n);
  if (n.tag === '#text') return esc(n.text ?? '');
  const attrs = `${n.props?.className ? ` class="${esc(n.props.className)}"` : ''}${n.props?.title ? ` title="${esc(n.props.title)}"` : ''}`;
  return `<${n.tag}${attrs}>${(n.children || []).map(ser).join('')}</${n.tag}>`;
};
const pillText = textOf(byCls(head, 'ac-pill')[0]);
fs.writeFileSync('tmp/_pill.html',
  `<!doctype html><meta charset="utf-8"><title>pill</title><style>${CSS}</style>`
  + `<body style="margin:0"><div class="ac-root" style="padding:12px">${ser(head)}</div></body>`);
t.unmount();
server.close();
console.log(`现场那一串：${JSON.stringify(pillText)}`);

/* ---- 2) headless Chrome 按视口量 rect ---- */
const profile = fs.mkdtempSync(`${fs.realpathSync(os.tmpdir())}/ac-pill-`);
const proc = cp.spawn(CHROME, [
  '--headless=old', `--remote-debugging-port=${PORT}`, '--allow-file-access-from-files', '--disable-gpu',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const b = await connect(PORT);
const probe = () => {
  const r = (el) => { const x = el.getBoundingClientRect(); return { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.width), h: Math.round(x.height) }; };
  const row = document.querySelector('.ac-title-row');
  const title = document.querySelector('.ac-title');
  const pill = document.querySelector('.ac-pill');
  const btn = document.querySelector('.ac-btn');
  const sub = document.querySelector('.ac-sub');
  const rr = r(row), tr = r(title), pr = r(pill), br = r(btn), sr = r(sub);
  return {
    rowH: rr.h, rows: Math.round(rr.h / Math.max(tr.h, pr.h)),
    // 同一行 = 垂直中心对齐（标题 16px、pill 12px + 内边距 ⇒ 两者高度本来就不同，比 y 会假红）。
    titleLine: Math.abs((tr.y + tr.h / 2) - (pr.y + pr.h / 2)) <= 2,
    pill: pr, btn: br,
    gapBtn: br.x - (pr.x + pr.w),
    pillRightInsideRow: pr.x + pr.w <= rr.x + rr.w + 1,
    subH: sr.h, subText: sub.textContent.trim(),
    pillOverflow: getComputedStyle(pill).whiteSpace,
    headScrolls: document.querySelector('.ac-root').scrollWidth > document.querySelector('.ac-root').clientWidth + 1,
  };
};
let bad = 0;
for (const w of WIDTHS) {
  await b.viewport(w, 900);
  await b.goto('file:///F:/dsh-plugins/dsh-plugin-api-catalog/tmp/_pill.html');
  const one = await b.eval(probe, 0);
  const ok = one.titleLine && one.gapBtn > 0 && !one.headScrolls && one.rows === 1;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : '坏  '} 视口 ${w} → 标题行 ${one.rowH}px（${one.rows} 行）· pill ${one.pill.w}px 与标题同一行=${one.titleLine} · 到「立即同步」还差 ${one.gapBtn}px · 副标题 ${one.subH}px · 横向溢出=${one.headScrolls}`);
  console.log(`        副标题：${one.subText}`);
}
b.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 还攥着 profile：无害 */ }
console.log(`\n[pill 走查 ${WIDTHS.length} 屏 / 坏 ${bad} 屏]`);
if (bad) process.exitCode = 1;
