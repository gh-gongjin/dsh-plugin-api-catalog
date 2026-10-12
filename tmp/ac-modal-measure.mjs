/* tmp/ac-modal-measure.mjs —— 详情弹框的几何走查：既量「每一块实际吃了多宽」（右边那片空白的读数），
   也按四条判据判红绿（框宽 / 字段一行一个 / 节题档位 / 那句批注时间的位置）。判据逐条的来历见下面 JUDGE。
   视口照抄真机那一屏：2160 物理像素 / 150% 缩放 ⇒ 1440×912 CSS。
   跑法：node test/make-prototype.mjs && node tmp/ac-shots.mjs && node tmp/ac-modal-measure.mjs */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { connect } from './cdp-lib.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9231;
const profile = fs.mkdtempSync(`${fs.realpathSync(os.tmpdir())}/ac-modal-`);
const proc = cp.spawn(CHROME, [
  '--headless=old', `--remote-debugging-port=${PORT}`, '--allow-file-access-from-files', '--disable-gpu',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1440,912', 'about:blank',
], { stdio: 'ignore' });

const measure = () => {
  const out = [];
  document.querySelectorAll('section.shot').forEach((sec, i) => {
    const modal = sec.querySelector('.ac-modal');
    if (!modal) return;
    const cap = sec.querySelector('b')?.textContent || `#${i}`;
    const mb = modal.getBoundingClientRect();
    const cs = getComputedStyle(modal);
    const innerL = mb.left + parseFloat(cs.paddingLeft);
    const innerW = mb.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const row = (el) => {
      const b = el.getBoundingClientRect();
      // 墨迹右界：块本身是 stretch 满宽的，量它没意义 —— 直接文本用 Range，叶子盒子（输入框/芯片/按钮）用自身 rect。
      let inkR = b.left;
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) {
          range.selectNode(n);
          inkR = Math.max(inkR, range.getBoundingClientRect().right);
        }
      }
      for (const d of el.querySelectorAll('*')) {
        if (d.children.length) continue;
        if (!d.textContent.trim() && !/^(INPUT|TEXTAREA|BUTTON)$/.test(d.tagName)) continue;
        inkR = Math.max(inkR, d.getBoundingClientRect().right);
      }
      return {
        cls: (el.className || el.tagName).toString().split(' ')[0],
        w: Math.round(b.width), h: Math.round(b.height), inkW: Math.round(inkR - b.left),
        fill: ((inkR - innerL) / innerW * 100).toFixed(0),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 16),
      };
    };
    const in_ = modal.querySelector('.ac-detail-in');
    /* ★ 判据（不是读数）：这四条各钉 S14 的一处改判，任何一条挂了这一屏就算坏。
       ① 框宽跟着内容收（>560 就是又拿编辑器当尺子）；
       ② 两个批注字段一行一个（并排 = 内宽被 flex-basis 撑回去）；
       ③ 节题必须比补充说明那行**严格更深**一档（faint 的节题在真机上看着像灰掉的正文，锚点失效；
         「相等」也算挂 —— 那一发正是 M3 那轮回炉时探针自己的漏网）；
       ④ 那句「上次改于 / 还没有批注」贴行尾，且与主按钮之间留出可分辨的空隙（粘着就像按钮的第二行字）。 */
    const rects = (sel, root = modal) => [...root.querySelectorAll(sel)].map((el) => el.getBoundingClientRect());
    const fields = rects('.ac-fields > .ac-field');
    const meta = [...modal.querySelectorAll('.ac-row > .ac-faint')].pop();
    const save = [...modal.querySelectorAll('.ac-btn-primary')].pop();
    const lum = (c) => { const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c); return m ? (+m[1] + +m[2] + +m[3]) / 3 : -1; };
    const secT = modal.querySelector('.ac-sec-t');
    const faintRow = modal.querySelector('.ac-faint');
    out.push({
      cap,
      flags: {
        modalW: Math.round(mb.width),
        stacked: fields.length < 2 ? null : Math.round(fields[1].top - fields[0].bottom),
        secTDarker: secT && faintRow ? lum(getComputedStyle(secT).color) < lum(getComputedStyle(faintRow).color) : null,
        metaFlush: meta ? Math.round(meta.parentElement.getBoundingClientRect().right - meta.getBoundingClientRect().right) : null,
        metaGapFromPrimary: meta && save ? Math.round(meta.getBoundingClientRect().left - save.getBoundingClientRect().right) : null,
      },
      modal: { w: Math.round(mb.width), h: Math.round(mb.height), innerW: Math.round(innerW), maxW: cs.maxWidth, maxH: cs.maxHeight, scrollH: modal.scrollHeight },
      gap: getComputedStyle(in_).gap,
      blocks: [...in_.children].map(row),
      secs: [...modal.querySelectorAll('.ac-sec')].map((s) => ({
        t: (s.querySelector('.ac-sec-t')?.textContent || '(无节题)').trim(),
        kids: [...s.children].filter((c) => !c.classList.contains('ac-sec-t')).map(row),
      })),
    });
  });
  return out;
};

