/**
 * tmp/mut_modal.mjs —— 证伪 2026-10-06 S14「详情弹框按内容收宽」那一轮的四条几何判据 + 2026-10-07 撤掉的那枚按钮。
 * M1..M4 跑的不是套件，是**无头几何走查** tmp/ac-modal-measure.mjs ——
 * 布局改判住在 CSS 里，DOM 夹具没有排版引擎，量 rect 的那一发才算自己的现场。
 * M5 是 DOM 那一类（`suite: 'client'`）：撤掉的控件不许被"顺手加回来"，挂 cl-50。
 * 脚手架口径同 mut_changes：锚点恰好命中一次、改动必须落地、写回前先 node --check、按 sha 还原；
 * 额外两条：探针没跑出汇总行算「崩」不算「抓住」；expect 里每一条红话都得出现。
 * 跑法：node tmp/mut_modal.mjs   |   MUT_ONLY=M1,M3 node tmp/mut_modal.mjs
 * ★ 跑的这一段时间里**不要**去读树（源文件在被逐条改写再还原；产物 tmp/_acshot 也是变异态）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 12);
const run = (a, args) => spawnSync(a, args, { encoding: 'utf8' });
const originals = new Map();
const sourceOf = (file) => {
  if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
  return originals.get(file);
};

const MUTS = [
  {
    id: 'M1', name: '框宽写回 680（拿编辑器那一行当尺子，右边又空一片）',
    expect: ['又拿编辑器当尺子'],
    edits: [['.ac-modal{box-sizing:border-box;width:100%;max-width:520px;', '.ac-modal{box-sizing:border-box;width:100%;max-width:680px;']],
  },
  {
    // ★ 这一发第一版写的是"旧 CSS 原样搬回来"（wrap + 两格各自 flex-basis 320/220）—— 在 520 的框里它自己就折成两行，
    //   探针报 ok，那是**等价变异**不是抓住，判据等于没钉。所以这里只留"并排且不换行"那一发：判据要挂在自己的现场上。
    id: 'M2', name: '两个批注字段并排（不换行，各占半宽）',
    expect: ['两个批注字段并排'],
    edits: [
      ['.ac-fields{display:flex;flex-direction:column;gap:9px;min-width:0}', '.ac-fields{display:flex;gap:10px;min-width:0}'],
    ],
  },
  {
    id: 'M3', name: '节题退回 faint（与补充说明同档，四节的锚点读不出来）',
    expect: ['没有比补充说明那行深一档'],
    edits: [['.ac-sec-t{font-size:11px;font-weight:600;color:var(--ac-muted);', '.ac-sec-t{font-size:11px;font-weight:600;color:var(--ac-faint);']],
  },
  {
    id: 'M4', name: '那句「上次改于 / 还没有批注」不再推右（又贴着黑色主按钮）',
    expect: ['没贴行尾'],
    edits: [["h('span', { className: 'ac-faint', style: { marginLeft: 'auto' } },", "h('span', { className: 'ac-faint' },"]],
  },
  {
    // 这一发量的不是几何，是 DOM：撤掉的按钮不许哪天被"顺手加回来"，所以挂 client 套件那一发（cl-50 里新钉的两句）。
    id: 'M5', name: '把「重新取」那枚按钮摆回出处那一行（2026-10-07 用户裁定撤掉的）', suite: 'client',
    expect: ['cl-50'],
    edits: [["          h('a', { className: 'ac-url', href: e.url, target: '_blank', rel: 'noreferrer noopener' }, e.url)),",
      "          h('a', { className: 'ac-url', href: e.url, target: '_blank', rel: 'noreferrer noopener' }, e.url),\n          h('button', { className: 'ac-mini', onClick: () => onClose() }, '重新取')),"]],
  },
];

let missed = 0; let broken = 0; let crashed = 0;
const only = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SUMMARY = /\[弹框走查 (\d+) 屏 \/ 坏 (\d+) 屏\]/;
try {
  for (const m of MUTS) {
    if (only.length && !only.includes(m.id)) continue;
    let text = sourceOf('client.js');
    for (const [from, to] of m.edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`${m.id} 锚点命中 ${n} 次（要恰好 1 次）：${from.slice(0, 48)}`);
      text = text.replace(from, to);
    }
    if (text === sourceOf('client.js')) throw new Error(`${m.id} 改动没落地（替换前后一模一样）`);
    const scratch = `tmp/_mut_${m.id}.js`;
    fs.writeFileSync(scratch, text);
    const chk = run('node', ['--check', scratch]);
    fs.rmSync(scratch, { force: true });
    if (chk.status !== 0) {
      broken++;
      console.log(`废 ${m.id} ${m.name}\n   ★ 变异本身把 client.js 的语法改坏了，不算判据抓住：${String(chk.stderr).split('\n').slice(0, 3).join(' / ')}`);
      continue;
    }
    fs.writeFileSync('client.js', text);
    if (m.suite) {
      // DOM 那一类判据：跑套件，汇总行没跑出来算「崩」不算「抓住」。
      const r = run('node', [`test/${m.suite}.test.mjs`]);
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const passLine = (out.match(new RegExp(`\\[${m.suite}\\] pass \\d+ / fail \\d+ / skip \\d+`)) || [''])[0];
      if (!passLine) {
        crashed++;
        console.log(`崩 ${m.id} ${m.name}\n   ★ 套件 ${m.suite} 没跑出汇总行（崩了不算抓住）：\n${out.slice(-700)}`);
        continue;
      }
      const failed = out.match(/^FAIL (.*)$/gm) || [];
      const caught = m.expect.filter((e) => failed.some((f) => f.includes(e)));
      const okS = caught.length === m.expect.length;
      if (!okS) missed++;
      console.log(`${okS ? '红（抓住 ' + caught.join('、') + '）' : '绿（漏网）'} ${m.id} ${m.name}`);
      console.log(`   ${passLine}`);
      if (!okS) console.log(`   ★ 该挂的 ${m.expect.join('、')} 里只挂上 ${caught.join('、') || '（一条都没挂）'} = 判据覆盖不到这个现场`);
      continue;
    }
    const steps = [['test/make-prototype.mjs'], ['tmp/ac-shots.mjs'], ['tmp/ac-modal-measure.mjs']];
    let out = ''; let crashedAt = '';
    for (const s of steps) {
      const r = run('node', s);
      out += `${r.stdout || ''}${r.stderr || ''}`;
      if (s[0].endsWith('ac-modal-measure.mjs') && !SUMMARY.test(out)) crashedAt = s[0];
    }
    const mt = out.match(SUMMARY);
    if (!mt || crashedAt) {
      crashed++;
      console.log(`崩 ${m.id} ${m.name}\n   ★ 探针没跑出汇总行（崩了不算抓住）：\n${out.slice(-700)}`);
      continue;
    }
    const reds = (out.match(/^  ★ .*$/gm) || []).map((l) => l.trim());
    const caught = m.expect.filter((e) => reds.some((r) => r.includes(e)));
    const ok = caught.length === m.expect.length && Number(mt[2]) > 0;
    if (!ok) missed++;
    console.log(`${ok ? '红（抓住 ' + caught.join('、') + '）' : '绿（漏网）'} ${m.id} ${m.name}`);
    console.log(`   走查 ${mt[1]} 屏 / 坏 ${mt[2]} 屏`);
    for (const r of reds) console.log(`   ${r}`);
    if (!ok) console.log(`   ★ 该挂的 ${m.expect.join('、')} 里只挂上 ${caught.join('、') || '（一条都没挂）'} = 判据覆盖不到这个现场`);
  }
} finally {
  for (const [file, text] of originals) {
    fs.writeFileSync(file, text);
    console.log(`[还原 ${file} ${sha(Buffer.from(fs.readFileSync(file))) === sha(Buffer.from(text)) ? 'ok' : '★ 失败 ★'}]`);
  }
  console.log(`[变异 ${MUTS.length} 发 · 漏网 ${missed} · 探针崩 ${crashed} · 变异自身语法坏 ${broken}]`);
  if (missed || crashed || broken) process.exitCode = 1;
}
