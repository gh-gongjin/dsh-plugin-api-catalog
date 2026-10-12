/**
 * tmp/mut-more.mjs —— 「继续加载」三条断言的反向验证。
 *
 * 这一轮改版里分页踩了三个坑，逐条用变异证明断言咬得住：
 *   ① searchQs 不发 offset（请求里压根没这个参数 ⇒ 点「继续加载」永远拿回第 1 页）
 *   ② 游标 ref 声明在 loadMore 之后（暂时性死区）+ 闭包读旧 result（每次都取回第 2 页）
 *   ③ 追加写成替换（前面那批被换掉，看起来"加载了"其实前面的没了）
 *   ④ 换筛选条件不清游标（新条件下跳过一片，且用户完全看不出来）
 *
 * ⚠ 备份必须落在独立文件（lib/query.js 那轮已经因为「把当前内容当 ORIG」自伤过一次）。
 */
import fs from 'node:fs';

const C = new URL('../client.js', import.meta.url);
const SRC = C.pathname.replace(/^\//, '');
const ORIG = `${SRC}.mutbase`;
const n = Number(process.argv[2] || 0);

const MUT = [
  {
    name: 'searchQs 不发 offset（点继续加载永远拿回第 1 页）',
    find: "      if (p.offset) q.set('offset', String(p.offset));",
    repl: "      if (false && p.offset) q.set('offset', String(p.offset));",
  },
  {
    name: '游标用闭包里的旧 result（每次都取回同一页）',
    find: '        const next = (cursorOffset.current || 0) + (cursorLimit.current || 0);',
    repl: '        const next = 100;',
  },
  {
    name: '追加写成替换（前面那批被换掉）',
    find: '            ? { ...prev, rows: [...prev.rows, ...r.rows], offset: r.offset, limit: r.limit, hasMore: r.hasMore, total: r.total }',
    repl: '            ? { ...prev, rows: [...r.rows], offset: r.offset, limit: r.limit, hasMore: r.hasMore, total: r.total }',
  },
  {
    // 连着四版都测不出（原因逐条记在上面那段注释里），换成最后一支真正能引入错位的：
    // **游标偏移量错位** —— 把 offset 记成"服务端返回的下一段起点"而不是"本次这一段的起点"，
    // 于是第二页从第 102 条起，界面看着有 200 行、实则第 101 条永远看不到。
    // 这是最容易真发生的错：两个字段都叫 offset，语义却差一整页。
    name: '游标语义差一整页（第二页从第 102 条起，第 101 条永远看不到）',
    find: '        if (result && Number.isFinite(Number(result.offset))) cursorOffset.current = Number(result.offset);',
    repl: '        if (result && Number.isFinite(Number(result.offset))) cursorOffset.current = Number(result.offset) + Number(result.limit || 0);',
  },
  {
    name: '加载时用界面自己的 rows.length 当游标（服务端夹过 limit 之后会跳片）',
    find: '        const next = (cursorOffset.current || 0) + (cursorLimit.current || 0);',
    repl: '        const next = (result?.rows?.length || 0);',
  },
  {
    name: '加载失败时把已显示的行清空（失败不该毁掉已经看到的）',
    find: "          setListErr(`下一页没接上：${e?.message ?? e}`);",
    repl: "          setResult((prev) => (prev ? { ...prev, rows: [] } : prev));\n          setListErr(`下一页没接上：${e?.message ?? e}`);",
  },
  {
    name: '加载中不显示任何反馈（用户点了不知道在转）',
    find: '          loadingMore\n                ? [1, 2, 3].map((i) => h(\'div\', { className: \'ac-skel\', key: `sk${i}` }))',
    repl: '          loadingMore\n                ? []',
  },
];

if (n === 0) {
  if (!fs.existsSync(ORIG)) { console.log('!! 没有基线，先跑 --save'); process.exit(4); }
  fs.writeFileSync(SRC, fs.readFileSync(ORIG));
  console.log('已从基线还原');
  process.exit(0);
}
if (process.argv.includes('--save')) {
  fs.writeFileSync(ORIG, fs.readFileSync(SRC));
  console.log('基线已存');
  process.exit(0);
}
if (!fs.existsSync(ORIG)) { console.log('!! 没有基线，先跑 --save'); process.exit(4); }
const base = fs.readFileSync(ORIG, 'utf8');
const m = MUT[n - 1];
if (!m) { console.log(`没有编号 ${n}（0=还原，--save=存基线，1..${MUT.length}）`); process.exit(2); }
if (!base.includes(m.find)) { console.log(`⚠ 锚点漂移：基线里找不到「${m.find.slice(0, 44).replace(/\n/g, '\\n')}…」⇒ 变异点要同步`); process.exit(3); }
fs.writeFileSync(SRC, base.replace(m.find, m.repl));
console.log(`已施加变异 ${n}：${m.name}`);