const JUDGE = (f) => {
  const bad = [];
  if (f.modalW > 560) bad.push(`框宽 ${f.modalW}：又拿编辑器当尺子（>560）`);
  if (f.stacked !== null && f.stacked < 0) bad.push(`两个批注字段并排（第二格顶边比第一格底边高 ${-f.stacked}px）`);
  if (f.secTDarker === false) bad.push('节题没有比补充说明那行深一档（同档或更浅）：四节的锚点读不出来');
  if (f.metaFlush !== null && f.metaFlush > 2) bad.push(`批注时间那句没贴行尾（右边还差 ${f.metaFlush}px）`);
  if (f.metaGapFromPrimary !== null && f.metaGapFromPrimary < 24) bad.push(`那句离主按钮只有 ${f.metaGapFromPrimary}px：读起来像按钮的一部分`);
  return bad;
};

try {
  const cdp = await connect(PORT);
  await cdp.viewport(1440, 912);
  const dir = fs.realpathSync('tmp/_acshot');
  let screens = 0; const broken = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    await cdp.goto('file:///' + encodeURI(`${dir}\\${f}`.replace(/\\/g, '/')));
    for (const m of await cdp.eval(measure)) {
      screens++;
      const bad = JUDGE(m.flags);
      if (bad.length) broken.push(`${f.replace(/\.html$/, '')}：${bad.join('；')}`);
      console.log(`\n${bad.length ? '坏 ' : 'ok '} ${f.replace(/\.html$/, '')} · ${m.cap} —— 框宽 ${m.flags.modalW} · 字段行距 ${m.flags.stacked} · 节题深一档 ${m.flags.secTDarker} · 那句距行尾 ${m.flags.metaFlush} · 距主按钮 ${m.flags.metaGapFromPrimary}`);
      console.log(`  弹框 ${m.modal.w}×${m.modal.h}（内容 ${m.modal.scrollH}，max-height ${m.modal.maxH}），内宽 ${m.modal.innerW}，顶层节间距 ${m.gap}`);
      for (const b of m.blocks) console.log(`  顶层 ${b.cls.padEnd(11)} ${String(b.w).padStart(4)}×${String(b.h).padStart(3)}  墨迹 ${String(b.inkW).padStart(4)}  占内宽 ${String(b.fill).padStart(3)}%  ${b.text}`);
      for (const s of m.secs) {
        console.log(`  节「${s.t}」`);
        for (const k of s.kids) console.log(`      ${k.cls.padEnd(11)} ${String(k.w).padStart(4)}×${String(k.h).padStart(3)}  墨迹 ${String(k.inkW).padStart(4)}  占内宽 ${String(k.fill).padStart(3)}%  ${k.text}`);
      }
    }
  }
  console.log(`\n[弹框走查 ${screens} 屏 / 坏 ${broken.length} 屏]`);
  for (const b of broken) console.log('  ★ ' + b);
  if (broken.length) process.exitCode = 1;
  cdp.close();
} finally {
  proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 上 Chrome 刚退，目录锁着 —— 探针不靠删目录说话 */ }
}
