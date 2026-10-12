/**
 * tmp/mut_ac09.mjs —— 证伪"详情改弹框"这一批改判：每条变异还原一个坏现场，看它挂哪一条。
 * 脚手架口径与 tmp/mut_desczh.mjs、mut_ac08.mjs 同：锚点恰好一次、改动必须落地、
 * 没跑出汇总行算崩不算抓住、默认判"没抓住"。
 * 跑法：node tmp/mut_ac09.mjs   |   MUT_ONLY=M4,M5 node tmp/mut_ac09.mjs
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FILE = 'client.js';
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 12);
const run = (a, args) => spawnSync(a, args, { encoding: 'utf8' });
const original = fs.readFileSync(FILE, 'utf8');
const baseSha = sha(Buffer.from(original));

const MASK_RENDER = `        tab === 'catalog' && detailEl
          ? h(DetailModal, { key: 'detail-modal',`;
const INNER_GUARD = `        onClick: (e) => { if (e && e.target !== e.currentTarget) return; onClose(); },`;
const EFFECT = `        return () => document.removeEventListener('keydown', onKey);`;
const LIST_CSS = `.ac-main>.ac-card>.ac-list,.ac-main>.ac-card>.ac-cardfill{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}`;

const MUTS = [
  {
    id: 'M1', name: '顶栏把 sticky 写回来（v3 已判掉的那一发）', expect: ['cl-11c', 'cl-39'],
    edits: [['.ac-topbar{background:var(--ac-card);flex:none;', '.ac-topbar{position:sticky;top:0;z-index:2;background:var(--ac-card);flex:none;']],
  },
  {
    id: 'M2', name: '列表里再开一层滚动（名单外的第二发）', expect: ['cl-39'],
    edits: [[LIST_CSS, LIST_CSS + '\n.ac-li{overflow-y:auto}']],
  },
  {
    id: 'M3', name: '遮罩之外又多一发 fixed（卡头盖住内容）', expect: ['cl-36', 'hc-20'],
    edits: [['.ac-card-h{display:flex;', '.ac-card-h{position:fixed;display:flex;']],
  },
  {
    id: 'M4', name: '对话框不请自来（没点行也渲染遮罩）', expect: ['cl-36'],
    edits: [[MASK_RENDER, `        tab === 'catalog'
          ? h(DetailModal, { key: 'detail-modal',`]],
  },
  {
    id: 'M5', name: '去掉"点框内不算点框外"的守卫', expect: ['cl-19b'],
    edits: [[INNER_GUARD, `        onClick: () => onClose(),`]],
  },
  {
    id: 'M6', name: 'keydown 监听器不摘（每开一框多挂一个）', expect: ['cl-19b'],
    edits: [[EFFECT, `        return undefined;`]],
  },
  {
    id: 'M7', name: '改用原生 dialog 标签（宿主样式会往里塞东西）', expect: ['cl-36'],
    edits: [[`      }, h('div', {
        className: 'ac-modal', role: 'dialog',`, `      }, h('dialog', {
        className: 'ac-modal', role: 'dialog',`]],
  },
  {
    id: 'M8', name: '详情又插回列表那一格（旧口径复活）', expect: ['cl-19', 'cl-19b'],
    edits: [[`      return h('div', { className: 'ac-list' }, kids,`,
      `      kids.push(h('div', { key: 'x-detail', className: 'ac-detail' }, h('div', { className: 'ac-detail-in' }, '假详情')));\n      return h('div', { className: 'ac-list' }, kids,`],
    [`.ac-detail-in{display:flex;flex-direction:column;gap:10px;min-width:0}`,
      `.ac-detail{display:flex}\n.ac-detail-in{display:flex;flex-direction:column;gap:10px;min-width:0}`]],
  },
  {
    id: 'M9', name: '等价变异：遮罩透明度从 26% 改 30%（没有任何判据钉这个数）', equivalent: true,
    expect: ['（无）'],
    edits: [['color-mix(in srgb,var(--ac-fg) 26%,transparent)', 'color-mix(in srgb,var(--ac-fg) 30%,transparent)']],
  },
];

let missed = 0; let uncovered = 0;
const only = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
try {
  for (const m of MUTS) {
    if (only.length && !only.includes(m.id)) continue;
    let text = original;
    for (const [from, to] of m.edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`${m.id} 锚点命中 ${n} 次（要恰好 1 次）：${from.slice(0, 40)}`);
      text = text.replace(from, to);
    }
    if (text === original) throw new Error(`${m.id} 改动没落地（替换前后一模一样）`);
    fs.writeFileSync(FILE, text);
    const suites = ['client', 'host-compat'];
    const lines = []; const failed = [];
    for (const s of suites) {
      const r = run('node', [`test/${s}.test.mjs`]);
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const passLine = (out.match(new RegExp(`\\[${s}\\] pass \\d+ / fail \\d+ / skip \\d+`)) || [''])[0];
      if (!passLine) throw new Error(`${m.id} 套件 ${s} 没跑出汇总行（多半崩了，不是判据挂）：\n${out.slice(0, 600)}`);
      lines.push(passLine);
      for (const f of (out.match(/^FAIL (.*)$/gm) || [])) failed.push(f.slice(5));
    }
    const caught = m.expect.filter((e) => failed.some((f) => f.includes(e)));
    const ok = m.equivalent ? caught.length === 0 : caught.length === m.expect.length;
    if (!ok) { if (m.equivalent) uncovered++; else missed++; }
    console.log(`${caught.length ? '红（抓住 ' + caught.join('、') + '）' : m.equivalent ? '灰（等价变异·无判据钉这发）' : '绿（漏网）'} ${m.id} ${m.name}`);
    console.log(`   ${lines.join(' · ')}`);
    if (!m.equivalent && caught.length !== m.expect.length) {
      console.log(`   ★ 该挂的 ${m.expect.join('、')} 里只挂上了这些；其余没挂 = 判据覆盖不到这个现场`);
    }
  }
} finally {
  fs.writeFileSync(FILE, original);
  const now = sha(fs.readFileSync(FILE));
  console.log(`[还原 ${now === baseSha ? 'ok' : '★ 失败 ★'}（sha ${baseSha} → ${now}）· 漏网 ${missed} · 等价但无判据 ${uncovered}]`);
  if (now !== baseSha || missed) process.exitCode = 1;
}
