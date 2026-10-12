/**
 * test/parse.test.mjs —— 解析层（lib/parse.js）。
 * 断言里的每个数字都来自真文档实跑读数（英文夹具 2026-10-05 / CN 夹具 2026-10-07，采数脚本 tmp/_cn-parse.mjs），
 * 源文档变了就要重新采读数并同步 spec §9.1，不许改断言去迁就实现。
 */
import { check, runAll, assert, fixture } from './_helpers.mjs';
import {
  unbacktick, foldKey, shortHash, slugOf, normUrl, looksLikeUrl, hostOf,
  parseTitleCell, normAuth, normYesNo, isHeaderRow, isSeparatorLine, splitCells,
  extractRegion, parseCatalog,
} from '../lib/parse.js';
import { AUTH_OPTIONS, AUTH_ZH_TO_EN, YESNO_ZH_TO_EN, DESC_SOFT_LIMIT } from '../lib/domain.js';

const BIG = await fixture('public-apis-README.md');
const big = parseCatalog(BIG);

/* ================= 单元：小工具 ================= */

check('unbacktick：去反引号与首尾空白，非字符串不炸', () => {
  assert.equal(unbacktick('  `apiKey` '), 'apiKey');
  assert.equal(unbacktick('No'), 'No');
  assert.equal(unbacktick(''), '');
  assert.equal(unbacktick(null), '');
  assert.equal(unbacktick(42), '42');
});

check('normUrl：吃掉括号内尾随空格、折尾斜杠、保留 query（实测 query 出现 60 次）', () => {
  assert.equal(normUrl('https://reqres.in/ '), 'https://reqres.in');
  assert.equal(normUrl(' https://x.com/a/  '), 'https://x.com/a');
  assert.equal(normUrl('https://x.com?a=1&b=2'), 'https://x.com?a=1&b=2');   // query 是信息，不许丢
  assert.equal(normUrl('http://shibe.online/'), 'http://shibe.online');
  assert.equal(normUrl(''), '');
});

check('looksLikeUrl：http(s) 与 www 收，裸域名与断链不收', () => {
  assert.equal(looksLikeUrl('https://x.com'), true);
  assert.equal(looksLikeUrl('http://x.com'), true);
  assert.equal(looksLikeUrl('www.x.com'), true);
  assert.equal(looksLikeUrl('www2.x.com'), true);
  assert.equal(looksLikeUrl('x.com'), false);
  assert.equal(looksLikeUrl('mailto://x'), false);
});

check('hostOf：小写、去 www.、缺协议也能读、读不出交空串', () => {
  assert.equal(hostOf('https://WWW.Example.COM/Path'), 'example.com');
  assert.equal(hostOf('http://shibe.online'), 'shibe.online');
  assert.equal(hostOf('www.x.com/a'), 'x.com');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf('https://'), '');           // new URL 抛 → 空串，聚合视图里单独一组
});

check('foldKey：重音折叠 + 只留字母数字（U-2 的裁定落点）', () => {
  assert.equal(foldKey('Améthyste'), 'amethyste');
  assert.equal(foldKey('Çômmüniqué'), 'communique');
  assert.equal(foldKey('24 Pull Requests'), '24pullrequests');
  assert.equal(foldKey('C++'), 'c');
  assert.equal(foldKey('Bíblia Digital'), 'bibliadigital');
  assert.equal(foldKey(''), '');
  assert.equal(foldKey(null), '');
});

check('shortHash：稳定、与输入顺序无关、撞名靠 URL 区分', () => {
  assert.equal(shortHash('https://a.example'), shortHash('https://a.example'));
  assert.notEqual(shortHash('https://a.example'), shortHash('https://b.example'));
  assert.match(shortHash('x'), /^[0-9a-z]{1,7}$/);
  assert.equal(shortHash(''), shortHash(''));
});

check('slugOf：同名消歧后缀挂在 URL 上，不挂行序上', () => {
  const base = slugOf('Animals', 'Cat Facts');
  assert.equal(base, 'Animals::catfacts');
  const a = slugOf('Animals', 'Cat Facts', 'https://alexwohlbruck.github.io/cat-facts/');
  const b = slugOf('Animals', 'Cat Facts', 'https://catfact.ninja/');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('Animals::catfacts::'));
  assert.ok(!/#\d+$/.test(a), `出现顺序号后缀就说明改回过行序消歧：${a}`);   // node:assert 没有 notMatch
});

