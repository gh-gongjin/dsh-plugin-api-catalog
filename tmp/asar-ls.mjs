/* tmp/asar-ls.mjs —— 只读地打开运行中的 app.asar：列出条目、按名字取文件内容。
   跑法：node tmp/asar-ls.mjs <路径正则>            → 列出命中的条目
         node tmp/asar-ls.mjs --grep <正则> [路径正则] → 在命中文件里搜（打印上下文）
   全程只读，不写宿主目录。 */
import fs from 'node:fs';

const P = 'D:/Deepseek harness desktop/resources/app.asar';
const fd = fs.openSync(P, 'r');
const h = Buffer.alloc(16);
fs.readSync(fd, h, 0, 16, 0);
const headerSize = h.readUInt32LE(4);
const strLen = h.readUInt32LE(12);
const hb = Buffer.alloc(strLen);
fs.readSync(fd, hb, 0, strLen, 16);
const root = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
const DATA = 8 + headerSize;

export function read(entry) {
  if (entry.unpacked || entry.offset === undefined) {
    return fs.readFileSync('D:/Deepseek harness desktop/resources/app.asar.unpacked/' + entry.p);
  }
  const b = Buffer.alloc(entry.size);
  fs.readSync(fd, b, 0, entry.size, DATA + Number(entry.offset));
  return b;
}

const files = [];
(function walk(node, path) {
  for (const [name, e] of Object.entries(node.files || {})) {
    const p = path ? `${path}/${name}` : name;
    if (e.files) walk(e, p); else files.push({ p, size: e.size, offset: e.offset, unpacked: !!e.unpacked });
  }
})(root, '');

const arg = process.argv[2];
if (arg === '--grep') {
  const re = new RegExp(process.argv[3], 'g');
  const pathRe = process.argv[4] ? new RegExp(process.argv[4]) : null;
  let hits = 0;
  for (const f of files) {
    if (pathRe && !pathRe.test(f.p)) continue;
    if (f.size > 40e6) continue;
    const text = read(f).toString('utf8');
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      hits++;
      console.log(`\n--- ${f.p} @${m.index}`);
      console.log(text.slice(Math.max(0, m.index - 260), m.index + 420).replace(/\n/g, '⏎'));
      if (hits > 12) break;
    }
    if (hits > 12) break;
  }
  console.log(`\n[hits ${hits}]`);
} else {
  const re = new RegExp(arg || '.', 'i');
  console.log(files.filter((f) => re.test(f.p)).map((f) => `${f.p} ${f.size}`).join('\n'));
}
