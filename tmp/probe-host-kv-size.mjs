// 只读取证：量宿主已有 storageDomain 落盘文件里「单个值」的最大体积 —— 回答 U-1（单值上限）需不需要真机。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.dsh', 'storages');
const out = [];
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
  const p = join(DIR, f);
  const size = statSync(p).size;
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { out.push(`${f} 文件 ${size}B 解析失败：${e.message}`); continue; }
  // 落盘形状：{表名:{键:值}} 或直接 {键:值}
  const tables = doc && typeof doc === 'object' ? Object.entries(doc) : [];
  let maxVal = { bytes: 0, path: '' };
  let nKeys = 0;
  for (const [t, rec] of tables) {
    if (!rec || typeof rec !== 'object') continue;
    for (const [k, v] of Object.entries(rec)) {
      nKeys += 1;
      const b = Buffer.byteLength(JSON.stringify(v));
      if (b > maxVal.bytes) maxVal = { bytes: b, path: `${t}/${k}` };
    }
  }
  out.push(`${f.padEnd(26)} 文件=${String(size).padStart(9)}B  记录=${String(nKeys).padStart(5)}  最大单值=${String(maxVal.bytes).padStart(8)}B  @${maxVal.path}`);
}
console.log(out.join('\n'));