check('parseTitleCell：正常 / 尾随空格 / 非链接 / 空名 / 协议外', () => {
  assert.deepEqual(parseTitleCell('[NASA](https://api.nasa.gov)'), { ok: true, name: 'NASA', url: 'https://api.nasa.gov' });
  assert.equal(parseTitleCell('[ReqRes](https://reqres.in/ )').url, 'https://reqres.in');
  assert.equal(parseTitleCell('[X](\n https://y.com \n)').url, 'https://y.com');
  assert.equal(parseTitleCell('Broken').ok, false);
  assert.match(parseTitleCell('Broken').reason, /标题格不是/);
  assert.equal(parseTitleCell('[x](mailto:a@b)').ok, false);
  assert.equal(parseTitleCell('[](https://x.com)').ok, false);
  assert.match(parseTitleCell('[](https://x.com)').reason, /为空/);
});

check('normAuth：枚举内取值，枚举外归 unknown 并留 authRaw', () => {
  assert.deepEqual(normAuth('`apiKey`'), { auth: 'apiKey' });
  assert.deepEqual(normAuth('No'), { auth: 'No' });
  for (const one of AUTH_OPTIONS) assert.equal(normAuth(`\`${one}\``).auth, one);
  assert.deepEqual(normAuth('Bearer'), { auth: 'unknown', authRaw: 'Bearer' });
  assert.equal(normAuth('').auth, 'unknown');
  // CN 源那列的中文取值：表从登记表来，加一档源不改这段代码（AUTH_ZH_TO_EN 加一项就够）。
  for (const [zh, en] of Object.entries(AUTH_ZH_TO_EN)) assert.deepEqual(normAuth(zh), { auth: en }, `「${zh}」没按登记表归到 ${en}`);
  assert.deepEqual(normAuth('是'), { auth: 'unknown', authRaw: '是' }, '「认证方式：是」含义不唯一，不许猜');
});

check('normYesNo：Yes/No 认，Unknown 与脏值都归 unknown（不许冒充 No）', () => {
  assert.equal(normYesNo('Yes'), 'Yes');
  assert.equal(normYesNo('`Yes`'), 'Yes');
  assert.equal(normYesNo('No'), 'No');
  assert.equal(normYesNo('Unknown'), 'unknown');
  assert.equal(normYesNo('–'), 'unknown');
  assert.equal(normYesNo(''), 'unknown');
  assert.equal(normYesNo('maybe'), 'unknown');
  for (const [zh, en] of Object.entries(YESNO_ZH_TO_EN)) {
    assert.equal(normYesNo(zh), en === 'Unknown' ? 'unknown' : en, `「${zh}」该归到 ${en}`);
  }
  assert.equal(normYesNo('YES'), 'unknown', '大小写脏值不猜（CN 实测 1 格），照第 3 条落 unknown');
});

check('splitCells：尾竖线可省，两种上游写法都切五格', () => {
  assert.deepEqual(splitCells('| a | b |'), ['a', 'b']);
  assert.deepEqual(splitCells('| a | b |'), ['a', 'b']);
  assert.equal(splitCells('| a | b | c | d | e |').length, 5);
  assert.equal(splitCells('| a | b | c | d | e').length, 5);      // 实测上游有两种写法混用
});

check('isSeparatorLine 认两种真形状，isHeaderRow 认无竖线表头', () => {
  assert.equal(isSeparatorLine('|:---|:---|:---|:---|:---|'), true);
  assert.equal(isSeparatorLine('|---|:---|:---|:---|:---|'), true);
  assert.equal(isSeparatorLine('| [NASA](https://api.nasa.gov) | x | y | z | w |'), false);
  assert.equal(isHeaderRow(['API', 'Description', 'Auth', 'HTTPS', 'CORS']), true);
  assert.equal(isHeaderRow(['API ', ' Description']), true);       // 上游有带尾随空格的表头
  assert.equal(isHeaderRow(['NASA', 'x']), false);
});

/* ================= 区段 ================= */

check('extractRegion：起点整行相等，右界取下一个二级标题', () => {
  const r = extractRegion(BIG);
  assert.equal(r.ok, true);
  assert.equal(r.start, 92);                       // 实测 ## Index 在第 93 行
  assert.equal(r.endAnchor, '## License');
  assert.equal(r.lines[0].trim(), '## Index');
  assert.equal(r.lines[r.lines.length - 1].trim() === '## License', false);
});

