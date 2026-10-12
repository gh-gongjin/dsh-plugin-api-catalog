/**
 * test/usage.test.mjs —— 用法层内置表 lib/usage.js（S11，用户裁定「详情页要把接口具体的使用方式打包进插件，运行时不抓」）。
 *
 * 这张表是**构建期抓来的产物**，所以判据要挡的不是"代码写错"，而是三种产物病：
 *   · 死行：表里有键、目录里没这条 ⇒ 永远显示不出来，还占发版体积（覆盖面从 parseCatalog(真夹具) 现算，不吃表自己的行数）；
 *   · 没出处：某一格说不出"哪份规范、哪一趟抓的" ⇒ 那就是手改的，界面上念不出落款的行不许存在；
 *   · 假形状：厂商规范里躺着 `http://localhost:3000` 这类开发机默认值，以及协议要求公开的 id 与真正的密钥值长得很像
 *     —— 前者答不了"往哪发"所以要一条不剩，后者是红线所以要整表搜。
 * ★ 与 desc-zh 那套同一取向：**归一化只许有一份**（键的口径靠 parse.js 的 normUrl），**运行时零抓取**（这一份里不许有任何出网能力）。
 */
import { check, runAll, assert, fixture, sourceText } from './_helpers.mjs';
import { parseCatalog, normUrl } from '../lib/parse.js';
import { USAGE, USAGE_COUNT, USAGE_HARVESTED_AT, usageFor } from '../lib/usage.js';

const README = await fixture('public-apis-README.md');
const { entries } = parseCatalog(README);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];
const LOCAL_RE = /^(?:localhost|0\.0\.0\.0|127\.|\[?::1\]?)|^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

