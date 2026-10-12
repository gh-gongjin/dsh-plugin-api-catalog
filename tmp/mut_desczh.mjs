/**
 * tmp/mut_desczh.mjs —— 证伪内置预译表的判据：每条变异都还原成坏现场，看它挂哪一条。
 *
 * 三条脚手架铁律（都是这一路踩出来的，别再踩）：
 *  1. 锚点必须恰好命中 1 次，改动后必须与原文不同 —— 否则"全绿"其实是没改成。
 *  2. 套件没跑出汇总行 = 崩了，不算抓住。
 *  3. 默认判「没抓住」：只有 FAIL 行里真有那条判据的名字才算红。绿的一律记漏网并 exit 1。
 *
 * 跑法：node tmp/mut_desczh.mjs        （全跑）
 *      MUT_ONLY=D1,D3 node tmp/mut_desczh.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const FILE = 'lib/desc-zh.js';
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 12);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

const original = fs.readFileSync(FILE, 'utf8');
const baseSha = sha(Buffer.from(original));
const MARK = 'export const DESC_ZH_ROWS = [';
const start = original.indexOf(MARK);
if (start < 0) throw new Error('找不到数据段起点，锚点口径变了');
const firstRow = original.slice(start + MARK.length).match(/\n(\s+\[.*\],)/);
if (!firstRow) throw new Error('数据段第一行没抠出来');
const ROW0 = firstRow[1];
const src0 = JSON.parse(ROW0.replace(/,$/, ''))[0];

const MUTS = [
  {
    id: 'D1', name: '表里少一行（漏译）', expect: '覆盖面',
    text: (t) => t.replace(ROW0, ''),
  },
  {
    id: 'D2', name: '一行 src 漂成上游没有的名字（死行）', expect: '死行',
    text: (t) => t.replace(ROW0, `  ${JSON.stringify(['Totally Absent API Name', '一条没人要的中文'])},`),
  },
  {
    id: 'D3', name: '命中判据放宽成前缀匹配', expect: '逐字相同才命中',
    text: (t) => t.replace('return BY_SRC.get(key) || \'\';',
      'for (const [k, v] of BY_SRC) if (k.startsWith(key.slice(0, 12))) return v; return \'\';'),
  },
  {
    id: 'D4', name: '归一化只 trim 不折叠空白', expect: '命中判据',
    text: (t) => t.replace('return String(s ?? \'\').replace(/\\s+/g, \' \').trim();', 'return String(s ?? \'\').trim();'),
  },
  {
    id: 'D5', name: '译文列写进一条没汉字的（数据段坏了）', expect: '每行形状合规',
    text: (t) => t.replace(ROW0, `  ${JSON.stringify([src0, 'axolotl pics'])},`),
  },
  {
    id: 'D6', name: '重复主键（后一行静默盖前一行）', expect: '主键唯一',
    text: (t) => t.replace(ROW0, ROW0 + '\n' + ROW0),
  },
  {
    id: 'D7', name: '表里塞一个 fetch 句柄（离线口径破了）', expect: '零出网',
    text: (t) => t.replace('/** 表整理的时间戳', 'export const ping = (u) => fetch(u);\n/** 表整理的时间戳'),
  },
  {
    id: 'D8', name: '界面上那句日期写死第二份', expect: '日期只有一份',
    text: (t) => t.replace('export const DESC_ZH_LABEL =', 'export const DESC_ZH_LABEL2 = \'2026-10-06\';\nexport const DESC_ZH_LABEL ='),
  },
  {
    id: 'D9', name: 'translated 不看同形（给英文原文贴"预译"标签）', expect: 'descZhView',
    text: (t) => t.replace('return { zh: zh || src, translated: !!zh && zh !== src };',
      'return { zh: zh || src, translated: !!zh };'),
  },
  {
    id: 'D10', name: '没命中时行内取的 zh 成空串（那一格会被打掉）', expect: 'descZhView',
    text: (t) => t.replace('return { zh: zh || src, translated: !!zh && zh !== src };',
      'return { zh, translated: !!zh && zh !== src };'),
  },
];

let missed = 0;
const only = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
try {
  for (const m of MUTS) {
    if (only.length && !only.includes(m.id)) continue;
    const mutated = m.text(original);
    if (mutated === original) throw new Error(`${m.id} 改动没落地（替换前后一模一样）：锚点漂了`);
    fs.writeFileSync(FILE, mutated);
    const r = run('node', ['test/desc-zh.test.mjs']);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const passLine = (out.match(/\[desc-zh\] pass \d+ \/ fail \d+ \/ skip \d+/) || [''])[0];
    if (!passLine) throw new Error(`${m.id} 套件没跑出汇总行（多半是崩了，不是判据挂）：\n${out.slice(0, 500)}`);
    const failed = (out.match(/^FAIL (.*)$/gm) || []).map((s) => s.slice(5));
    const caught = failed.some((f) => f.includes(m.expect));
    if (!caught) missed++;
    console.log(`${caught ? '红（抓住）' : m.equivalent ? '灰（等价变异·无判据钉这行）' : '绿（漏网）'} ${m.id} ${m.name}`);
    console.log(`   ${passLine} · 挂的是：${failed.join(' / ') || '（一条没挂）'}`);
  }
} finally {
  fs.writeFileSync(FILE, original);
  const now = sha(fs.readFileSync(FILE));
  console.log(`[还原 ${now === baseSha ? 'ok' : '★ 失败 ★'}（sha ${baseSha} → ${now}）· 漏网 ${missed} 条]`);
  if (now !== baseSha || missed) process.exitCode = 1;
}