check('extractRegion：子串命中不算锚（防「See the Index below」）', () => {
  const r = extractRegion('please see the Index below\n| [A](https://a.com) | d | No | Yes | Yes |\n## License');
  assert.equal(r.ok, false);
  // 两个候选起点都要报出来：只认英文那个的话，读这段的人会以为 CN 源也坏了。
  assert.match(r.fatal, /既没有「## Index」也没有「## 目录」/);
});

check('extractRegion：两份锚点在同一份正文里 ⇒ 按位置取靠前那一处，不按语言偏袒', () => {
  // 换源的过渡期真会出这种文档（有人把 CN fork 的目录贴在英文 README 上面，或反之）。
  // 这一条钉的是"谁在前听谁的"：写成"优先英文锚"或"优先中文锚"都会在这一发上红。
  const cnFirst = [
    '## 目录',
    '### 动物',
    '|:---|:---|:---|:---|',
    '| [Axolotl](https://theaxolotlapi.netlify.app/) | d | 否 | 是 |',
    '',
    '## Index',
    '### Animals',
    '|:---|:---|:---|:---|:---|',
    '| [Cat](https://cat.example) | d | No | Yes | Yes |',
    '',
    '## License',
  ].join('\n');
  const a = extractRegion(cnFirst);
  assert.equal(a.lines[0].trim(), '## 目录');
  assert.deepEqual(parseCatalog(cnFirst).entries.map((e) => e.name), ['Axolotl'], '取错锚点：读到后面那段英文表去了');

  const enFirst = [
    '## Index',
    '### Animals',
    '|:---|:---|:---|:---|:---|',
    '| [Cat](https://cat.example) | d | No | Yes | Yes |',
    '',
    '## 目录',
    '### 动物',
    '|:---|:---|:---|:---|',
    '| [Axolotl](https://theaxolotlapi.netlify.app/) | d | 否 | 是 |',
    '',
    '## License',
  ].join('\n');
  const b = extractRegion(enFirst);
  assert.equal(b.lines[0].trim(), '## Index');
  assert.equal(b.endAnchor, '## 目录', '右界该是紧随其后的那个二级标题，不管它叫什么名字');
  assert.deepEqual(parseCatalog(enFirst).entries.map((e) => e.name), ['Cat'], '取错锚点：偏袒了后面那段中文表');
  // 配对里写明的右界（## License）没对上 ⇒ 只登记一句，不阻断（这条上面那张图就靠它）
  assert.equal(b.expectedEnd, '## License');
});

check('extractRegion：整行里含「## Index」字样也不当锚（只认 trim 后全等）', () => {
  // 上游今天没有这种行，但这是「整行相等」这条规则唯一的可执行反例：
  // 改成 includes 的话，下面那句引导语会被认成目录起点，真正的 ## Index 那一段反而一行都读不到。
  const text = [
    '## About',
    'All entries live under the ## Index heading below, grouped by ### category.',
    '| [Early](https://early.example) | d | No | Yes | Yes |',
    '## Index',
    '### Animals',
    '|:---|:---|:---|:---|:---|',
    '| [Axolotl](https://theaxolotlapi.netlify.app/) | d | No | Yes | Yes |',
    '',
    '## License',
    '',
  ].join('\n');
  const r = extractRegion(text);
  assert.equal(r.ok, true);
  assert.equal(r.lines[0].trim(), '## Index');
  const p = parseCatalog(text);
  assert.equal(p.report.rows, 1);
  assert.deepEqual(p.entries.map((e) => e.name), ['Axolotl']);
  assert.deepEqual(p.report.skipped, []);
});

check('extractRegion：空正文报 fatal；没有右界就收到文件尾，并把这个事实登记下来', () => {
  assert.match(extractRegion('').fatal, /正文是空的/);
  assert.match(extractRegion('   \n\n').fatal, /正文是空的/);
  // ★ 2026-10-07 改判：CN 源整份文件只有一个二级标题（`## 目录`），目录区天然到 EOF。
  //   旧口径在这里报 END_ANCHOR_MISSING fatal，等于把真文档判成读不出来。
  //   守卫没变弱：起点锚仍然必须整行命中，一行表格都没读到 / 解析率不够照样停写库（另两支用例钉着）。
  const toEof = extractRegion('## Index\n### A\n|:---|\n| [A](https://a.com) | d | No | Yes | Yes |');
  assert.equal(toEof.ok, true, '没有下一个二级标题就该收到文件尾，不是 fatal');
  assert.equal(toEof.atEof, true);
  assert.equal(toEof.endAnchor, '', '到文件尾时右界必须留空 —— 不许和"收到了 ## License"混成同一个读数');
  // 中文起点同样能用（这是"加一档源只改登记表"那条口径的执行处）
  const cnStart = extractRegion('## 目录\n### 天气\n|:---|:---|:---|:---|:---|\n| [A](https://a.com) | 天气数据 | No | Yes | Yes |');
  assert.equal(cnStart.ok, true);
  assert.equal(cnStart.lines[0].trim(), '## 目录');
});

/* ================= 整份真 README ================= */

check('真 README：2019 行全收，零 skip（S0 原型卡在 2016 的三条尾随空格已吃掉）', () => {
  assert.equal(big.ok, true);
  assert.equal(big.report.rows, 2019);
  assert.equal(big.report.parsed, 2019);
  assert.equal(big.fatal, undefined);
  assert.deepEqual(big.report.skipped, []);
  assert.equal(big.report.parseRatio, 1);
  assert.equal(big.entries.length, 2019);
});

check('真 README：51 个分类，最大 Development 201、最小 Events 4，无空分类', () => {
  const c = big.report.categories;
  assert.equal(c.length, 51);
  const max = [...c].sort((a, b) => b.count - a.count)[0];
  const min = [...c].sort((a, b) => a.count - b.count)[0];
  assert.deepEqual([max.name, max.count], ['Development', 201]);
  assert.deepEqual([min.name, min.count], ['Events', 4]);
  assert.deepEqual(big.report.counts.emptyCategory, []);
});

check('真 README：鉴权分布逐字对账（合计 2019）', () => {
  assert.deepEqual(big.report.counts.byAuth, {
    No: 963, apiKey: 898, OAuth: 150, 'X-Mashape-Key': 6, 'User-Agent': 2,
  });
  const sum = Object.values(big.report.counts.byAuth).reduce((a, b) => a + b, 0);
  assert.equal(sum, 2019);
});

check('真 README：HTTPS 与 CORS 分布（脏值全落在 unknown，不在枚举里撒谎）', () => {
  assert.deepEqual(big.report.counts.byHttps, { Yes: 1931, No: 88, unknown: 0 });
  assert.deepEqual(big.report.counts.byCors, { Yes: 775, No: 227, unknown: 1017 });
});

check('真 README：两档预设的实测读数（免 key 963 / 浏览器直连 450）', () => {
  assert.equal(big.report.counts.noKey, 963);
  assert.equal(big.report.counts.browserDirect, 450);
  assert.equal(big.entries.filter((e) => e.auth === 'No').length, 963);
});

check('真 README：超长描述照收不截（12 条，最长 128 字那行是 Warnely）', () => {
  const o = big.report.overLongDesc;
  assert.equal(o.length, 12);
  const max = o.reduce((a, b) => (a.len >= b.len ? a : b));
  assert.deepEqual(max, { line: 1766, len: 128, name: 'Warnely' });
  const warnely = big.entries.find((e) => e.name === 'Warnely');
  assert.equal(warnely.desc.length, 128);                  // 台账报了 128，条目里也必须是 128 字全文
  assert.ok(DESC_SOFT_LIMIT === 100);
});

check('真 README：同名同分类 15 组 30 行，全组靠 URL 哈希消歧；同名同址 0 对', () => {
  // 15 组×2 行：两遍扫描的口径下 dupSlugs 记的是**行**，不是对（每组两条都带后缀，与行序无关）
  assert.equal(big.report.dupSlugs.length, 30);
  assert.equal(new Set(big.report.dupSlugs.map((d) => d.slug.split('::').slice(0, 2).join('::'))).size, 15);
  for (const d of big.report.dupSlugs) {
    assert.equal(d.slug.split('::').length, 3, `主键该是 分类::折叠名::URL哈希：${d.slug}`);
    assert.ok(!/#\d+$/.test(d.slug), `出现顺序号后缀说明改回过行序消歧：${d.slug}`);
  }
  assert.deepEqual(big.report.exactDups, []);
  assert.equal(new Set(big.entries.map((e) => e.slug)).size, big.entries.length);   // 主键全局唯一
});

check('真 README：同址不同分类 5 条被登记（api.nasa.gov / open-meteo 等）', () => {
  const urls = big.report.dupUrls.map((d) => d.url).sort();
  assert.deepEqual(urls, [
    'https://api.nasa.gov',
    'https://github.com/lukePeavey/quotable',
    'https://isitdownstatus.com',
    'https://open-meteo.com',
    'https://tastedive.com/read/api',
  ]);
});

check('真 README：每条都有 host 与分类，且 host 聚合头部对得上', () => {
  assert.equal(big.entries.filter((e) => !e.host).length, 0);
  assert.equal(big.entries.filter((e) => !e.category).length, 0);
  assert.deepEqual(big.report.hosts.slice(0, 3), [
    { host: 'github.com', count: 112 },
    { host: 'rapidapi.com', count: 24 },
    { host: 'developers.google.com', count: 17 },
  ]);
});

check('真 README：表头与分隔行没混进条目（50 个表头是无竖线形状）', () => {
  assert.equal(big.report.headerRows, 1);        // 只有 Blockchain 那一张带了竖线表头
  assert.equal(big.report.separatorRows, 51);
  assert.equal(big.entries.filter((e) => e.name === 'API').length, 0);
  assert.equal(big.entries.filter((e) => e.desc.includes(':---')).length, 0);
});

check('真 README：Index 区外的广告表与 MCP 表一条都没进来', () => {
  // ★ 排除判据是**区段**，不是条目名：IPstack / Marketstack / Weatherstack 确实各有一份合法条目
  //   （1248 / 1000 / 2483 行），上游只是又在 ## APILayer APIs 广告表里挂了一遍带 utm 的同一家的链接。
  const names = new Set(big.entries.map((e) => e.name));
  assert.equal(names.has('IPstack'), true);
  assert.equal(big.entries.filter((e) => e.line < 93).length, 0, '## Index 之前的行混进来了');
  assert.equal(big.entries.filter((e) => /Run In Postman|pstmn\.io/.test(`${e.name}${e.desc}${e.url}`)).length, 0);
  assert.equal(big.entries.filter((e) => /glama\.ai|mcp\.so|smithery\.ai/i.test(e.url)).length, 0);
  for (const banned of ['OpenSwissData', 'Kuro']) assert.equal(names.has(banned), false, `${banned} 属于区段外的 MCP 表`);
  assert.equal(big.report.endAnchorUnexpected, '');
  assert.equal(JSON.stringify(big.entries).length > 400 * 1024, true);   // 读数约 509 KB，缩水一半说明条目掉了
});

/* ================= 整份真文档：public-apis-cn（2026-10-07 起的目录真源） ================= */

const CN = await fixture('public-apis-cn-README.md');
const cn = parseCatalog(CN);

check('CN 真文档：1494 行全收、54 个分类、右界到文件尾且把这个事实单独登记', () => {
  assert.equal(cn.ok, true, `CN 文档读不出来：${cn.fatal}`);
  assert.equal(cn.report.rows, 1494);
  assert.equal(cn.report.parsed, 1494);
  assert.equal(cn.report.parseRatio, 1);
  assert.equal(cn.report.skipped.length, 0, `一条都不该被丢掉：${JSON.stringify(cn.report.skipped.slice(0, 3))}`);
  assert.equal(cn.report.counts.categoryCount, 54);
  assert.deepEqual(cn.report.counts.emptyCategory, []);
  // ★ 钉前提而不是钉文案：atEof 与 endAnchor 留空必须是同一个事实的两种说法。
  assert.equal(cn.report.endAtEof, true);
  assert.equal(cn.report.endAnchor, '');
  assert.equal(cn.report.endAnchorUnexpected, '');
  assert.equal(cn.report.headerRows, 5, 'CN 只有 5 个分类写了带文字的表头，其余靠分隔行');
  assert.equal(cn.report.separatorRows, 54);
  // 区段过滤仍然有效：CN 的「项目介绍」与目录列表那些行不该成条
  assert.equal(cn.entries.filter((e) => e.line < 7).length, 0, '## 目录 之前的行混进来了');
});

check('列形跟着这一档表的分隔行走：4 列的「AI模型」补齐 cors=unknown 并单独成一条 narrowSections 账', () => {
  assert.deepEqual(cn.report.narrowSections, [{ category: 'AI模型', cols: 4, rows: 23 }]);
  const ai = cn.entries.filter((e) => e.category === 'AI模型');
  assert.equal(ai.length, 23);
  assert.equal(ai.every((e) => e.cors === 'unknown'), true, '源里没有 CORS 列 ⇒ 全落 unknown');
  // 「源没给这一列」不等于「这格是脏值」：那 23 行一条都不该进逐格脏值台账。
  const rows = new Set(ai.map((e) => e.line));
  assert.equal(cn.report.unknownFields.filter((u) => u.column === 'cors' && rows.has(u.line)).length, 0);
  // 反证：同一份文档里 5 列的分类照旧收 CORS（不是把 cors 一律置成 unknown 蒙过去的）
  const tianqi = cn.entries.filter((e) => e.category === '天气');
  assert.equal(tianqi.some((e) => e.cors === 'Yes' || e.cors === 'No'), true);
});

check('半翻译的取值：是/否/未知 归一到枚举；语义不唯一的「是」落在鉴权列时不许猜，登记原值', () => {
  // 逐字枚举：CN 全文归一后仍落 unknown 的就这四格（换源那天点的数）
  assert.deepEqual(cn.report.counts.byAuth,
    { apiKey: 663, No: 673, OAuth: 149, 'X-Mashape-Key': 6, 'User-Agent': 1, unknown: 2 });
  const nim = cn.entries.find((e) => e.name === 'NVIDIA NIM');
  assert.equal(nim.auth, 'unknown', '「认证方式：是」没说是什么方式，猜成 apiKey 就是把没查过的说成查过的');
  assert.equal(nim.authRaw, '是');
  // 「否」与「无」语义唯一（不需要认证），实测 9 + 2 行
  assert.equal(cn.entries.find((e) => e.name === 'Ollama').auth, 'No');
  assert.equal(cn.entries.find((e) => e.name === 'LM Studio').auth, 'No');
  // 大小写脏值不猜：'YES' 一格照旧落 unknown 并进台账
  assert.equal(cn.report.unknownFields.find((u) => u.column === 'https')?.value, 'YES');
  const yes = cn.report.unknownFields.map((u) => u.column + ':' + u.value);
  assert.equal(yes.filter((v) => v === 'cors:未知').length, 0, '「未知」是 Unknown 的中文写法，不该算脏值');
  assert.ok(yes.includes('cors:Unkown'), '拼错的 Unkown 照第 3 条落 unknown 并登记');
});

check('分类名是身份不是文案：CN 的中文分类原样进主键，一个都不译', () => {
  assert.equal(cn.entries[0].slug, 'AI模型::nvidianim');
  assert.equal(cn.entries.filter((e) => e.category === '国内物流').length, 14);
  assert.ok(cn.entries.some((e) => e.slug === '国内物流::快递100'), '中文分类 + 中文名要能一起过主键这关');
  // 同名消歧那条规则对中文分类同样成立（分类名带 `::` 的机会由 SLUG_SEP 兜着）
  assert.equal(cn.report.exactDups.length, 0);
});

/* ================= 小夹具 ================= */

check('fx-trailing-space：三条尾随空格全收，URL 里不许留空格或尾斜杠', async () => {
  const r = parseCatalog(await fixture('fx-trailing-space.md'));
  assert.equal(r.report.rows, 3);
  assert.equal(r.report.parsed, 3);
  assert.deepEqual(r.report.skipped, []);
  assert.deepEqual(r.entries.map((e) => e.url), [
    'https://reqres.in', 'https://clockify.me/developers-api', 'https://digitransit.fi/en/developers',
  ]);
});

check('fx-overlong-desc：超 100 字照收并逐条登记，一条都不截', async () => {
  const r = parseCatalog(await fixture('fx-overlong-desc.md'));
  assert.equal(r.ok, true);
  assert.equal(r.report.parsed, r.report.rows);
  assert.equal(r.report.overLongDesc.length, r.report.rows);
  for (const e of r.entries) assert.ok(e.desc.length > 100, `${e.name} 的描述被改短了`);
});

check('fx-excluded-sections：只留 Index 区那 1 条，广告表与 MCP 表整体不吃', async () => {
  const r = parseCatalog(await fixture('fx-excluded-sections.md'));
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].name, 'Axolotl');
  assert.deepEqual(r.report.categories.map((c) => c.name), ['Fixture']);
  assert.equal(r.report.rows, 1);                       // 区段外的行连 rows 都不该计
});

