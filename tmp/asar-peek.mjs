/* tmp/asar-peek.mjs —— 从运行中的 app.asar 里按字符区间打印一个文件（只读）。
   跑法：node tmp/asar-peek.mjs <路径正则> <起> <止> */
import fs from 'node:fs';
const P = 'D:/Deepseek harness desktop/resources/app.asar';
const U = 'D:/Deepseek harness desktop/resources/app.asar.unpacked/';
const fd = fs.openSync(P, 'r');
const h = Buffer.alloc(16); fs.readSync(fd, h, 0, 16, 0);
const headerSize = h.readUInt32LE(4), strLen = h.readUInt32LE(12);
const hb = Buffer.alloc(strLen); fs.readSync(fd, hb, 0, strLen, 16);
const root = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
const DATA = 8 + headerSize;
const files = [];
(function walk(node, path) {
  for (const [name, e] of Object.entries(node.files || {})) {
    const p = path ? `${path}/${name}` : name;
    if (e.files) walk(e, p); else files.push({ p, size: e.size, offset: e.offset, unpacked: !!e.unpacked });
  }
})(root, '');
const re = new RegExp(process.argv[2]);
const f = files.find((x) => re.test(x.p));
if (!f) { console.log('没找到'); process.exit(1); }
const text = f.unpacked || f.offset === undefined
  ? fs.readFileSync(U + f.p, 'utf8')
  : (() => { const b = Buffer.alloc(f.size); fs.readSync(fd, b, 0, f.size, DATA + Number(f.offset)); return b.toString('utf8'); })();
const a = Number(process.argv[3] || 0), b = Number(process.argv[4] || 6000);
console.log(`# ${f.p} (${text.length} chars) [${a},${b}]`);
console.log(text.slice(a, b));
