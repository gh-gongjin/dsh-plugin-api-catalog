/**
 * tmp/mut_sig.mjs —— 证伪"三家接入"这一批（腾讯 TC3 / 阿里 RPC / 讯飞鉴权 + optional 闸门）。
 * 脚手架口径同 mut_ac09 / mut_desczh：锚点恰好命中一次、改动必须落地、
 * 没跑出汇总行算"崩"不算"抓住"、expect 里每一条都得挂、默认判"没抓住"。
 * 跑法：node tmp/mut_sig.mjs   |   MUT_ONLY=S3,S7 node tmp/mut_sig.mjs
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

/** 判据的名字（用例标题里的关键词），expect 用它们来点名"该挂哪一条"。 */
const VEC_TC = '腾讯 TC3-HMAC-SHA256：官方算例逐层复现';
const VEC_ALI = '阿里 RPC 签名：官方算例';
const VEC_XF = '讯飞鉴权：官方算例';
const SEND_TC = '腾讯真发那一发';
const SEND_ALI = '阿里真发那一发';
const SEND_XF = '讯飞真发那一发';
const BODY2 = '两家 POST 的正文';
const PARSE3 = '三家回包解析';
const READY = 'readiness：四档要 key';
const REGION = '腾讯地域留空';
const HC9C = 'hc-9c';

const MUTS = [
  {
    id: 'S1', file: 'lib/translate.js', name: '腾讯规范请求串把空查询串那一行整行省掉', expect: [VEC_TC],
    edits: [[`    method, '/', queryString, canonicalHeaders, signedHeaders, sha256Hex(payload),`,
      `    method, '/', canonicalHeaders, signedHeaders, sha256Hex(payload),`]],
  },
  {
    id: 'S2', file: 'lib/translate.js', name: '腾讯派生链第一段少了 TC3 前缀', expect: [VEC_TC],
    edits: [['  const secretDate = hmac(`TC3${secretKey}`, date);', '  const secretDate = hmac(secretKey, date);']],
  },
  {
    id: 'S3', file: 'lib/translate.js', name: '腾讯头里的时间戳另取一次（签名吃的与发出去的不是同一秒）', expect: [SEND_TC],
    edits: [["      'X-TC-Timestamp': String(ts),", "      'X-TC-Timestamp': String(Math.floor(Date.now() / 1000)),"]],
  },
  {
    id: 'S4', file: 'lib/translate.js', name: '阿里百分号编码不编星号（encodeURIComponent 的默认行为）', expect: [VEC_ALI],
    edits: [[`    .replace(/\\)/g, '%29').replace(/\\*/g, '%2A');`, `    .replace(/\\)/g, '%29');`]],
  },
  {
    id: 'S5', file: 'lib/translate.js', name: '阿里规范化串不按键排序', expect: [VEC_ALI],
    edits: [['    .sort()\n    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`)',
      '    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`)']],
  },
  {
    id: 'S6', file: 'lib/translate.js', name: '阿里签名 key 漏了尾部那个 &', expect: [VEC_ALI],
    // 真发那一条测不到：它是拿**同一个函数**重算来核对发送形状一致性，算法本身的错只由官方算例那发咬住
    edits: [["createHmac('sha1', `${accessKeySecret}&`)", "createHmac('sha1', accessKeySecret)"]],
  },
  {
    id: 'S7', file: 'lib/translate.js', name: '讯飞 request-line 的方法写成 GET', expect: [VEC_XF],
    edits: [['  const requestLine = `POST ${u.pathname} HTTP/1.1`;', '  const requestLine = `GET ${u.pathname} HTTP/1.1`;']],
  },
  {
    id: 'S8', file: 'lib/translate.js', name: '讯飞 authorization_origin 逗号后不带空格', expect: [VEC_XF],
    edits: [[
      '  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;',
      '  const authorizationOrigin = `api_key="${apiKey}",algorithm="hmac-sha256",headers="host date request-line",signature="${signature}"`;']],
  },
  {
    id: 'S9', file: 'lib/translate.js', name: '讯飞正文的文本不走 base64', expect: [BODY2, SEND_XF],
    edits: [["        text: Buffer.from(text, 'utf8').toString('base64'),", '        text,']],
  },
  {
    id: 'S10', file: 'lib/translate.js', name: '域名闸门从 httpCall 内部挪到腾讯那一发的调用方', expect: [HC9C],
    edits: [[
      '  const host = new URL(url).hostname;\n  if (!TRANS_HOSTS.includes(host)) return fail(\'error\', `渠道域名不在白名单：${host}`);\n  const ac = new AbortController();',
      '  const host = new URL(url).hostname;\n  const ac = new AbortController();'],
      ["  stats.lastSigned = { algorithm: 'TC3-HMAC-SHA256'",
        "  if (!TRANS_HOSTS.includes(host)) return fail('error', `渠道域名不在白名单：${host}`);\n  stats.lastSigned = { algorithm: 'TC3-HMAC-SHA256'"]],
  },
  {
    id: 'S11', file: 'lib/translate.js', name: '腾讯发送的正文与签名吃的不是同一串（发送前又 stringify 一次）', expect: [SEND_TC],
    edits: [['    body,\n    fetchImpl, timeoutMs, stats, kind: \'tencent\',', '    body: JSON.stringify(JSON.parse(body), null, 1),\n    fetchImpl, timeoutMs, stats, kind: \'tencent\',']],
  },
  {
    id: 'S12', file: 'lib/translate.js', name: '自证读数里带上 SecretKey（诊断会被贴进工单）', expect: [SEND_TC],
    edits: [["signature: signed.signature, timestamp: String(ts), region };",
      "signature: signed.signature, timestamp: String(ts), region, secretKey };"]],
  },
  {
    id: 'S13', file: 'lib/translate.js', name: '腾讯地域回落改成硬写另一个地域（与登记值两处各写一遍）', expect: [REGION],
    edits: [['  const region = String(creds.region ?? \'\').trim() || TENCENT_DEFAULT_REGION;',
      '  const region = String(creds.region ?? \'\').trim() || \'ap-beijing\';']],
  },
  {
    id: 'S14', file: 'lib/translate.js', name: '腾讯错误码那一支被当成成功（回包只有 Error 时也返回 ok）', expect: [PARSE3],
    edits: [['  if (r.Error && (r.Error.Code || r.Error.Message)) {', '  if (false) {']],
  },
  {
    id: 'S15', file: 'lib/translate.js', name: '讯飞回包少了第二层 base64 解码（直接把那串密文当译文）', expect: [PARSE3, SEND_XF],
    edits: [[
      "    inner = JSON.parse(Buffer.from(packed, 'base64').toString('utf8'));",
      "    inner = { trans_result: { dst: Buffer.from(packed, 'base64').toString('utf8') } };"]],
  },
  {
    id: 'S16', file: 'lib/stores.js', name: 'hasAll 不跳过 optional 字段（地域留空就把整档挡死）', expect: [REGION, READY],
    suites: ['store', 'translate'],
    edits: [['        if (f.optional === true) continue;', '        // (mutated: 不跳过 optional)']],
  },
  {
    id: 'S17', file: 'lib/translate.js', name: '阿里发送的查询串里塞进 AccessKeySecret（红线现场）', expect: [SEND_ALI],
    edits: [[
      "    SourceText: text,\n    Scene: 'general',",
      "    SourceText: text,\n    _sk: accessKeySecret,\n    Scene: 'general',"]],
  },
  {
    id: 'S18', file: 'lib/translate.js', name: '腾讯正文的键顺序换了（服务端不认键序，但判据钉的是整串 JSON，连键序一起钉）', expect: [BODY2],
    edits: [[
      "    SourceText: text, Source: 'en', Target: 'zh', ProjectId: 0,",
      "    ProjectId: 0, SourceText: text, Source: 'en', Target: 'zh',"]],
  },
];