check('fx-dup-slugs：同名两条各自成条，主键与行序无关（倒序再解析主键集合相同）', async () => {
  const text = await fixture('fx-dup-slugs.md');
  const r = parseCatalog(text);
  assert.equal(r.report.parsed, 24);
  assert.equal(r.report.dupSlugs.length, 4);              // 两组（Cat Facts / Dog Facts）× 每组两行，记的是行不是对
  assert.equal(new Set(r.report.dupSlugs.map((d) => d.slug.split('::').slice(0, 2).join('::'))).size, 2);
  assert.deepEqual(r.report.exactDups, []);
  const cats = r.entries.filter((e) => e.name === 'Cat Facts');
  assert.equal(cats.length, 2);
  assert.notEqual(cats[0].slug, cats[1].slug);

  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith('| [Axolotl'));
  const tail = lines.findLastIndex((l) => l.startsWith('| ['));
  const rows = lines.slice(head, tail + 1).reverse();
  const reversed = parseCatalog([...lines.slice(0, head), ...rows, ...lines.slice(tail + 1)].join('\n'));
  assert.deepEqual([...reversed.entries.map((e) => e.slug)].sort(), [...r.entries.map((e) => e.slug)].sort());
});

check('fx-bad-shapes：坏行按原因指名，脏值归 unknown 并登记', async () => {
  const r = parseCatalog(await fixture('fx-bad-shapes.md'));
  assert.equal(r.report.rows, 6);
  assert.equal(r.report.parsed, 4);
  assert.equal(r.report.skipped.length, 2);
  assert.match(r.report.skipped[0].reason, /标题格不是/);
  // 尺子来自这一档表自己的分隔行（CN 的「AI模型」是 4 列），不是写死的 5 —— 措辞要能把尺子念出来。
  assert.match(r.report.skipped[1].reason, /列数不足（有 2，这一档表 5 列）/);

  const kuro = r.entries.find((e) => e.name === 'Kuro');
  assert.equal(kuro.auth, 'OAuth');
  assert.equal(kuro.https, 'unknown');                  // 上游那行 HTTPS 列写的是 HTTP，不在 Yes/No 里
  assert.equal(kuro.cors, 'unknown');                   // – 不是 No
  const dash = r.entries.find((e) => e.name === 'DashCors');
  assert.deepEqual([dash.https, dash.cors], ['Yes', 'unknown']);
  const bt = r.entries.find((e) => e.name === 'BacktickYes');
  assert.deepEqual([bt.auth, bt.https, bt.cors], ['No', 'Yes', 'unknown']);

  const cols = r.report.unknownFields.map((u) => u.column + ':' + u.value).sort();
  assert.deepEqual(cols, ['cors:–', 'cors:–', 'https:HTTP']);   // 合法的 Unknown 不进脏值台账
});

