/* tmp/ac-scroll.mjs —— 滚动现场复核 v3：把图纸（tmp/_acshot/*.html，每份一个状态）放进**照抄宿主的格子**里量。
   要回答的是用户 2026-10-06 的两句：
     ①「显示不全，为什么不能滚动」→ 内容必须够得着（要么本来就在一屏里，要么有一层能滚到）。
     ②「这个框不要滚动，只滚动下面这个框」→ 搜索框/筛选条/顶栏在滚到底之后仍要完整落在格子里。
   所以这一版把 v2 的判据整个换了方向：v2 量"根能不能滚"，v3 量"根**不许**滚、只有内容区那几发能滚"。
   跑法：node test/make-prototype.mjs && node tmp/ac-shots.mjs && node tmp/ac-scroll.mjs [高1 高2 ...]
   产物是 stdout 读数，落 docs/design-spec.md 台账。用完即删。 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { connect } from './cdp-lib.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224;
const SHOT_DIR = 'F:\\dsh-plugins\\dsh-plugin-api-catalog\\tmp\\_acshot';
// 格子高度 = 宿主那一格给插件根的实际高度。真机那一屏（用户截图）量出来约 870，两档矮窗口是压力测试。
const HEIGHTS = (process.argv.slice(2).length ? process.argv.slice(2) : ['870', '700', '520']).map(Number);
const WIDTHS = [1440, 1080, 720];

const profile = fs.mkdtempSync(`${fs.realpathSync(os.tmpdir())}/ac-scroll-`);
const proc = cp.spawn(CHROME, [
  '--headless=old', `--remote-debugging-port=${PORT}`, '--allow-file-access-from-files', '--disable-gpu',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const probe = (cellH) => {
  const sec = document.querySelector('section.shot');
  const cell = sec.querySelector('.hostcell');
  cell.style.setProperty('--cell-h', cellH + 'px');
  const root = sec.querySelector('.ac-root');
  const cls = (el) => (el.className || el.tagName).toString().split(' ')[0];
  const cb = () => cell.getBoundingClientRect();
  const inCell = (e) => { const b = e.getBoundingClientRect(); return b.top >= cb().top - 1 && b.bottom <= cb().bottom + 1; };
  const scrollportBottom = (el) => {
    const cs = getComputedStyle(el);
    return el.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom || '0') - parseFloat(cs.borderBottomWidth || '0');
  };
  const scrollers = [...root.querySelectorAll('*')].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY));
  const active = scrollers.filter((el) => el.scrollHeight > el.clientHeight + 1);
  // 嵌套：一层滚动容器里不许再套一层（滚轮会被两层都不消费）。栏与列表是**兄弟**，这一条才成立。
  const nested = [];
  for (const a of active) for (const b2 of active) if (a !== b2 && a.contains(b2)) nested.push(`${cls(a)}>${cls(b2)}`);
  // ★ 漏网之鱼这一族：overflow:hidden 的盒子被内容顶出去 = 那一段永远看不见。
  //   根不裁（它自己不滚）、活动滚动容器也裁不到 —— 但**中间那一环**（结果卡）如果没被 min-height:0 钉住，
  //   它会按内容长高、被父级 hidden 掉，而根的 scrollHeight 只量直接子项的盒子，报不出这件事。
  //   第二版探针就只量了根，F2 那一次证伪因此一片绿。
  const orphanClips = [...root.querySelectorAll('*')]
    .filter((el) => /hidden|clip/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1
      && el.clientHeight > 0)
    .map((el) => `${cls(el)}(${el.scrollHeight}>${el.clientHeight})`);
  const PINNED = ['.ac-topbar', '.ac-tools', '.ac-filters', '.ac-rail-h'];
  // ★ 常驻的那几条分两档：两栏（row）下顶栏 + 搜索框 + 筛选条 + 栏标题全都不许跟着滚走（用户那一句）；
  //   塌成一列（<960px）时"筛选常驻 + 列表单独滚"在一列里放不下 —— 那一档由 .ac-cat 整块滚，
  //   只有顶栏还常驻。这不是漏判，是 cl-39 分配表里写明的两档。
  const rowLayout = getComputedStyle(root.querySelector('.ac-cat') || root).flexDirection === 'row';
  const pinned = () => PINNED.filter((s) => root.querySelector(s))
    .filter((s) => s === '.ac-topbar' || rowLayout)
    .map((s) => `${s}${inCell(root.querySelector(s)) ? '' : ':OUT'}`);
  const out = {
    cap: sec.querySelector('.cap b').textContent,
    cell: { h: cell.clientHeight, overflowY: getComputedStyle(cell).overflowY },
    root: {
      h: Math.round(root.getBoundingClientRect().height), clientH: root.clientHeight, scrollH: root.scrollHeight,
      overflowY: getComputedStyle(root).overflowY,
      // 比 clientHeight 不比 rect：格子自带 1px 边框，rect 会多出 2px。
      fillsCell: Math.abs(root.getBoundingClientRect().height - cell.clientHeight) <= 1,
      // 根是 overflow:hidden：它一溢出就是"内容拿不到"，v2 那个 bug 的现场就是这一条为真。
      clips: root.scrollHeight > root.clientHeight + 1,
      scrollable: /(auto|scroll)/.test(getComputedStyle(root).overflowY),
      cellClips: cell.scrollHeight > cell.clientHeight + 1,
    },
    scrollers: scrollers.map(cls),
    orphanClips,
    layout: rowLayout ? 'row' : 'column',
    activeScrollers: active.map(cls),
    nested,
    pinnedBefore: pinned(),
    kids: [...root.children].map((el) => ({
      cls: cls(el), h: Math.round(el.getBoundingClientRect().height), flex: getComputedStyle(el).flexShrink,
    })),
  };
  // 每一发活动滚动容器：滚到底，量"最后一块够得着" + "常驻的那几条还在格子里"
  out.scrolled = active.map((el) => {
    el.scrollTop = el.scrollHeight;
    const tail = [...el.querySelectorAll('.ac-li, .ac-morebar, .ac-tl li, .ac-empty, .ac-card-b')].pop() || el.lastElementChild;
    const tb = tail.getBoundingClientRect();
    const r = {
      via: cls(el), scrollTop: Math.round(el.scrollTop), tail: cls(tail),
      tailBottomInScrollport: Math.round(scrollportBottom(el) - tb.bottom),
      tailReachable: tb.bottom <= scrollportBottom(el) + 2,
    };
    el.scrollTop = 0;
    return r;
  });
  // 滚到底之后再量一次常驻（这才是用户那一句"这个框不要滚动"的现场）
  active.forEach((el) => { el.scrollTop = el.scrollHeight; });
  out.pinnedAfter = pinned();
  out.railAt0 = (() => {
    const rail = root.querySelector('.ac-rail');
    if (!rail) return null;
    const list = rail.querySelector('.ac-rail-list');
    const rows = [...rail.querySelectorAll('.ac-rail-i')];
    rail.scrollTop = 0; if (list) list.scrollTop = 0;
    const visible = rows.filter(inCell).length;
    return {
      items: rows.length, itemsInCell: visible,
      listH: Math.round(list.getBoundingClientRect().height), listScrollH: list.scrollHeight,
      // 装不下就必须**能滚**：裁掉又滚不到是这一族最坏的形状（第一代 max-height 那个 bug）。
      // 塌成一列那一档另说：栏整条摊在 .ac-cat 里，够不够得着由 .ac-cat 那发滚动负责（见上面两档说明）。
      scrollable: /(auto|scroll)/.test(getComputedStyle(list).overflowY) && list.scrollHeight > list.clientHeight + 1,
      ok: !rowLayout || visible === rows.length
        || (/(auto|scroll)/.test(getComputedStyle(list).overflowY) && list.scrollHeight > list.clientHeight + 1),
    };
  })();
  // ★ 最后一道、也是最贴用户那一句的判据：**列表的尾巴够不够得着**。
  //   它不是"根溢不溢出"也不是"hidden 盒子裁没裁内容" —— F2 那一次（结果卡没 min-height:0）两条都不报，
  //   因为卡按内容长高、.ac-list 也就不觉得自己溢出，于是"没有任何一层能滚到最后一行"这件事在数上一片绿。
  //   只有直接量那一行的底边落没落在格子/某个真能滚的容器里，才抓得到。
  const tailEl = [...root.querySelectorAll('.ac-li, .ac-morebar, .ac-tl li, .ac-empty')].pop();
  out.tail = tailEl ? {
    cls: cls(tailEl), inCell: inCell(tailEl), coveredByScroller: active.some((a) => a.contains(tailEl)),
  } : null;
  active.forEach((el) => { el.scrollTop = 0; });
  return out;
};

const b = await connect(PORT);
let bad = 0;
for (const w of WIDTHS) {
  for (const cellH of HEIGHTS) {
    await b.viewport(w, cellH + 100);
    console.log(`\n===== 视口 ${w}×${cellH + 100} / 格子高 ${cellH} =====`);
    for (const f of fs.readdirSync(SHOT_DIR).filter((x) => x.endsWith('.html')).sort()) {
      await b.goto(`file:///${SHOT_DIR.replace(/\\/g, '/')}/${f}`);
      const one = await b.eval(probe, cellH);
      const ok = one.root.fillsCell && !one.root.clips && !one.root.scrollable && !one.root.cellClips
        && one.orphanClips.length === 0
        && (!one.tail || one.tail.inCell || one.tail.coveredByScroller)
        && one.nested.length === 0
        && one.pinnedAfter.length === one.pinnedBefore.length && !one.pinnedAfter.some((s) => s.endsWith(':OUT'))
        && one.scrolled.every((s) => s.tailReachable)
        && one.kids.every((k) => k.h > 4)
        && (!one.railAt0 || one.railAt0.ok);
      if (!ok) bad++;
      console.log(`${ok ? 'ok  ' : 'BAD '} ${f.replace(/\.html$/, '')} ${JSON.stringify(one)}`);
    }
  }
}
console.log(`\n[坏 ${bad} 屏]`);
b.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 还攥着 profile：无害 */ }
