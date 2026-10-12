/**
 * test/_battery-s16.mjs —— S16（免费接口 + CONNECT 隧道）这一轮的变异电池。
 * ★ 临时脚手架，跑完就删（不在树里留第二份判据）。
 * 用法：node test/_battery-s16.mjs
 * 每条变异：① 目标子串必须**恰好出现一次**（否则算没打上，红）② 打变异 ③ 跑指定套件、收集 FAIL 的用例名
 * ④ 立刻还原并逐字校验 ⑤ 期望锚点必须在那份 FAIL 清单里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const MUTATIONS = [
  {
    name: 'M1 代理坏了悄悄回落直连（net.fetchViaNet 的 failed 那一支整块摘掉）',
    file: 'lib/net.js',
    from: `    if (route.via === 'failed') {
      const e = new Error(route.reason);
      e.code = 'proxy_config';
      throw e;
    }`,
    to: '',
    suites: ['net', 'api'],
    expect: ['nt-14', '这一发从哪条路出去'],
  },
  {
    name: 'M2 闸门按渠道 id 写死（免密钥那一档掉进 hasAll，永远 no_credential）',
    file: 'lib/translate.js',
    from: `    if (spec.needsKey !== true) return { can: true, errKey: '' };`,
    to: `    if (id !== 'keyless') return { can: true, errKey: '' };`,
    suites: ['translate', 'client'],
    expect: ['闸门看 needsKey'],
  },
  {
    name: 'M3 脏渠道回落"表里第一档"而不是出厂档（顺序一改就把默认出网方向换掉）',
    file: 'lib/translate.js',
    from: `    return TRANS_CHANNEL_IDS.includes(c) ? c : DEFAULT_TRANS_CHANNEL;`,
    to: `    return TRANS_CHANNEL_IDS.includes(c) ? c : TRANS_CHANNELS[0].id;`,
    suites: ['translate', 'api', 'host-compat'],
    expect: ['渠道脏值回落'],
  },
  {
    name: 'M4 设置页自己拼路线那句话（两处口径从此漂，界面念的不是服务器走的那条）',
    file: 'client.js',
    from: `                    ? \`出网：\${t.transport?.line || '还没试过这一发'}\``,
    to: `                    ? \`出网：\${t.transport?.via === 'proxy' ? '经代理隧道 · ' + t.transport.source : '直连'}\``,
    suites: ['client'],
    expect: ['cl-57'],
  },
  {
    name: 'M5 写侧收了带 user:pass@ 的代理地址（密码跟着 prefs 整份出到浏览器）',
    file: 'lib/api.js',
    from: `    if (u.includes('@')) throw new ApiError('INVALID_PARAM', PROXY_URL_BOUNDARY);`,
    to: '',
    suites: ['api'],
    expect: ['代理两格'],
  },
  {
    name: 'M6 出网白名单闸门放行（httpCall 第一行那道闸被绕开，新渠道开了后门）',
    file: 'lib/translate.js',
    from: `}) {
  const host = new URL(url).hostname;
  if (!TRANS_HOSTS.includes(host)) return fail('error', \`渠道域名不在白名单：\${host}\`);`,
    to: `}) {
  const host = new URL(url).hostname;
  if (false) return fail('error', host);`,
    suites: ['translate', 'net'],
    expect: ['httpCall 的第一行'],
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
  // 还原 + 逐字校验
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
console.log(`\n[battery] 变异 ${MUTATIONS.length} 条 · 问题 ${bad} 项`);
if (bad) process.exitCode = 1;
