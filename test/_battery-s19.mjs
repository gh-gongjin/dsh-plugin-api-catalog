/**
 * test/_battery-s19.mjs —— S19（U-19：页头状态 pill 带上「上次检查」的时刻）的变异电池。
 * ★ 临时脚手架，跑完就删（不在树里留第二份判据）。
 * 用法：node test/_battery-s19.mjs [名字前缀]
 * 每条变异：① 目标子串必须**恰好出现一次**（否则算没打上，红）② 打变异 ③ 跑指定套件、收集 FAIL 的用例名
 * ④ 立刻还原并逐字校验 ⑤ 期望锚点必须在那份 FAIL 清单里。
 *
 * 这一轮的判据全挂在「哪个字段 + 什么格式 + 画在哪一枚」三件事上，所以变异也照着这三件事打：
 * 念错字段（M1/M2）、格式不对（M7/M8/M11）、位置不对或多开一枚（M3/M4/M5/M6）、
 * 改而不接（M12）、名词在浏览器半边重抄一遍（M9）、以及时刻这个数据前提本身（M10 ——
 * 「查了但没变」那一轮不前进 lastCheckedAt 的话，pill 上那个时刻就是在说上次真变化的时刻）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const C58 = 'cl-58';
const C6 = 'cl-6';
const GATE = '哈希门';

const MUTATIONS = [
  {
    name: 'M1 pill 念的是快照时刻（条目是哪一版，不是什么时候查过 —— 正是用户那一问的原点）',
    file: 'client.js',
    from: `const checkAt = fmtMinute(meta.lastCheckedAt);`,
    to: `const checkAt = fmtMinute(meta.fetchedAt);`,
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M2 副标题那一格改念 lastCheckedAt（两格并成一处，屏幕上又只有一个时刻）',
    file: 'client.js',
    from: '` · 快照 ${fmtTime(meta.fetchedAt || meta.lastCheckedAt)}`',
    to: '` · 快照 ${fmtTime(meta.lastCheckedAt || meta.fetchedAt)}`',
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M3 分隔符无条件画（没时刻时屏幕上挂出一个孤零零的「 · 」）',
    file: 'client.js',
    from: '`${statusLabel(status)}${checkAt ? ` · ${checkAt}` : \'\'}`',
    to: '`${statusLabel(status)} · ${checkAt}`',
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M4 时刻单独开第二枚 pill（页头又挤成一条线，两个绿点像两件事）',
    file: 'client.js',
    from: `: (conn.note || '未在实时更新')),`,
    to: `: (conn.note || '未在实时更新')),\n            checkAt ? h('span', { className: 'ac-pill' }, checkAt) : null,`,
    suites: ['client'], expect: [C58, C6],
  },
  {
    name: 'M5 断流那一支也挂时刻（读起来像"断开发生在这一刻"）',
    file: 'client.js',
    from: `: (conn.note || '未在实时更新')),`,
    to: ": `${conn.note || '未在实时更新'} · ${checkAt}`),",
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M6 一轮都没跑过时也挂时刻（"实时更新中"后面跟一个不存在的时间）',
    file: 'client.js',
    from: `                  : '实时更新中')`,
    to: "                  : `实时更新中 · ${fmtMinute(meta.fetchedAt)}`)",
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M7 格式精确到秒（pill 长出一条没人读的秒）',
    file: 'client.js',
    from: 'return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;',
    to: 'return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;',
    suites: ['client'], expect: [C58],
  },
  {
    name: `M8 没这一格时回 '—' 而不是空串（调用方据此整段不画的那条约定被打破）`,
    file: 'client.js',
    from: `      if (!Number.isFinite(t) || t <= 0) return '';\n      const d = new Date(t);`,
    to: `      if (!Number.isFinite(t) || t <= 0) return '—';\n      const d = new Date(t);`,
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M9 「上次检查」这个名词在浏览器半边又拼一遍（宿主 SYNC_STATUS_LABELS 里已经有了）',
    file: 'client.js',
    from: '`${statusLabel(status)}${checkAt ? ` · ${checkAt}` : \'\'}`',
    to: '`上次检查 ${statusLabel(status)}${checkAt ? ` · ${checkAt}` : \'\'}`',
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M10 「查了但没变」那一轮不前进 lastCheckedAt（pill 那个时刻的数据前提塌了）',
    file: 'lib/sync.js',
    from: `        await stores.meta.patch({ keyRule: KEY_RULE_VERSION, lastStatus: 'noChange', lastCheckedAt: at, backoff: 0 });`,
    to: `        await stores.meta.patch({ keyRule: KEY_RULE_VERSION, lastStatus: 'noChange', backoff: 0 });`,
    suites: ['sync'], expect: [GATE],
  },
  {
    name: 'M11 pill 里塞整份 toLocaleString（带秒带 locale，一行摆不下）',
    file: 'client.js',
    from: `const checkAt = fmtMinute(meta.lastCheckedAt);`,
    to: `const checkAt = fmtTime(meta.lastCheckedAt);`,
    suites: ['client'], expect: [C58],
  },
  {
    name: 'M12 时刻算出来了却没接进 pill（改版只改了助手，界面一句话没说）',
    file: 'client.js',
    from: '                  ? `${statusLabel(status)}${checkAt ? ` · ${checkAt}` : \'\'}`',
    to: `                  ? statusLabel(status)`,
    suites: ['client'], expect: [C58],
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
console.log(`\n[battery-s19] 变异 ${MUTATIONS.length} 条 · 问题 ${bad} 项`);
if (bad) process.exitCode = 1;