check('fx-bad-shapes 的解析率闸门：4/6=0.667 低于 0.9 ⇒ ok=false 并报停写库', async () => {
  const r = parseCatalog(await fixture('fx-bad-shapes.md'));
  assert.equal(r.ok, false);
  assert.match(r.fatal, /解析率低于阈值/);
  assert.equal(r.entries.length, 4);                    // 条目照旧交出来，是不是写库由调用方按 ok 决定
});

check('fx-diacritics：重音名称折叠进主键，原文一字不改', async () => {
  const r = parseCatalog(await fixture('fx-diacritics.md'));
  assert.equal(r.ok, true);
  const ame = r.entries.find((e) => e.name === 'Améthyste');
  assert.equal(ame.slug, 'Fixture::amethyste');
  assert.equal(ame.name, 'Améthyste');                   // 显示名保留原文，只有主键折叠
  const marks = /[\u0300-\u036f]/;
  assert.ok(r.entries.every((e) => !marks.test(e.slug)), '主键里不许留组合音标');
});

check('同名同址（上游把一条写了两遍）：只留第一条并记 exactDups', () => {
  // 真 README 今天 0 对，所以这条规则只能靠合成行钉住；尾斜杠那版必须先被 normUrl 归一，
  // 否则它会被当成「两个不同地址」走进 dupSlugs，用户的一条 API 就变成两条可挂笔记的记录。
  const text = ['## Index', '### Animals', '|:---|:---|:---|:---|:---|',
    '| [Cat Facts](https://catfact.ninja/) | Fresh cat facts | No | Yes | Unknown |',
    '| [Cat Facts](https://catfact.ninja) | Fresh cat facts | No | Yes | Unknown |',
    '', '## License', ''].join('\n');
  const r = parseCatalog(text);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].slug, 'Animals::catfacts');       // 地址归一后只剩一个 ⇒ 主键不带哈希后缀
  assert.deepEqual(r.report.dupSlugs, []);
  assert.deepEqual(r.report.exactDups, [
    { line: 5, name: 'Cat Facts', url: 'https://catfact.ninja', category: 'Animals' },
  ]);
  assert.equal(r.report.parsed, 1);
  assert.equal(r.report.rows, 2);                             // 两行都计进 rows，闸门才不会被"半份目录"骗过
});

