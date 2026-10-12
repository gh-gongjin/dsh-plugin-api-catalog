/**
 * tmp/mut_usage.mjs —— 证伪这一轮的三批新东西：
 *  ① 用法层数据表（lib/usage.js）与读侧那一发 join（lib/query.js）；
 *  ② 详情弹框的重排 + 「怎么用」那一节（client.js）；
 *  ③ 设置页「中文说明」卡的重排（client.js）。
 * 脚手架口径同 mut_sig / mut_ac09：锚点恰好命中一次、改动必须落地、
 * 没跑出汇总行算「崩」不算「抓住」、expect 里每一条都得挂、默认判「没抓住」。
 * ★ 本轮新加的一道：变异写回之前先 `node --check` 一份副本。上一轮 U13 把括号改坏了，
 *   整套件 65 条全挂 —— 那看着像"抓住"，其实是崩，判据一条都没咬住。
 * 跑法：node tmp/mut_usage.mjs   |   MUT_ONLY=U12,U13 node tmp/mut_usage.mjs
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

/** 判据名（用例标题里的关键词）。 */
const COVERAGE = '覆盖面：表里每一个键都在当前目录里查得到条目';
const KEYNORM = '键的口径与读侧同一条';
const LOOPBACK = 'base 地址里一条内网/回环都没有';
const NOFETCH = '运行时零抓取';
const REDLINE = '红线：整张表里搜不到凭据形状的串';
const Q_JOIN = '用法层：entry 带那份抽出来的规范';
const A_JOIN = 'GET /api/entry 把用法层带过去';
const C43 = 'cl-43'; const C50 = 'cl-50'; const C51 = 'cl-51'; const C52 = 'cl-52'; const C53 = 'cl-53';

const MUTS = [
  {
    id: 'U1', suites: ['usage'], file: 'lib/usage.js', name: 'usageFor 不做归一化（界面带尾斜杠的 url 就命中不了）', expect: [KEYNORM],
    edits: [['  const k = normUrl(rawUrl);', "  const k = String(rawUrl ?? '');"]],
  },
  {
    id: 'U2', suites: ['usage'], file: 'lib/usage.js', name: '表里多一条目录里没有的键（死行：占体积又显示不出来）', expect: [COVERAGE],
    edits: [['export const USAGE = Object.freeze({\n',
      'export const USAGE = Object.freeze({\n  "https://example.invalid/nope": {"title":"Bogus","kind":"openapi 3.0.0","specVersion":"1","pathCount":1,"servers":["https://example.invalid"],"schemes":[],"globalSecurity":[],"operations":[{"method":"GET","path":"/x","summary":"x"}],"spec":"https://example.invalid/openapi.json","at":"2026-10-06"},\n']],
  },
  {
    id: 'U3', suites: ['usage'], file: 'lib/usage.js', name: 'servers 里留着规范作者的开发机地址（回环 base 答不了「往哪发」）', expect: [LOOPBACK, NOFETCH],
    edits: [['{"title":"Country","kind":"openapi 3.1.0","specVersion":"4.2.3","pathCount":3,"servers":[],',
      '{"title":"Country","kind":"openapi 3.1.0","specVersion":"4.2.3","pathCount":3,"servers":["http://localhost:3000"],']],
  },
  {
    id: 'U4', suites: ['usage'], file: 'lib/usage.js', name: '鉴权那一格把示例值也带进表里（凭据形状的串）', expect: [REDLINE],
    edits: [['"name":"Bitrise-Addon-Auth-Token"', '"name":"Bitrise-Addon-Auth-Token","apiKey":"abcdefghij123456"']],
  },
  {
    id: 'U5', suites: ['query', 'api'], file: 'lib/query.js', name: '详情那一发的用法层写死 null（抓来的一整层在界面上消失）', expect: [Q_JOIN, A_JOIN],
    edits: [['        usage: usageFor(rec.item.url),', '        usage: null,']],
  },
  {
    id: 'U6', suites: ['query', 'api'], file: 'lib/query.js', name: '用法层摊进每一行（快照被撑大一圈）', expect: [Q_JOIN, A_JOIN],
    edits: [['  const rows = page.map(({ rec, note, score }) => ({\n    ...withZh(rec.item, transMap),\n',
      '  const rows = page.map(({ rec, note, score }) => ({\n    ...withZh(rec.item, transMap),\n    usage: usageFor(rec.item.url),\n']],
  },
  {
    id: 'U7', suites: ['client'], file: 'client.js', name: '没抓到规范的那条也摆一节「怎么用」+ 占位句（91% 的弹框多一行废话）', expect: [C50],
    edits: [['      if (!u) return null;',
      "      if (!u) return h('div', { className: 'ac-sec' }, h('div', { className: 'ac-sec-t' }, '怎么用'), h('div', { className: 'ac-absent' }, '没有可用的机器可读规范'));"]],
  },
  {
    id: 'U8', suites: ['client'], file: 'client.js', name: '规范里没 servers 时拿 spec 地址顶上「地址」那一行', expect: [C52],
    edits: [['          (u.servers || []).map((s, i) =>', '          (u.servers.length ? u.servers : [u.spec]).map((s, i) =>']],
  },
  {
    id: 'U9', suites: ['client'], file: 'client.js', name: '截断那句的两个数字写死成 6', expect: [C51],
    edits: [['规范里共 ${u.pathCount} 个操作，这里列的是抓下来的前 ${ops.length} 个', '规范里共 6 个操作，这里列的是抓下来的前 6 个']],
  },
  {
    id: 'U10', suites: ['client'], file: 'client.js', name: '鉴权话术不念规范里的参数名，统一写「需要 api key」', expect: [C51],
    edits: [['          return where && s.name ? `key 放${where} ${s.name}` : `apiKey（${s.name || id}，规范没写放在哪）`;',
      "          return '需要 api key';"]],
  },
  {
    id: 'U11', suites: ['client'], file: 'client.js', name: '「怎么用」挪到「现在的限制」后面（读的顺序反了）', expect: [C50],
    edits: [["        h(UsageSection, { u: e.usage }),\n", ''],
      ["          h('div', { className: 'ac-derived' }, (e.derived || []).map((x, i) => h('i', { key: `${e.slug}-d${i}` }, x)))),\n",
        "          h('div', { className: 'ac-derived' }, (e.derived || []).map((x, i) => h('i', { key: `${e.slug}-d${i}` }, x)))),\n        h(UsageSection, { u: e.usage }),\n"]],
  },
  {
    id: 'U12', suites: ['client'], file: 'client.js', name: '凭据那一节不看开关（没启用也把密钥框摊在屏上）', expect: [C43, C53],
    edits: [['          (on && cur.implemented === true && cur.needsKey === true)',
      '          (cur.implemented === true && cur.needsKey === true)']],
  },
  {
    id: 'U13', suites: ['client'], file: 'client.js', name: '节标题挂错了节：芯片那一节写着「保存与试发」（排版与内容对不上）', expect: [C53],
    edits: [["          h('div', { className: 'ac-sec-t' }, '保存与试发'),", "          h('div', { className: 'ac-sec-t' }, 'TMPX'),"],
      ["          h('div', { className: 'ac-sec-t' }, '用哪一档译'),", "          h('div', { className: 'ac-sec-t' }, '保存与试发'),"],
      ["          h('div', { className: 'ac-sec-t' }, 'TMPX'),", "          h('div', { className: 'ac-sec-t' }, '用哪一档译'),"]],
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