check('覆盖面：表里每一个键都在当前目录里查得到条目（死行 = 显示不出来还占体积）', () => {
  assert.equal(USAGE_COUNT, Object.keys(USAGE).length, 'USAGE_COUNT 与表自己不一致');
  assert.ok(USAGE_COUNT >= 150, `用法层只剩 ${USAGE_COUNT} 键，不像一次完整的抓取产物`);
  const byKey = new Map();
  for (const e of entries) {
    const k = normUrl(e.url);
    if (Object.prototype.hasOwnProperty.call(USAGE, k)) byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  const dead = Object.keys(USAGE).filter((k) => !byKey.has(k));
  assert.deepEqual(dead, [], `${dead.length} 个键在目录里查不到条目：${dead.slice(0, 3).join('、')}`);
  assert.equal(byKey.size, USAGE_COUNT, '有些键一条都没命中 ⇒ 上面那条与这一条必须同时成立才算对账');
});

check('键的口径与读侧同一条：URL 带空格、带尾斜杠、大小写不改也能命中（不许有第二份归一化）', () => {
  const k = Object.keys(USAGE)[0];
  const hit = usageFor(k);
  assert.ok(hit && hit.spec, `表里第一个键 ${k} 自己都取不到，后面的判据都无从谈起`);
  assert.equal(usageFor(`  ${k}  `).spec, hit.spec, '首尾空格换了形就取不到：读侧那一条 url 与表里那一格是同一个口径才对');
  assert.equal(usageFor(`${k}/`).spec, hit.spec, '尾斜杠换了形就取不到');
  assert.equal(usageFor('https://没有这一家.example/'), null, '目录里没有的 URL 回的不是 null');
  assert.equal(usageFor(''), null);
  assert.equal(usageFor(undefined), null);
});

check('每一行都带得出处：spec 是 https 绝对地址、at 是这一批的抓取日', () => {
  for (const [k, r] of Object.entries(USAGE)) {
    // http 也认：那是厂商自己写的规范地址，运行时不发请求，不构成安全问题；但界面得念得出"这一份是明文抓的"。
    assert.ok(/^https?:\/\//i.test(r.spec), `${k} 的规范地址不是绝对地址：${r.spec}`);
    assert.equal(/^http:\/\/localhost|^http:\/\/127\./.test(r.spec), false, `${k} 的规范地址指向本机：${r.spec}`);
    assert.equal(r.at, USAGE_HARVESTED_AT, `${k} 的抓取批次与表头那个数不一致（落款会念错日子）`);
    assert.ok(String(r.title || '').length <= 80, `${k} 的 title 超过 80 字：规范里那段标题被整段塞进来了`);
    assert.ok(r.pathCount >= 1, `${k} 的 pathCount=${r.pathCount}：没有 paths 的文档当初不该算可用`);
    assert.ok(/^openapi 3|^swagger 2/.test(r.kind), `${k} 的 kind 不是验过形状那两种：${r.kind}`);
  }
});

check('operations 是规范里文档顺序的前几条，形状逐格钉住（界面直接摆这几行）', () => {
  for (const [k, r] of Object.entries(USAGE)) {
    assert.ok(Array.isArray(r.operations) && r.operations.length > 0, `${k} 一条操作都没抽出来`);
    assert.ok(r.operations.length <= 6, `${k} 带了 ${r.operations.length} 条操作（上限 6：这一层是"大概怎么用"，不是接口清单）`);
    for (const o of r.operations) {
      assert.ok(METHODS.includes(o.method), `${k} 的方法 ${o.method} 不在白名单里`);
      assert.match(o.path, /^\//, `${k} 的 path 不以 / 开头：${o.path}`);
      assert.ok(o.summary.length <= 160, `${k} 的 summary 超长：${o.summary.slice(0, 40)}…`);
      assert.equal(o.summary.includes('\n'), false, `${k} 的 summary 里有换行（规范里的多行描述被整段带进来了）`);
    }
  }
});

check('base 地址里一条内网/回环都没有（规范作者的开发机默认值答不了"往哪发"）', () => {
  for (const [k, r] of Object.entries(USAGE)) {
    assert.ok(r.servers.length <= 4, `${k} 的 servers 超过 4 条：${r.servers.length}`);
    for (const s of r.servers) {
      if (s.startsWith('/')) continue; // 相对 base：配合条目自己的 host 才有意义，是厂商原文
      let host = '';
      try { host = new URL(s).hostname.toLowerCase(); } catch { host = s; }
      assert.equal(LOCAL_RE.test(host), false, `${k} 还留着内网/回环的 base：${s}`);
    }
  }
});

check('鉴权那一栏只有类型与参数名，没有值（协议要求公开的 id 与真凭据要分得开）', () => {
  for (const [k, r] of Object.entries(USAGE)) {
    assert.ok(r.schemes.length <= 8, `${k} 的 securitySchemes 超过 8 条`);
    for (const s of r.schemes) {
      assert.ok(String(s.id).length <= 60, `${k} 的 scheme id 太长：${s.id.slice(0, 30)}`);
      for (const f of ['type', 'in', 'name']) {
        assert.ok(String(s[f]).length <= 40, `${k} 的 ${f} 不像一个字段名：${String(s[f]).slice(0, 30)}`);
      }
    }
    for (const g of r.globalSecurity) assert.ok(String(g).length <= 60, `${k} 的 globalSecurity 项太长`);
  }
});

check('红线：整张表里搜不到凭据形状的串（密钥只参与签名，连内置表都不带）', () => {
  const dumped = JSON.stringify(USAGE);
  const pats = [
    ['Bearer 后面跟着长串', /Bearer\s+[A-Za-z0-9._\-]{16,}/i],
    ['key/secret/token 直接赋值', /(?:api[_-]?key|apikey|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9+/_\-]{12,}["']/i],
    ['像是真凭据的查询串参数', /[?&](?:key|token|secret|signature|apikey)=[A-Za-z0-9+/_\-]{12,}/i],
  ];
  for (const [name, re] of pats) {
    const m = dumped.match(re);
    assert.equal(m, null, `表里出现「${name}」的形状：${m ? m[0].slice(0, 60) : ''}`);
  }
});

check('运行时零抓取：这张表本身没有任何出网能力，也没有动态 import', async () => {
  const src = await sourceText('lib/usage.js');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'import(', 'require(', 'node:http', 'node:https', 'WebSocket', 'EventSource']) {
    assert.equal(src.includes(bad), false, `lib/usage.js 里出现「${bad}」：这一层是发版产物，运行时一个请求都不该发`);
  }
  assert.equal(/["']https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.[\d.]+|10\.[\d.]+)/i.test(src), false,
    '表里出现指回本机/内网的规范地址');
  // ★ 别拿「.test / .local 这种保留顶级域」当内网判据：厂商真用它（osf 的 servers 里就是 api.test.osf.io），
  //   上一条按 hostname 逐格判的那一支才是准的。
});

check('归一化只有一份定义：lib/usage.js 用 parse.js 的 normUrl，自己不写第二份', async () => {
  const src = await sourceText('lib/usage.js');
  assert.ok(/import\s*\{[^}]*normUrl[^}]*\}\s*from\s*'\.\/parse\.js'/.test(src),
    'lib/usage.js 没引用 lib/parse.js 的 normUrl ⇒ 取键的口径有两份，「抓到时命中、读侧取不到」就是这么来的');
  assert.equal(/replace\(\/\\s\+\/g/.test(src), false, 'lib/usage.js 里还留着自己那份折叠空白的正则');
});

await runAll('usage');