check('同名同址 + 另一个真地址：三条里两条成组带哈希，重复那条仍只留一份', () => {
  const text = ['## Index', '### Animals', '|:---|:---|:---|:---|:---|',
    '| [Cat Facts](https://a.example/) | one | No | Yes | Unknown |',
    '| [Cat Facts](https://b.example) | two | No | Yes | Unknown |',
    '| [Cat Facts](https://a.example) | one again | No | Yes | Unknown |',
    '', '## License', ''].join('\n');
  const r = parseCatalog(text);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map((e) => e.slug).sort(),
    [`Animals::catfacts::${shortHash('https://a.example')}`, `Animals::catfacts::${shortHash('https://b.example')}`].sort());
  assert.equal(r.report.exactDups.length, 1);
  assert.equal(r.report.dupSlugs.length, 2);                  // 只有真正两条不同地址那一对进 dupSlugs
});

check('fx-no-index 还是 fatal；fx-no-end 按换源那天的改判收到文件尾并登记（不是把守卫放宽）', async () => {
  const a = parseCatalog(await fixture('fx-no-index.md'));
  assert.equal(a.ok, false);
  assert.match(a.fatal, /既没有「## Index」也没有「## 目录」/);
  assert.deepEqual(a.entries, []);

  const b = parseCatalog(await fixture('fx-no-end.md'));
  assert.equal(b.ok, true, '没有下一个二级标题不再判死：CN 源的真实形状就是这样');
  assert.equal(b.report.endAtEof, true);
  assert.equal(b.report.endAnchor, '');
  assert.equal(b.report.rows, 1);
  assert.equal(b.report.parsed, 1);
  // 守卫换了个位置但没变松：区段里一条表格都没有 ⇒ ROWS_ZERO 照样 fatal（右界收到 EOF 也救不了它）。
  const empty = parseCatalog('## Index\n### Zoo\n后面一段表都没有\n');
  assert.equal(empty.ok, false);
  assert.match(empty.fatal, /一条表格行都没读到/);
});

check('parseCatalog：空文本与纯空白不抛，只报 fatal', () => {
  for (const bad of ['', '   ', '\n\n\t\n']) {
    const r = parseCatalog(bad);
    assert.equal(r.ok, false);
    assert.match(r.fatal, /正文是空的/);
    assert.equal(r.entries.length, 0);
    assert.equal(r.report.rows, 0);
  }
});

check('右界章节名漂移只登记不阻断（上游改名不等于目录坏了）', () => {
  const text = ['## Index', '### A', '|:---|:---|:---|:---|:---|',
    '| [Axolotl](https://theaxolotlapi.netlify.app/) | d | No | Yes | Yes |', '', '## Whatever Comes Next', ''].join('\n');
  const r = parseCatalog(text);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
  assert.equal(r.report.endAnchor, '## Whatever Comes Next');
  assert.equal(r.report.endAnchorUnexpected, '## Whatever Comes Next');
});

check('分类前的表格行单独成 skip（不当成上一个分类的条目）', () => {
  const text = ['## Index', '| [Early](https://early.example) | d | No | Yes | Yes |',
    '### A', '|:---|:---|:---|:---|:---|', '| [Late](https://late.example) | d | No | Yes | Yes |', '', '## License', ''].join('\n');
  const r = parseCatalog(text);
  assert.equal(r.report.rows, 2);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].name, 'Late');
  assert.match(r.report.skipped[0].reason, /在任何一个三级分类标题之前/);
});

check('台账派生：counts 与逐条重算逐字相等（界面不许自己再数一遍）', () => {
  const e = big.entries;
  assert.equal(big.report.counts.entries, e.length);
  assert.equal(big.report.counts.byHttps.Yes, e.filter((x) => x.https === 'Yes').length);
  assert.equal(big.report.counts.byCors.unknown, e.filter((x) => x.cors === 'unknown').length);
  const byCat = {};
  for (const x of e) byCat[x.category] = (byCat[x.category] || 0) + 1;
  assert.deepEqual(big.report.categories.map((c) => [c.name, c.count]).sort(), Object.entries(byCat).sort());
});

await runAll('parse');
