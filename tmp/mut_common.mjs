/**
 * tmp/mut_common.mjs —— 证伪 2026-10-07「常用API」这一页的两道裁定：
 *  ①「先只做壳」（不排名次、页签不挂数）②「这些废话去掉行不行」+ 落款「撤掉」（只剩读数一张卡，撤过的句子不许长回来）。
 * 这一轮的坏味道有两族：**没有出处却念出数**（写死 450、条件撤进悬停、快照没到念 0 条、卡头摆一串「前 N」），
 * 以及**撤干净的东西自己长回来**（加回解释卡、加回落款、加回第二枚芯片 = 第二个入口）。
 * 判据：cl-54（只许一张卡 + 撤掉的句子搜不到 + 没有名次样式 + 不开第二个入口）、cl-55（每一格逐字等于服务端那份，跑两份正文）、
 *      cl-56（`—` 与 `0 条` 不许混）、cl-10（五页签顺序 + 新页签不挂计数）。
 * 脚手架口径同 mut_changes / mut_usage：锚点恰好命中一次、改动必须落地、
 * 没跑出汇总行算「崩」不算「抓住」、expect 里每一条都得挂、默认判「没抓住」、
 * 写回之前先 `node --check` 一份副本（防"崩了当成抓住"）。
 * 跑法：node tmp/mut_common.mjs   |   MUT_ONLY=K1,K3 node tmp/mut_common.mjs
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

const C10 = 'cl-10';
const C54 = 'cl-54';
const C55 = 'cl-55';
const C56 = 'cl-56';

const MUTS = [
  {
    id: 'K1', name: '把「浏览器直连可用」的条数写死成 450（载荷换了它还在念昨天的实测值）', expect: [C55],
    edits: [["                  h('span', { className: 'ac-num' }, `${num(snap?.presets?.[p.id])} 条`),",
      "                  h('span', { className: 'ac-num' }, '450 条'),"]],
  },
  {
    id: 'K2', name: '给常用API 那枚页签挂上全库条数（没有排序依据也先挂个数撑场面）', expect: [C10],
    edits: [["      return { catalog: snap?.result?.total ?? 0, notes: notesTotal };",
      "      return { catalog: snap?.result?.total ?? 0, common: snap?.index?.total ?? 0, notes: notesTotal };"]],
  },
  {
    id: 'K3', name: '卡头摆出一串「前 N」（没有出处的名次，读起来就是结果）', expect: [C54, C55],
    edits: [["              snap ? `${fmtCount(idx.total)} 条 · ${fmtCount(idx.categories)} 类` : '—')),",
      "              snap ? '1. 天气 2. 汇率 3. 短链接' : '—')),"]],
  },
  {
    id: 'K4', name: '条件那一段撤进悬停（屏幕上只剩「浏览器直连可用 450 条」，读起来就像常用）', expect: [C55],
    edits: [["                  h('span', { className: 'ac-sub' }, `· ${condOf(p)}`)))",
      "                  h('span', { className: 'ac-sub', title: `· ${condOf(p)}` }, '')))"]],
  },
  {
    id: 'K5', name: '快照没到时念 0 条（把"没读到"说成"库里什么都没有"）', expect: [C56],
    edits: [["      const num = (v) => (snap ? fmtCount(v) : '—');",
      "      const num = (v) => fmtCount(v ?? 0);"]],
  },
  {
    id: 'K6', name: '页签顺序改成把常用API 挪到最后（渲染不再跟 TAB_DEFS 一致）', expect: [C10],
    edits: [["      { id: 'common', label: '常用API' },\n", ""],
      ["      { id: 'settings', label: '设置' },\n    ];",
        "      { id: 'settings', label: '设置' },\n      { id: 'common', label: '常用API' },\n    ];"]],
  },
  {
    id: 'K7', name: '这一页里又摆出第二枚预设芯片（同一批条目两处入口，目录页那两枚本来就在）', expect: [C54],
    edits: [["          h('div', { className: 'ac-card-b' },\n            presets.length",
      "          h('div', { className: 'ac-card-b' },\n            h('button', { className: 'ac-chip' }, '免 key'),\n            presets.length"]],
  },
  {
    id: 'K8', name: '把「按使用频率 … 没有出处」那张解释卡加回来（2026-10-07 第二道裁定判撤）', expect: [C54],
    edits: [["        h('div', { className: 'ac-card' },\n          h('div', { className: 'ac-card-h' },\n            h('span', { className: 'ac-card-t' }, '全库'),",
      "        h('div', { className: 'ac-card' },\n          h('div', { className: 'ac-card-h' },\n            h('span', { className: 'ac-card-t' }, '按使用频率'),\n            h('span', { className: 'ac-card-n' }, snap ? '没有出处' : '—')),\n          h('div', { className: 'ac-empty' }, '还没有能排序的频率数据，所以这一页现在不排名次。')),\n"
        + "        h('div', { className: 'ac-card' },\n          h('div', { className: 'ac-card-h' },\n            h('span', { className: 'ac-card-t' }, '全库'),"]],
  },
  {
    id: 'K9', name: '把底部那份 parseNote 落款加回来（同一轮裁定「撤掉」：目录页已经念过一遍了）', expect: [C54],
    edits: [["              : h('div', { className: 'ac-empty' }, '载荷里没有预设档'))));",
      "              : h('div', { className: 'ac-empty' }, '载荷里没有预设档'),\n            h('p', { className: 'ac-note' }, cfg().parseNote || ''))));"]],
  },
];

let missed = 0; let broken = 0; let crashed = 0;
const only = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SUITE = 'client';
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
    const r = run('node', [`test/${SUITE}.test.mjs`]);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const passLine = (out.match(new RegExp(`\\[${SUITE}\\] pass \\d+ / fail \\d+ / skip \\d+`)) || [''])[0];
    if (!passLine) {
      crashed++;
      console.log(`崩 ${m.id} ${m.name}\n   ★ 套件没跑出汇总行（多半是渲染期抛异常，不能算判据挂）：\n${out.slice(0, 700)}`);
      continue;
    }
    const failed = out.match(/^FAIL (.*)$/gm) || [];
    const caught = m.expect.filter((e) => failed.some((f) => f.includes(e)));
    missed += caught.length === m.expect.length ? 0 : 1;
    console.log(`${caught.length ? `红（抓住 ${caught.join('、')}）` : '绿（漏网）'} ${m.id} ${m.name}`);
    console.log(`   ${passLine}`);
    if (caught.length !== m.expect.length) {
      console.log(`   ★ 该挂的 ${m.expect.join('、')} 里只挂上了这些；其余没挂 = 判据覆盖不到这个现场`);
    }
  }
} finally {
  for (const [file, text] of originals) {
    fs.writeFileSync(file, text);
    console.log(`[还原 ${file} ${sha(Buffer.from(fs.readFileSync(file))) === sha(Buffer.from(text)) ? 'ok' : '★ 失败 ★'}]`);
  }
  console.log(`[变异 ${MUTS.length} 发 · 漏网 ${missed} · 崩 ${crashed} · 变异自身语法坏 ${broken}]`);
  if (missed || broken || crashed) process.exitCode = 1;
}
