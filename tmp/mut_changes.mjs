/**
 * tmp/mut_changes.mjs —— 证伪 2026-10-06 这一轮「变更页只留变更记录列表」：
 *  ① 卡名与两处话术（标题、空态、卡头那句「库里最多 N 行」）；
 *  ② 「解析台账」那张卡撤干净没有（界面一处、载荷两处：首屏 payload 与每轮快照）；
 *  ③ 撤卡不许把降级那句话一起撤掉（页头 ac-capsline 那一发）。
 * 脚手架口径同 mut_usage / mut_sig / mut_ac09：锚点恰好命中一次、改动必须落地、
 * 没跑出汇总行算「崩」不算「抓住」、expect 里每一条都得挂、默认判「没抓住」、
 * 写回之前先 `node --check` 一份副本（防"崩了当成抓住"）。
 * 跑法：node tmp/mut_changes.mjs   |   MUT_ONLY=C3,C6 node tmp/mut_changes.mjs
 * ★ 跑的这一段时间里**不要**去读树（别复跑别的套件、别算 sha）：源文件在被逐条改写再还原。
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

const C27 = 'cl-27';
const C35 = 'cl-35';
const C7 = 'cl-7';
const HC12 = 'hc-12';
const HC14 = 'hc-14';
const HC16 = 'hc-16';
const HC18 = 'hc-18';
const SNAP = 'GET /api/snapshot：信封';

const MUTS = [
  {
    id: 'C1', suites: ['client'], file: 'client.js', name: '卡名写回「差分流水」（用户点名的那两个字）', expect: [C27],
    edits: [["            h('span', { className: 'ac-card-t' }, '变更记录'),",
      "            h('span', { className: 'ac-card-t' }, '差分流水'),"]],
  },
  {
    id: 'C2', suites: ['client'], file: 'client.js', name: '卡头把「（库里最多 200 行）」写回屏幕', expect: [C27],
    edits: [["没地方能翻到第 201 行。\n            h('span', { className: 'ac-card-n ac-num' }, `${(rows || []).length} 条`)),",
      "没地方能翻到第 201 行。\n            h('span', { className: 'ac-card-n ac-num' }, `${(rows || []).length} 条（库里最多 200 行）`)),"]],
  },
  {
    id: 'C3', suites: ['client'], file: 'client.js', name: '「解析台账」那张卡又摆回变更页（只改标题不撤卡）', expect: [C27, C35],
    edits: [["          h('p', { className: 'ac-note' }, '只记本机看到的差别；上游删了条目时批注不跟着删，留在「我的笔记」里。')));",
      "          h('p', { className: 'ac-note' }, '只记本机看到的差别；上游删了条目时批注不跟着删，留在「我的笔记」里。')),\n        h('div', { className: 'ac-card' }, h('span', { className: 'ac-card-t' }, '解析台账（最近一轮原文）'), h('span', null, '要过代理请用 --use-env-proxy 启动宿主。')));"]],
  },
  {
    id: 'C4', suites: ['client'], file: 'client.js', name: '设置页又挂一句指向已撤那张卡的提示（挪走没清指针）', expect: [C35],
    edits: [["其中上游已删 ${fmtCount(snap?.notes?.orphan)} 条。`))));",
      "其中上游已删 ${fmtCount(snap?.notes?.orphan)} 条。`),\n            h('div', { className: 'ac-sub' }, '跑在哪、为什么没有某个按钮 —— 那些在「变更」页签的解析台账里。'))));"]],
  },
  {
    id: 'C5', suites: ['client'], file: 'client.js', name: '撤卡顺手把页头那句降级也撤了（存储坏了屏幕上一句都不说）', expect: [C35, C7],
    edits: [["          capsBad.length\n            ? h('div', { className: 'ac-capsline' }",
      "          false\n            ? h('div', { className: 'ac-capsline' }"]],
  },
  {
    id: 'C6', suites: ['client'], file: 'client.js', name: '空态话术写回「还没有流水」', expect: [C27],
    edits: [["'还没有变更记录：跑一轮同步，上游有增减才会往这里写。'", "'还没有流水：跑一轮同步，上游有增减才会往这里写。'"]],
  },
  {
    id: 'C7', suites: ['host-compat'], file: 'index.js', name: '首屏载荷又把 capabilityRows 推给浏览器（那张卡没了，读者也没了）', expect: [HC12, HC14, HC16, HC18],
    edits: [["        capabilities: caps.read(),",
      "        capabilities: caps.read(),\n        capabilityRows: [],"]],
  },
  {
    id: 'C8', suites: ['api'], file: 'lib/api.js', name: '每轮推的快照又把 capabilityRows 摊一份', expect: [SNAP],
    edits: [["    capabilities: deps.caps.read(),",
      "    capabilities: deps.caps.read(),\n    capabilityRows: [],"]],
  },
];

let missed = 0; let uncovered = 0; let broken = 0;
const only = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
try {
  for (const m of MUTS) {
    if (only.length && !only.includes(m.id)) continue;
    let text = sourceOf(m.file);
    for (const [from, to] of m.edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`${m.id} 锚点命中 ${n} 次（要恰好 1 次）：${from.slice(0, 48)}`);
      text = text.replace(from, to);
    }
    if (text === sourceOf(m.file)) throw new Error(`${m.id} 改动没落地（替换前后一模一样）`);
    const scratch = `tmp/_mut_${m.id}.js`;
    fs.writeFileSync(scratch, text);
    const chk = run('node', ['--check', scratch]);
    fs.rmSync(scratch, { force: true });
    if (chk.status !== 0) {
      broken++;
      console.log(`废 ${m.id} ${m.name}\n   ★ 变异本身把 ${m.file} 的语法改坏了，不算判据抓住：${String(chk.stderr).split('\n').slice(0, 3).join(' / ')}`);
      continue;
    }
    fs.writeFileSync(m.file, text);
    const lines = []; const failed = [];
    for (const s of m.suites) {
      const r = run('node', [`test/${s}.test.mjs`]);
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const passLine = (out.match(new RegExp(`\\[${s}\\] pass \\d+ / fail \\d+ / skip \\d+`)) || [''])[0];
      if (!passLine) throw new Error(`${m.id} 套件 ${s} 没跑出汇总行（多半崩了，不是判据挂）：\n${out.slice(0, 800)}`);
      lines.push(passLine);
      for (const f of (out.match(/^FAIL (.*)$/gm) || [])) failed.push(f.slice(5));
    }
    const caught = m.expect.filter((e) => failed.some((f) => f.includes(e)));
    const ok = m.equivalent ? caught.length === 0 : caught.length === m.expect.length;
    if (!ok) { if (m.equivalent) uncovered++; else missed++; }
    console.log(`${caught.length ? '红（抓住 ' + caught.join('、') + '）' : m.equivalent ? '灰（等价变异·无判据钉这发）' : '绿（漏网）'} ${m.id} ${m.name}`);
    console.log(`   ${lines.join(' · ')}`);
    if (!m.equivalent && caught.length !== m.expect.length) {
      console.log('   ★ 该挂的 ' + m.expect.join('、') + ' 里只挂上了这些；其余没挂 = 判据覆盖不到这个现场');
    }
  }
} finally {
  for (const [file, text] of originals) {
    fs.writeFileSync(file, text);
    console.log(`[还原 ${file} ${sha(Buffer.from(fs.readFileSync(file))) === sha(Buffer.from(text)) ? 'ok' : '★ 失败 ★'}]`);
  }
  console.log(`[变异 ${MUTS.length} 发 · 漏网 ${missed} · 等价但无判据 ${uncovered} · 变异自身语法坏 ${broken}]`);
  if (missed || uncovered || broken) process.exitCode = 1;
}
