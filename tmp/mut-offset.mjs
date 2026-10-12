/**
 * tmp/mut-offset.mjs —— offset 断言的反向验证：每一条变异对应一个编号，
 * bash 循环里 `node tmp/mut-offset.mjs <n>` 施加变异 → 跑测试 → 还原 → 再跑全量。
 *
 * 为什么要做：offset 这类"看起来就是slice(off, off+len)"的改动最容易出的错是
 * **排序与切片顺序颠倒**（第 2 页拿另一批条目）和 **hasMore 恒真**（界面上「继续加载」永远点得动）。
 * 这两种错在正例里都可能看不出来，只有让断言红一次才算真验过。
 *
 * ⚠⚠ 一次自伤事故后的写法（照抄，别改回去）：**备份必须落在一个独立文件里**。
 *   第一版把 ORIG = readFileSync(目标) 放在模块顶层，于是每次进程启动读到的都是**上一次留下的坏代码** ——
 *   第 1 轮变异之后那句 node mut-offset.mjs 0 只是把变异过的内容又写了回去，
 *   后面几条全部跑在污染过的源码上（还报"锚点漂移"，看着像变异点失效，其实是源码已经坏了）。
 *   判据：还原之后必须 diff 回基线，且基线文件不在 tmp/mut-offset.mjs.orig 这条路径的覆盖范围内。
 */
import fs from 'node:fs';

const Q = new URL('../lib/query.js', import.meta.url);
const SRC = Q.pathname.replace(/^\//, '');
const ORIG = `${SRC}.mutbase`;          // 独立基线文件：只由 --save 生成，其余一律从它还原
const n = Number(process.argv[2] || 0);

const MUT = [
  {
    name: '切片在排序之前（页与页之间顺序错乱）',
    find: '  const page = matched.slice(off, off + eff);',
    repl: '  const page = matched.slice(0, eff);',
  },
  {
    name: 'hasMore 恒真（界面「继续加载」永远点得动）',
    find: 'hasMore: off + rows.length < matched.length,',
    repl: 'hasMore: true,',
  },
  {
    name: 'offset 脏值回落成 limit（分页游标被猜）',
    find: "  const off = Number.isFinite(rawOffset) && rawOffset > 0\n    ? Math.min(SEARCH_OFFSET_MAX, Math.trunc(rawOffset))\n    : 0;",
    repl: '  const off = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : eff;',
  },
  {
    name: '翻过头返回全部条目（末页把整表又吐一遍）',
    find: '  const page = matched.slice(off, off + eff);',
    repl: '  const page = matched.length <= off ? matched : matched.slice(off, off + eff);',
  },
  {
    name: 'offset 不夹上界（1e15 直接进 slice）',
    find: '    ? Math.min(SEARCH_OFFSET_MAX, Math.trunc(rawOffset))',
    repl: '    ? Math.trunc(rawOffset)',
  },
  {
    name: '回传夹过的 limit 变成原值（界面下一起点会发 99999）',
    find: '  return { rows, total: matched.length, offset: off, limit: eff,',
    repl: '  return { rows, total: matched.length, offset: off, limit: Number(limit),',
  },
  {
    name: '排序放在切片之后（第 2 页顺序与第 1 页不接）',
    find: '  const page = matched.slice(off, off + eff);',
    repl: '  const page = matched.slice(off, off + eff).reverse();',
  },
];

if (n === 0) {
  if (!fs.existsSync(ORIG)) { console.log('!! 没有基线文件，先跑 node tmp/mut-offset.mjs --save'); process.exit(4); }
  fs.writeFileSync(SRC, fs.readFileSync(ORIG));
  console.log('已从基线还原');
  process.exit(0);
}
if (process.argv.includes('--save')) {
  fs.writeFileSync(ORIG, fs.readFileSync(SRC));
  console.log('基线已存：', ORIG);
  process.exit(0);
}
if (!fs.existsSync(ORIG)) { console.log('!! 没有基线文件，先跑 node tmp/mut-offset.mjs --save'); process.exit(4); }
const base = fs.readFileSync(ORIG, 'utf8');
const m = MUT[n - 1];
if (!m) { console.log(`没有编号 ${n} 的变异（0=还原，--save=存基线，1..${MUT.length}）`); process.exit(2); }
if (!base.includes(m.find)) { console.log(`⚠ 锚点漂移：基线里找不到「${m.find.slice(0, 46).replace(/\n/g, '\\n')}…」⇒ 变异点要同步`); process.exit(3); }
fs.writeFileSync(SRC, base.replace(m.find, m.repl));
console.log(`已施加变异 ${n}：${m.name}`);