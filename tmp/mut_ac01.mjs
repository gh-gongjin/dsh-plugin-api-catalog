/* api-catalog S1 首轮变异电池：把解析层的每条口径逐个改坏，看 test/parse.test.mjs 是否当场抓住。
 * 覆盖面：区段锚（子串命中 / 右界吃到 EOF）、主键（行序消歧回潮 / 同址第二条入库 / 重音折叠 / 分隔符）、
 *        字段归一（反引号 / Unknown 冒充 No / 括号内空格 / query 丢失 / 超长截断）、
 *        台账（表头计数 / host 聚合排序 / browserDirect 少筛）、闸门（解析率 / MIN_PARSE_RATIO / 期望右锚）。
 * 约定同 modelwatch：锚点在文件里必须恰好命中 1 次；跑完按字节还原并比 sha；
 * 只跑部分用 MUT_ONLY=PC-1,DM-2；ANCHOR_ONLY=1 只验锚点不跑用例。
 * 每条都必须被抓住（红）；「绿（漏网）」就是本轮的欠账。
 * 跑法（bash）：cd /f/dsh-plugins/dsh-plugin-api-catalog && node tmp/mut_ac01.mjs > tmp/ac01-mut.txt 2>&1
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'F:/dsh-plugins/dsh-plugin-api-catalog';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const PATHS = { parse: 'lib/parse.js', domain: 'lib/domain.js' };
const SUITE = 'test/parse.test.mjs';

const MUTS = [
  // ---- 区段 ----
  ['PC-1', 'parse', '起点锚从整行相等退化成子串命中（「See the Index below」这类句子就会被当目录起点）',
    'if (lines[i].trim() === ANCHOR_INDEX) { start = i; break; }',
    'if (lines[i].trim().includes(ANCHOR_INDEX)) { start = i; break; }'],
  ['PC-2', 'parse', '右界收不住时不再报 fatal，而是吃到文件末尾（MCP 表与广告表整段灌进目录）',
    "return { ok: false, fatal: PARSE_FATAL.END_ANCHOR_MISSING, lines: [], start: -1, end: -1, endAnchor: '' };",
    'return { ok: true, lines: lines.slice(start), start, end: lines.length, endAnchor: "" };'],
  ['PC-3', 'parse', '右界章节名漂移从「登记」升级成「阻断」（上游改个章节名就把整个插件判死）',
    'report.endAnchorUnexpected = region.endAnchor;',
    'return { ok: false, fatal: PARSE_FATAL.END_ANCHOR_MISSING, entries: [], report };'],
  // ---- 主键 ----
  ['PC-4', 'parse', '同名消歧后缀改挂行序（上游删掉第一条，剩下那条的主键就变了，笔记串到别的 API）',
    'const slug = multi ? slugOf(raw.category, raw.name, raw.url) : base;',
    'const slug = multi ? `${base}#${taken.size + 1}` : base;'],
  ['PC-5', 'parse', '同名同址的第二条不再丢弃（两个可挂笔记的主键指向同一条 API，台账 dupSlugs 也跟着撒谎）',
    'report.exactDups.push({ line: raw.line, name: raw.name, url: raw.url, category: raw.category });\n      continue;',
    'report.exactDups.push({ line: raw.line, name: raw.name, url: raw.url, category: raw.category });'],
  ['PC-6', 'parse', '主键折叠不做 NFD 拆解（上游把 É 改成 E 会被差分认成「删一条 + 加一条」）',
    ".normalize('NFD')", ".normalize('NFC')"],
  ['PC-7', 'parse', '主键不做小写折叠（上游把 "Cat Facts" 写成 "cat facts" 时键跟着变，笔记掉线）',
    "    .replace(COMBINING_RE, '')\n    .toLowerCase()", "    .replace(COMBINING_RE, '')"],
  // ---- 字段归一 ----
  ['PC-8', 'parse', '反引号不再剥（`apiKey` 落到枚举外，鉴权分布整片塌成 unknown）',
    'return String(v ?? \'\').trim().replace(/`/g, \'\').trim();',
    'return String(v ?? \'\').trim();'],
  ['PC-9', 'parse', 'Unknown/– 冒充 No（把「上游没查过」说成「不支持」，浏览器直连档会承诺打不开的东西）',
    "  return UNKNOWN;   // 含上游写的 Unknown", "  return 'No';   // 含上游写的 Unknown"],
  ['PC-10', 'parse', '链接括号内的空格不吃（实测 3 条尾随空格行重新变成 skip）',
    'const LINK_CELL_RE = /^\\[(.*?)\\]\\(\\s*(\\S+?)\\s*\\)$/s;',
    'const LINK_CELL_RE = /^\\[(.*?)\\]\\((\\S+)\\)$/s;'],
  ['PC-11', 'parse', 'URL 归一时把 query 一起砍掉（实测 60 条带参数的深链退回站点首页）',
    "u = u.replace(/\\/$/, '');", "u = u.replace(/[?#].*$/, '').replace(/\\/$/, '');"],
  ['PC-12', 'parse', '超长描述截到 100 字（用户以为自己看的是上游全文）',
    'const desc = cells[1];', 'const desc = cells[1].slice(0, DESC_SOFT_LIMIT);'],
  ['PC-13', 'parse', '空标题名的判定摘掉（`[](url)` 也能成条，界面出现点不动的空行）',
    "if (!name) return { ok: false, reason: '标题名为空' };", "if (false) return { ok: false, reason: '标题名为空' };"],
  // ---- 台账 ----
  ['PC-14', 'parse', '表头行计数摘掉（「上游加了第二张表头」这个信号丢失）',
    'if (isHeaderRow(cells)) { report.headerRows += 1; return; }',
    'if (isHeaderRow(cells)) { report.headerRows += 0; return; }'],
  ['PC-15', 'parse', 'host 聚合改成按字典序排（界面顶部的「一家供应商散在多处」再也数不出头部）',
    '.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))',
    '.sort((a, b) => (a[0] < b[0] ? -1 : 1))'],
  ['PC-16', 'parse', '「浏览器直连」少筛 HTTPS 条件（承诺了上游没说支持 HTTPS 的条目）',
    "browserDirect: entries.filter((e) => e.auth === 'No' && e.cors === 'Yes' && e.https === 'Yes').length,",
    "browserDirect: entries.filter((e) => e.auth === 'No' && e.cors === 'Yes').length,"],
  ['PC-17', 'parse', 'hostOf 不做形状闸门（`https://` 这类断链把 scheme 当 hostname 计进聚合）',
    "if (!looksLikeUrl(u)) return '';", "if (false) return '';"],
  // ---- 闸门（domain 侧常量）----
  ['PC-18', 'parse', '解析率闸门摘掉（表结构变了照样写库，旧快照被半份数据覆盖）',
    ": report.parseRatio < MIN_PARSE_RATIO ? PARSE_FATAL.BELOW_RATIO : '';", ": '';"],
  ['DM-1', 'domain', 'MIN_PARSE_RATIO 从 0.9 松到 0.5（四成行没读出来还继续写库）',
    'export const MIN_PARSE_RATIO = 0.9;', 'export const MIN_PARSE_RATIO = 0.5;'],
  ['DM-2', 'domain', '鉴权枚举收进 Bearer（上游新增值被静默吞掉，authRaw 台账永远空）',
    "export const AUTH_OPTIONS = ['No', 'apiKey', 'OAuth', 'X-Mashape-Key', 'User-Agent'];",
    "export const AUTH_OPTIONS = ['No', 'apiKey', 'OAuth', 'X-Mashape-Key', 'User-Agent', 'Bearer'];"],
  ['DM-3', 'domain', '期望右锚改回作废的 `## More Information`（真 README 每次同步都白报一次漂移）',
    "export const EXPECTED_END_ANCHOR = '## License';",
    "export const EXPECTED_END_ANCHOR = '## More Information';"],
];

const P = (f) => `${ROOT}/${PATHS[f]}`;
const ONLY = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const RUN = ONLY.length ? MUTS.filter((m) => ONLY.includes(m[0])) : MUTS;
const files = {};
for (const m of RUN) {
  const f = m[1];
  if (!files[f]) files[f] = fs.readFileSync(P(f), 'utf8');
}
const origins = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha(t)]));

const rows = [];
for (const [id, file, why, fromRaw, toRaw] of RUN) {
  const src = files[file];
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const fix = (s) => s.replace(/\r?\n/g, eol);
  const from = fix(fromRaw); const to = fix(toRaw);
  const hits = src.split(from).length - 1;
  if (hits !== 1) { rows.push({ id, file, error: hits === 0 ? 'ANCHOR_NOT_FOUND' : `ANCHOR_HITS_${hits}` }); console.log(`${id}  锚点问题：${hits} 次命中  ${file}`); continue; }
  if (process.env.ANCHOR_ONLY === '1') { rows.push({ id, file, ok: true }); console.log(`${id}  锚点 1 次  ${file}`); continue; }
  fs.writeFileSync(P(file), src.replace(from, to), 'utf8');
  const r = spawnSync('node', [SUITE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SKIP_LOCAL: '1' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const red = out.split('\n').filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim().replace(/^FAIL\s*/, ''));
  const tail = out.split('\n').filter((l) => l.includes('pass')).pop() || `exit ${r.status}`;
  fs.writeFileSync(P(file), src, 'utf8');
  const restored = sha(fs.readFileSync(P(file), 'utf8'));
  rows.push({
    id, file, why,
    verdict: red.length ? '红（被抓住）' : '绿（漏网！）',
    tail: tail.trim(), red: red.slice(0, 3), ok: restored === origins[file],
  });
  console.log(`${id}  ${rows[rows.length - 1].verdict}  ${file} · ${why}\n      ${tail.trim()}${red.length ? `\n      红例：${red.slice(0, 3).join(' / ')}` : ''}`);
}
const finalShas = Object.fromEntries(Object.keys(files).map((f) => [f, sha(fs.readFileSync(P(f), 'utf8'))]));
console.log('\n还原核对：', JSON.stringify({ origins, finalShas, allRestored: Object.keys(files).every((f) => finalShas[f] === origins[f]) }, null, 2));
if (rows.some((x) => x.error || (x.verdict && x.verdict.startsWith('绿')) || x.ok === false)) process.exitCode = 1;
