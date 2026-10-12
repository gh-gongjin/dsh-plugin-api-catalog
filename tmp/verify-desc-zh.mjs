import fs from 'node:fs';
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const srcAll = JSON.parse(fs.readFileSync('tmp/desc-src.json', 'utf8'));
const srcs = srcAll.items ? srcAll.items : srcAll;
let total = 0, bad = 0, echoTotal = 0;
for (const f of process.argv.slice(2)) {
  const echoes = [];
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  const part = f.match(/(\d+)\.json$/)[1];
  const inp = JSON.parse(fs.readFileSync(`tmp/desc-part-${part}.json`, 'utf8'));
  const ins = inp.items ? inp.items : inp;
  const errs = [];
  if (rows.length !== ins.length) errs.push(`条数 ${rows.length} != 输入 ${ins.length}`);
  const bare = (t) => t.split(' ').length <= 6 && t.length <= 45;
  const head = (t) => t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4);
  rows.forEach((r, i) => {
    const en = norm(r.en), want = norm(ins[i]?.en ?? ins[i]?.src ?? ins[i]);
    if (en !== want) errs.push(`第 ${i + 1} 条 en 未逐字对齐`);
    if (!r.zh || !norm(r.zh)) errs.push(`第 ${i + 1} 条 zh 空`);
    else if (!/[\u4e00-\u9fff]/.test(r.zh)) {
      if (bare(en) && head(en) === head(r.zh)) echoes.push(`${i + 1}:${en}`);
      else errs.push(`第 ${i + 1} 条 zh 无中文：${String(r.zh).slice(0, 40)}`);
    } else if (norm(r.zh) === en && en.length > 4) errs.push(`第 ${i + 1} 条 zh 照抄 en`);
  });
  total += rows.length; echoTotal += echoes.length;
  if (errs.length) { bad++; console.log(`${f} ✗ ${errs.length} 处：\n  ` + errs.slice(0, 6).join('\n  ')); }
  else console.log(`${f} ✓ ${rows.length} 条${echoes.length ? ` · 原样保留的纯专有名词 ${echoes.length} 条 [${echoes.join(' ')}]` : ''}`);
}
console.log(`[合计 ${total} / 1965 条 · 专有名词原样保留 ${echoTotal} · 坏片 ${bad}]`);
