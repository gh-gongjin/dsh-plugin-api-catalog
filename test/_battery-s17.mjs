/**
 * test/_battery-s17.mjs —— S17（换成 public-apis-cn 为唯一目录源 + 上游留作降级）这一轮的变异电池。
 * ★ 临时脚手架，跑完就删（不在树里留第二份判据）。
 * 用法：node test/_battery-s17.mjs [名字前缀]
 * 每条变异：① 目标子串必须**恰好出现一次**（否则算没打上，红）② 打变异 ③ 跑指定套件、收集 FAIL 的用例名
 * ④ 立刻还原并逐字校验 ⑤ 期望锚点必须在那份 FAIL 清单里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const MUTATIONS = [
  {
    name: 'M1 两份锚点都在时取靠后那一处（"按位置"漂成"按谁在后面"）',
    file: 'lib/parse.js',
    from: `    if (i !== -1 && (start === -1 || i < start)) { start = i; pair = candidate; }`,
    to: `    if (i !== -1) { start = i; pair = candidate; }`,
    suites: ['parse'],
    expect: ['两份锚点在同一份正文里'],
  },
  {
    name: 'M2 没有右界又判成 fatal（换源那天撤掉的旧口径回来 ⇒ CN 真文档读不出来）',
    file: 'lib/parse.js',
    from: `  const atEof = end === -1;
  const stop = atEof ? lines.length : end;`,
    to: `  const atEof = end === -1;
  if (atEof) return { ok: false, fatal: PARSE_FATAL.INDEX_ANCHOR_MISSING, lines: [], start: -1, end: -1, endAnchor: '', atEof: true };
  const stop = end;`,
    suites: ['parse'],
    expect: ['没有右界就收到文件尾', 'fx-no-end 按换源那天'],
  },
  {
    name: 'M3 列形写死 5 列（不看这一档表的分隔行 ⇒ CN 那 4 列的 23 行整段丢）',
    file: 'lib/parse.js',
    from: `        sectionCols = n;`,
    to: `        sectionCols = DEFAULT_TABLE_COLS;`,
    suites: ['parse'],
    expect: ['列形跟着这一档表的分隔行走', 'CN 真文档：1494 行全收'],
  },
  {
    name: 'M4 窄档表一律当有 CORS 列（把"源没写"说成"这格脏" ⇒ 台账灌满、cors 全成 unknown）',
    file: 'lib/parse.js',
    from: `    const hasCors = cells.length >= 5;`,
    to: `    const hasCors = true;`,
    suites: ['parse'],
    expect: ['列形跟着这一档表的分隔行走'],
  },
  {
    name: 'M5 Yes/No 列不认中文写法（「是」「否」「未知」全落 unknown ⇒ 三列分布整片假）',
    file: 'lib/parse.js',
    from: `  const mapped = YESNO_ZH_TO_EN[v] ?? v;`,
    to: `  const mapped = v;`,
    suites: ['parse'],
    expect: ['半翻译的取值'],
  },
  {
    name: 'M6 鉴权列不认中文写法（「否」不再等于 No ⇒ 免 key 那一档少一大截）',
    file: 'lib/parse.js',
    from: `  const zh = AUTH_ZH_TO_EN[v];
  if (zh) return { auth: zh };   // CN 源鉴权列写「否」= 不需要认证，语义唯一（实测 9 行）`,
    to: ``,
    suites: ['parse'],
    expect: ['半翻译的取值'],
  },
  {
    name: 'M7 「源自己写了不知道」只认英文 Unknown（CN 那 50 格「未知」灌满脏值台账）',
    file: 'lib/parse.js',
    from: `  return v === 'Unknown' || YESNO_ZH_TO_EN[v] === 'Unknown';`,
    to: `  return v === 'Unknown';`,
    suites: ['parse'],
    expect: ['半翻译的取值'],
  },
  {
    name: 'M8 中文原文照样进待译队列（每轮白烧 40 发把中文再译一遍，还虚报"还剩 1400 句"）',
    file: 'lib/translate.js',
    from: `      if (TRANS_HAN_RE.test(text)) continue;`,
    to: ``,
    suites: ['translate'],
    expect: ['CN 真文档：原文自己写着中文的行不进待译队列'],
  },
  {
    name: 'M9 源链倒过来试（现用源排到最后 ⇒ 每轮先打降级源，界面念的源名与条目语言一起错）',
    file: 'lib/fetch.js',
    from: `  return list.map((id) => sourceById(id)).filter(Boolean);`,
    to: `  return list.map((id) => sourceById(id)).filter(Boolean).reverse();`,
    suites: ['fetch'],
    expect: ['真源（链上第一档', '中文源两档都不通时才走到降级源'],
  },
  {
    name: 'M10 页头把源名写死（不跟 sourceId 走 ⇒ 降级那一轮屏幕上说的是另一份文档）',
    file: 'client.js',
    from: `      const srcName = ((cfg().sources || []).find((x) => x.id === meta.sourceId) || {}).label || '';`,
    to: `      const srcName = '上游 public-apis';`,
    suites: ['client'],
    expect: ['cl-4', 'cl-11c'],
  },
  {
    name: 'M11 流水 detail 上限退回 200（五档源名一句装不下 ⇒ 最后一档被裁掉，界面少报一档）',
    file: 'lib/domain.js',
    from: `export const CHANGE_DETAIL_MAX_LEN = 320;`,
    to: `export const CHANGE_DETAIL_MAX_LEN = 200;`,
    suites: ['sync'],
    expect: ['每一档的原因一条不少'],
  },
  {
    name: 'M12 窄档表不单独成账（"这一档没有 CORS 列"这件事没人知道 ⇒ 界面少一格说明）',
    file: 'lib/parse.js',
    from: `        if (n < DEFAULT_TABLE_COLS && category) narrow.set(category, n);`,
    to: ``,
    suites: ['parse'],
    expect: ['列形跟着这一档表的分隔行走'],
  },
];

const SUITE = (s) => `test/${s}.test.mjs`;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const write = (rel, text) => fs.writeFileSync(path.join(ROOT, rel), text, 'utf8');

let bad = 0;
const ONLY = process.argv[2] || '';
for (const m of MUTATIONS.filter((x) => !ONLY || x.name.startsWith(ONLY))) {
  const rel = m.file;
  const original = read(rel);
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`\n### ${m.name}\n  变异没打上：目标子串出现 ${hits} 次（要恰好 1 次）`);
    bad += 1;
    continue;
  }
  write(rel, original.replace(m.from, m.to));
  console.log(`\n### ${m.name}`);
  const failed = [];
  for (const s of m.suites) {
    let out = '';
    try {
      out = execFileSync(process.execPath, [SUITE(s)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    }
    for (const line of out.split(/\r?\n/)) {
      const mm = line.match(/^FAIL (.+)$/);
      if (mm) failed.push(`[${s}] ${mm[1]}`);
    }
    const summary = (out.match(/\[\w[\w-]*\] pass [\d/ ]+/g) || ['（没打出汇总）']).join(' ');
    console.log(`  ${s}: ${summary}`);
  }
  let restored = false;
  try {
    write(rel, original);
    restored = read(rel) === original;
  } catch { restored = false; }
  console.log(`  [还原 ${restored ? 'ok' : 'FAILED'}] ${rel}`);
  if (!restored) bad += 1;
  const missing = m.expect.filter((key) => !failed.some((f) => f.includes(key)));
  console.log(`  杀掉 ${failed.length} 条：${failed.map((f) => f.slice(0, 60)).join(' ␟ ') || '（一条都没红 —— 这条判据是空的）'}`);
  if (failed.length === 0) { console.log('  ★ 无锚点：变异在离线面全绿 ⇒ 这条口径没被测到'); bad += 1; }
  for (const key of missing) { console.log(`  ★ 期望锚点没红：${key}`); bad += 1; }
}
console.log(`\n[battery-s17] 变异 ${MUTATIONS.length} 条 · 问题 ${bad} 项`);
if (bad) process.exitCode = 1;
