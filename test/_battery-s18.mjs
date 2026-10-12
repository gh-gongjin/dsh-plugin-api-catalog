/**
 * test/_battery-s18.mjs —— S18（U-15 限流单独一档 / U-16 title 不替上游说话 / U-17 本轮摘要进流水）的变异电池。
 * ★ 临时脚手架，跑完就删（不在树里留第二份判据）。
 * 用法：node test/_battery-s18.mjs [名字前缀]
 * 每条变异：① 目标子串必须**恰好出现一次**（否则算没打上，红）② 打变异 ③ 跑指定套件、收集 FAIL 的用例名
 * ④ 立刻还原并逐字校验 ⑤ 期望锚点必须在那份 FAIL 清单里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const MUTATIONS = [
  {
    name: 'M1 429 归回普通 http（"过一会儿自己会好"与"接口形状变了"说成同一句话）',
    file: 'lib/translate.js',
    from: `  return fail(status === 429 ? 'rate_limited' : 'http', \`HTTP \${status ?? '?'}\`);`,
    to: `  return fail('http', \`HTTP \${status ?? '?'}\`);`,
    suites: ['translate'],
    expect: ['429 单独一档'],
  },
  {
    name: 'M2 种类没落在失败行上（界面下一轮只能按整天关）',
    file: 'lib/translate.js',
    from: `errText: r.errText || r.errKey, errKey: r.errKey || undefined,`,
    to: `errText: r.errText || r.errKey,`,
    suites: ['translate'],
    expect: ['429 单独一档'],
  },
  {
    name: 'M3 限流那档冷却写成一天（分了种类却没缩短，等于没改）',
    file: 'lib/domain.js',
    from: `export const TRANS_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;`,
    to: `export const TRANS_RATE_LIMIT_COOLDOWN_MS = 24 * 3600_000;`,
    suites: ['translate'],
    expect: ['429 单独一档'],
  },
  {
    name: 'M4 冷却不看种类（所有错一律短成一档，500 也跟着半小时重打）',
    file: 'lib/translate.js',
    from: `  return errKey === 'rate_limited' ? TRANS_RATE_LIMIT_COOLDOWN_MS : TRANS_FAIL_COOLDOWN_MS;`,
    to: `  return TRANS_FAIL_COOLDOWN_MS;`,
    suites: ['translate'],
    expect: ['429 单独一档'],
  },
  {
    name: 'M5 不写本轮摘要行（U-17 撤掉：整轮读数又被保留上限挤没）',
    file: 'lib/sync.js',
    from: `      if (diff.ledger.length) {
        await stores.changes.append({ kind: 'round', at, detail: roundSummary(diff.stats, fetched.sourceId) });
      }
`,
    to: ``,
    suites: ['sync', 'client'],
    expect: ['上游只改一条', 'cl-27'],
  },
  {
    name: 'M6 摘要行写在 trim 之后（自己不参与排序：大轮次一挤就丢，或小轮次多出一行）',
    file: 'lib/sync.js',
    from: `      if (diff.ledger.length) {
        await stores.changes.append({ kind: 'round', at, detail: roundSummary(diff.stats, fetched.sourceId) });
      }
      await stores.changes.trim(KEEP_CHANGES);`,
    to: `      await stores.changes.trim(KEEP_CHANGES);
      if (diff.ledger.length) {
        await stores.changes.append({ kind: 'round', at, detail: roundSummary(diff.stats, fetched.sourceId) });
      }`,
    suites: ['sync'],
    expect: ['KEEP_CHANGES 封顶'],
  },
  {
    name: 'M7 明细行让 stores 逐行现取时刻（真时钟下一轮的 at 被拉开，摘要排到最旧那头）',
    file: 'lib/stores.js',
    from: `          const when = r.at ?? now();`,
    to: `          const when = now();`,
    suites: ['sync', 'client'],
    expect: ['会走的钟', 'cl-27'],
  },
  {
    name: 'M8 摘要行的数不取 stats（写死 0：一行看着齐全，其实是假账）',
    file: 'lib/sync.js',
    from: `  const parts = CHANGE_KINDS.map((k) => \`\${CHANGE_KIND_LABELS[k]} \${Number(stats?.[k]) || 0}\`);`,
    to: `  const parts = CHANGE_KINDS.map((k) => \`\${CHANGE_KIND_LABELS[k]} 0\`);`,
    suites: ['sync'],
    expect: ['上游只改一条', '换源那一轮'],
  },
  {
    name: 'M9 客户端自己数种类做芯片（labels 全做成筛选项 ⇒「本轮摘要」多一枚没用的芯片）',
    file: 'client.js',
    from: `      const kinds = cfg().changeKindChips || [];`,
    to: `      const kinds = Object.keys(cfg().changeKindLabels || {});`,
    suites: ['client'],
    expect: ['cl-27'],
  },
  {
    name: 'M10 facet title 回退成「上游原值」（unknown 是我们合成的，屏幕在替上游编话）',
    file: 'client.js',
    from: `              title: \`\${facetLabelOf(d.field, v)}（库里记的取值 \${v}）\`,`,
    to: `              title: \`\${facetLabelOf(d.field, v)}（上游原值 \${v}）\`,`,
    suites: ['client'],
    expect: ['cl-12 facet 筛选'],
  },
  {
    name: 'M11 摘要行种类没进 labels（载荷两张表对不上 ⇒ 屏幕只能画出英文原键）',
    file: 'lib/domain.js',
    from: `  round: '本轮摘要',`,
    to: ``,
    suites: ['host-compat', 'client'],
    expect: ['hc-13', 'cl-27'],
  },
  {
    name: 'M12 摘要行混进筛选芯片（U-17 的另一半裁定：能读能画，不做成筛选项）',
    file: 'lib/domain.js',
    from: `export const CHANGE_FILTER_KINDS = [...CHANGE_KINDS, 'source_error'];`,
    to: `export const CHANGE_FILTER_KINDS = [...CHANGE_ROW_KINDS];`,
    suites: ['host-compat', 'client'],
    expect: ['hc-13', 'cl-27'],
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
console.log(`\n[battery-s18] 变异 ${MUTATIONS.length} 条 · 问题 ${bad} 项`);
if (bad) process.exitCode = 1;