let missed = 0; let uncovered = 0;
const only = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
try {
  for (const m of MUTS) {
    if (only.length && !only.includes(m.id)) continue;
    const suites = m.suites ?? ['translate', 'host-compat'];
    let text = sourceOf(m.file);
    for (const [from, to] of m.edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`${m.id} 锚点命中 ${n} 次（要恰好 1 次）：${from.slice(0, 40)}`);
      text = text.replace(from, to);
    }
    if (text === sourceOf(m.file)) throw new Error(`${m.id} 改动没落地（替换前后一模一样）`);
    fs.writeFileSync(m.file, text);
    const lines = []; const failed = [];
    for (const s of suites) {
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
      console.log(`   ★ 该挂的 ${m.expect.join('、')} 里只挂上了这些；其余没挂 = 判据覆盖不到这个现场`);
    }
  }
} finally {
  for (const [file, text] of originals) {
    fs.writeFileSync(file, text);
    console.log(`[还原 ${file} ${sha(Buffer.from(fs.readFileSync(file))) === sha(Buffer.from(text)) ? 'ok' : '★ 失败 ★'}]`);
  }
  console.log(`[变异 ${MUTS.length} 发 · 漏网 ${missed} · 等价但无判据 ${uncovered}]`);
  if (missed || uncovered) process.exitCode = 1;
}
