/* tmp/ac-geom.mjs —— 图纸的几何复核（S5 通道的第一版）：headless Chrome + CDP 量 rect，不看感觉。
   跑法：node tmp/ac-geom.mjs [宽1 宽2 ...]（默认 1440 1080 900 720）。用完即删，产物是 stdout 读数。 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { connect } from './cdp-lib.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9223;
let PAGE = 'about:blank';
const SHOT_DIR = 'F:\\dsh-plugins\\dsh-plugin-api-catalog\\tmp\\_acshot';
const WIDTHS = (process.argv.slice(2).length ? process.argv.slice(2) : ['1440', '1080', '900', '720']).map(Number);

const profile = fs.mkdtempSync(`${fs.realpathSync(os.tmpdir())}/ac-geom-`);
const proc = cp.spawn(CHROME, [
  '--headless=old', `--remote-debugging-port=${PORT}`, '--allow-file-access-from-files', '--disable-gpu',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const probe = (idx) => {
  const sec = document.querySelectorAll('section.shot')[idx];
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const out = { cap: sec.querySelector('.cap b').textContent };
  const root = sec.querySelector('.ac-root');
  out.root = r(root);
  out.rootOverflows = root.scrollWidth > root.clientWidth + 1;
  const shell = document.querySelector('.proto').getBoundingClientRect();
  out.insideShell = root.getBoundingClientRect().left >= shell.left - 1 && root.getBoundingClientRect().right <= shell.right + 1;
  const tbl = sec.querySelector('.ac-tbl');
  if (tbl) {
    out.table = r(tbl);
    out.cols = [...tbl.querySelectorAll('col')].map((c) => Math.round(c.getBoundingClientRect().width));
    const trs = [...tbl.querySelectorAll('tbody tr')];
    const headTh = [...tbl.querySelectorAll('thead th')];
    const headCells = headTh.map((t) => r(t).w);
    // fixed 布局 + nowrap：文字比"格子减内边距"宽就是画到了隔壁格子脸上。
    // （不能用 scrollWidth：table 单元格上它恒等于 clientWidth，量不出溢出。）
    out.headClip = headTh.map((t) => {
      const cs = getComputedStyle(t);
      const inner = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const rg = document.createRange(); rg.selectNodeContents(t);
      const tw = Math.round(rg.getBoundingClientRect().width);
      return { t: t.textContent.trim(), inner, tw, over: tw - inner };
    });
    const firstData = trs.find((t) => !t.classList.contains('ac-detail-row'));
    out.cells = { head: headCells, row: firstData ? [...firstData.children].map((t) => r(t).w) : [] };
    const dIdx = trs.findIndex((t) => t.classList.contains('ac-detail-row'));
    if (dIdx >= 0) {
      out.detailRow = { at: dIdx, of: trs.length, rect: r(trs[dIdx]), follows: r(trs[dIdx - 1]).y + r(trs[dIdx - 1]).h === r(trs[dIdx]).y };
      const td = trs[dIdx].children[0];
      out.detailSpansTable = Math.abs(td.getBoundingClientRect().width - out.table.w) <= 1;
      const ta = trs[dIdx].querySelector('textarea');
      const fields = [...trs[dIdx].querySelectorAll('.ac-field')];
      out.fields = fields.map((f) => ({ w: r(f).w, y: r(f).y, kids: [...f.children].map((c) => ({ tag: c.tagName.toLowerCase(), w: r(c).w, h: r(c).h })) }));
      out.fieldsSideBySide = fields.length === 2 && (() => {
        const a = r(fields[0]), c = r(fields[1]);
        // 同一行 = 第二个从右边开始且两者底边对齐（.ac-fields 是 align-items:flex-end，顶边不等不算分行）。
        return c.x >= a.x + a.w - 1 && Math.abs((a.y + a.h) - (c.y + c.h)) <= 1;
      })();
      if (ta) {
        out.textarea = r(ta);
        out.textareaRowsPx = Math.round(parseFloat(getComputedStyle(ta).lineHeight) * Number(ta.rows) + 12);
        out.textareaTooTall = out.textarea.h > out.textareaRowsPx + 8;
        out.textareaOverflowsCell = out.textarea.x + out.textarea.w > td.getBoundingClientRect().x + td.getBoundingClientRect().width + 1;
      }
    }
    out.rowH = trs.filter((t) => !t.classList.contains('ac-detail-row')).slice(0, 3).map((t) => r(t).h);
  }
  const top = sec.querySelector('.ac-topbar');
  if (top) out.topbar = { pos: getComputedStyle(top).position, rect: r(top) };
  // 2026-10-05 用户走查那两条（「滚动框要拉到底」/「右边那栏不能滚动」）先量再改：
  // 分类栏那一坨的高度、它自己是否被 max-height 截出内滚、离根底边还差多少 px。
  const rail = sec.querySelector('.ac-rail');
  if (rail) {
    const list = rail.querySelector('.ac-rail-list');
    const lr = list ? r(list) : null;
    const ens = [...rail.querySelectorAll('.ac-rail-i span.en')];
    out.rail = {
      rect: r(rail),
      list: lr && { w: lr.w, h: lr.h, scrollH: list.scrollHeight, clientH: list.clientHeight, clipped: list.scrollHeight > list.clientHeight + 1 },
      items: rail.querySelectorAll('.ac-rail-i').length,
      enCount: ens.length,
      enZeroWidth: ens.filter((e) => r(e).w <= 0).length,
      gapToRootBottom: Math.round(out.root.y + out.root.h - ((lr ? lr.y + lr.h : r(rail).y + r(rail).h))),
    };
  }
  const main = sec.querySelector('.ac-main');
  if (main) {
    const mr = r(main);
    out.main = { w: mr.w, h: mr.h, scrollH: main.scrollHeight, clientH: main.clientHeight, scrolls: main.scrollHeight > main.clientHeight + 1, overflowY: getComputedStyle(main).overflowY };
  }
  return out;
};

const b = await connect(PORT);
for (const w of WIDTHS) {
  await b.viewport(w, 900);
  console.log(`\n===== 视口 ${w}×900 =====`);
  for (const f of fs.readdirSync(SHOT_DIR).filter((x) => x.endsWith('.html')).sort()) {
    await b.goto(`file:///${SHOT_DIR.replace(/\\/g, '/')}/${f}`);
    const one = await b.eval(probe, 0);
    const flat = JSON.stringify(one, (k, v) => (k === 'cap' ? undefined : v));
    console.log(`${f.replace(/\.html$/, '')} → ${flat}`);
  }
}
b.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 还攥着 profile：无害 */ }
