/**
 * test/make-fixtures.mjs —— 夹具生成器（可重跑，删了不损失信息）。
 *
 *   node test/make-fixtures.mjs            # 只用本地已有的大夹具切小片
 *   REFRESH=1 node test/make-fixtures.mjs  # 先从 jsDelivr 重新拉 README.md 再切片
 *
 * ★ 口径（sysops S16 那条「夹具不许比真机少」）：小夹具一律**从真 README 里切真行**，
 *   只有"上游还不存在的坏形状"才手编，且手编部分必须在文件头注明是哪几条真行拼的。
 */
import fs from 'node:fs';
import path from 'node:path';

const FIX_DIR = path.resolve('test/fixtures');
const BIG = path.join(FIX_DIR, 'public-apis-README.md');
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n');

if (process.env.REFRESH === '1') {
  const url = 'https://cdn.jsdelivr.net/gh/public-apis/public-apis@master/README.md';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`刷新失败 ${res.status} ${url}`);
  const text = await res.text();
  fs.writeFileSync(BIG, text, 'utf8');
  console.log(`refreshed ${Math.round(text.length / 1024)} KB`);
}
if (!fs.existsSync(BIG)) throw new Error('没有大夹具，先 REFRESH=1 跑一次');

const L = lines(BIG);
const idx = L.findIndex((l) => l.trim() === '## Index');
const lic = L.findIndex((l, i) => i > idx && l.trim().startsWith('## '));
if (idx < 0 || lic < 0) throw new Error('大夹具的区段锚找不到了，先核对上游结构');

/** 取包含 needle 的那一行（原样，行号进注释）。 */
function pick(needle) {
  const i = L.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`真 README 里没有这条：${needle}`);
  return L[i];
}
function pickAll(needle) {
  const hits = L.map((l, i) => (l.includes(needle) ? l : null)).filter(Boolean);
  if (!hits.length) throw new Error(`真 README 里没有这类行：${needle}`);
  return hits;
}

const HEADER = '## Index';
const END = '## License';
const tableHead = () => ['### Fixture', 'API | Description | Auth | HTTPS | CORS ', '|:---|:---|:---|:---|:---|'];
const wrap = (rows, note) => [`<!-- ${note} -->`, HEADER, ...tableHead(), ...rows, '', END, '[MIT](LICENSE) (c) 2022 public-apis', ''].join('\n');

function write(name, text) {
  fs.writeFileSync(path.join(FIX_DIR, name), text, 'utf8');
  console.log(`wrote ${name} (${text.length} B, ${text.split('\n').length} lines)`);
}

/* 1) 括号内尾随空格（真行 3 条，S0 原型就是被这三条卡在 2016/2019） */
write('fx-trailing-space.md', wrap([
  pick('reqres.in/ '),
  pick('clockify.me/developers-api '),
  pick('digitransit.fi/en/developers/ '),
], '真行：ReqRes / Clockify / Transport for Finland，链接括号里带尾随空格'));

/* 2) 超长描述（上游口径 ≤100，实测 12 条超） */
const over = L.filter((l) => {
  if (!l.startsWith('| [')) return false;
  const c = l.split('|').slice(1, -1);
  return c.length >= 5 && c[1].trim().length > 100;
}).slice(0, 12);
write('fx-overlong-desc.md', wrap(over, `真行：描述超 100 字的前 ${over.length} 条，最长 ${Math.max(...over.map((l) => l.split('|').slice(1, -1)[1].trim().length))} 字`));

/* 3) 区段外的两类表（广告 3 列 + MCP 的 Transport/Install）必须被排除 */
const adRow = pick('| [IPstack]');
const mcpRow = pick('glama.ai/mcp/connectors');
write('fx-excluded-sections.md', [
  '## APILayer APIs',
  '| API | Description | Call this API |',
  '|:---|:---|:---|',
  adRow,
  '',
  '## MCP Servers',
  '| Name | Description | Auth | Transport | Install |',
  '|:---|:---|:---|:---|:---|',
  mcpRow,
  '',
  HEADER,
  ...tableHead(),
  pick('theaxolotlapi.netlify.app'),
  '',
  END,
  '',
].join('\n'));

/* 4) 同分类同名（Animals 整块是真数据：两个 Cat Facts + 两个 Dog Facts） */
const animals = (() => {
  const s = L.findIndex((l) => l.trim() === '### Animals');
  if (s < 0) throw new Error('真 README 里没有 ### Animals');
  let e = s + 1;
  while (e < L.length && !L[e].trim().startsWith('### ') && !L[e].trim().startsWith('## ')) e += 1;
  return L.slice(s + 1, e).filter((l) => l.startsWith('| ['));
})();
if (animals.length < 10) throw new Error(`Animals 块只切到 ${animals.length} 行，不像真表`);
const dupNames = animals.map((l) => (l.match(/^\| \[([^\]]+)\]/) || [])[1]).filter((n) =>
  animals.filter((x) => x.startsWith(`| [${n}]`)).length > 1);
if (!dupNames.length) throw new Error('Animals 块里没有同名重复，这份夹具失去意义');
write('fx-dup-slugs.md', [
  HEADER,
  '### Animals',
  'API | Description | Auth | HTTPS | CORS ',
  '|:---|:---|:---|:---|:---|',
  ...animals,
  '',
  END,
  '',
].join('\n'));

/* 5) 脏值与坏形状：真行取样 + 三种真 README 里成形的坏行（列数不足 / 非链接标题 / 分类前的表行） */
write('fx-bad-shapes.md', [
  HEADER,
  '### Alpha',
  'API | Description | Auth | HTTPS | CORS ',         // 无竖线表头（实测上游 50/51 个表头就这形状）
  '|---|:---|:---|:---|:---|',                        // 另一种分隔行
  pick('| [wttr.in]'),
  '| Broken | no link here | No | Yes | Yes |',       // 标题不是 [名](址)
  '| [Short](https://x.example) | 少两列 |',           // 列数不足
  '',
  '### Beta',
  '|:---|:---|:---|:---|:---|',
  pick('| [Kuro]'),                                   // 鉴权与 CORS 全带反引号、CORS 写成半角破折号（真 MCP 行挪来做脏值样本）
  '| [DashCors](https://dash.example) | cors 用 – 的行 | No | Yes | – |',
  '| [BacktickYes](https://bt.example) | 三列全带反引号 | `No` | `Yes` | `Unknown` |',
  '',
  END,
  '',
].join('\n'));

/* 6) 重音与非 ASCII 名称（真行：只看标题格里有没有非 ASCII 字母） */
const accented = L.filter((l) => /^\| \[[^\]]*[À-ÿ\u0100-\u024F]/.test(l)).slice(0, 10);
if (!accented.length) throw new Error('真 README 里没找到含重音字符的标题行');
write('fx-diacritics.md', wrap(accented, `真行：名称含重音字符的前 ${accented.length} 条`));

/* 7) 没有 Index 锚 / 没有右界（两种 fatal 各一份） */
write('fx-no-index.md', ['### Animals', ...tableHead(), pick('theaxolotlapi.netlify.app'), '', END, ''].join('\n'));
write('fx-no-end.md', [HEADER, ...tableHead(), pick('theaxolotlapi.netlify.app'), '### Zoo', 'still in the index section', ''].join('\n'));

console.log('done');
