/**
 * test/desc-zh.test.mjs —— 内置离线预译表 lib/desc-zh.js（S6）。
 *
 * 这一层的主判据不是「表里有多少条」，而是**覆盖面**：真 README 里每一条 desc 都得在表里查得到。
 * 两头都钉住：
 *   · 少了 → 界面上那一行没有中文（用户问的「为什么没有详情」换个形式回来）；
 *   · 多了 → 表里躺着已废弃的行，谁也不会发现（死数据 + 假覆盖数）。
 * 所以覆盖面与死行两条都从 parseCatalog(真夹具) 现算，不吃表自己的行数。
 * ★ 覆盖判据是**全量相等**，不带"除纯专有名词"这类豁免 —— 上一版写了个「短到几分词就算名字」的启发式，
 *   证伪时删掉一条四十字的真句子它照样绿（tmp/mut_desczh.mjs D1）。同形的 22 条现在照原样进表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { check, runAll, assert, fixture, sourceText } from './_helpers.mjs';
import { parseCatalog } from '../lib/parse.js';
import {
  DESC_ZH_AT, DESC_ZH_ORIGIN, DESC_ZH_NOTE, DESC_ZH_LABEL, DESC_ZH_ROWS, DESC_ZH_COUNT,
  descZhNorm, descZhFor, descZhHits, descZhView,
} from '../lib/desc-zh.js';

const { entries } = parseCatalog(await fixture('public-apis-README.md'));
const SRC = await sourceText('lib/desc-zh.js');
/** 真 README 的归一化原文集合（表应覆盖它，除纯专有名词）。 */
const truthSrcs = new Set(entries.map((e) => descZhNorm(e.desc)).filter(Boolean));
const hasHan = (t) => /[一-鿿]/.test(t);

// ★ 顺序有讲究：死行判据排在覆盖面前面。上游改了某条描述的措辞时两条都会挂，
//   但排在前面的那条才报得出真原因（表里躺着没了的行），覆盖面那条只会说「漏译」。
check('表里没有死行：每条 src 都能在真 README 里找到', () => {
  assert.ok(DESC_ZH_ROWS.length >= 1900, `表只有 ${DESC_ZH_ROWS.length} 行，多半没生成成功`);
  const orphan = DESC_ZH_ROWS.map(([s]) => s).filter((s) => !truthSrcs.has(s));
  assert.deepEqual(orphan.slice(0, 5), [], `表里 ${orphan.length} 行在上游已不存在：${orphan.slice(0, 3).join(' | ')}`);
});

check('覆盖面：真 README 里每一条原文都查得到（全量，不留"看着合理"的余地）', () => {
  assert.ok(truthSrcs.size >= 1900, `现算出的唯一原文只有 ${truthSrcs.size} 种，夹具多半没读全（覆盖面自证）`);
  const miss = [...truthSrcs].filter((s) => !descZhFor(s));
  assert.deepEqual(miss.slice(0, 5), [], `表里查不到 ${miss.length} 条：\n  ${miss.slice(0, 5).join('\n  ')}`);
});

check('主键唯一且每行形状合规（原文无汉字；译文有汉字，或与原文逐字同形）', () => {
  const dup = DESC_ZH_ROWS.length - new Set(DESC_ZH_ROWS.map(([s]) => s)).size;
  assert.equal(dup, 0, `${dup} 个重复主键：后写的行会静默盖掉前一行`);
  let same = 0;
  for (const [src, zh] of DESC_ZH_ROWS) {
    if (!src || !zh) throw new Error(`有空字段：${JSON.stringify([src, zh])}`);
    if (hasHan(src)) throw new Error(`原文列里出现了汉字（那不是待译原文）：${src.slice(0, 40)}`);
    // 没汉字只有一种合法情形：整条原文本身就是个名字，译文与它逐字相同（界面据此不标"预译"）。
    if (!hasHan(zh) && zh !== src) throw new Error(`译文既没汉字也不是原文：${src.slice(0, 40)} → ${zh}`);
    if (zh === src) same += 1;
    if (descZhNorm(src) !== src) throw new Error(`键没归一化，运行期查不到：${JSON.stringify(src.slice(0, 40))}`);
  }
  assert.ok(same >= 1, '一行"与原文同形"的都没有 —— 上面那条判据就成了空转');
  assert.equal(DESC_ZH_COUNT, DESC_ZH_ROWS.length);
});

check('命中判据钉的是前提：逐字相同才命中，改一个词就退回原文', () => {
  const src = DESC_ZH_ROWS[0][0];
  assert.ok(descZhFor(src), '原样查不到');
  assert.equal(descZhFor(src.replace(/a/, 'á')), '', '换个字母还命中 = 判据在做模糊匹配');
  assert.ok(descZhFor(`  ${src.replace(/ /g, '   ')}  `), '只差空白应当仍命中（归一化口径）');
  assert.equal(descZhFor(''), '');
  assert.equal(descZhFor(null), '');
  assert.equal(descZhFor(undefined), '');
  assert.equal(descZhFor('这一句上游不存在'), '');
});

check('descZhHits 与 descZhFor 同口径，且只收命中的', () => {
  const texts = [DESC_ZH_ROWS[0][0], DESC_ZH_ROWS[1][0], '上游不存在的一句', ''];
  const hits = descZhHits(texts);
  assert.equal(Object.keys(hits).length, 2);
  for (const t of texts.slice(0, 2)) assert.equal(hits[descZhNorm(t)], descZhFor(t));
  assert.deepEqual(descZhHits([]), {});
});

check('descZhView：行内显示取的 zh 永不为空，translated 只在真有中文时为真', () => {
  const eq = DESC_ZH_ROWS.filter(([s, z]) => s === z);
  assert.ok(eq.length >= 1, '没有"与原文同形"的行可验，translated 这条判据是空转');
  for (const [src] of eq) {
    const v = descZhView(src);
    assert.equal(v.zh, src);
    assert.equal(v.translated, false, `${src.slice(0, 30)} 中文与原文同形，却标了"预译"`);
  }
  const real = DESC_ZH_ROWS.find(([s, z]) => s !== z && hasHan(z));
  const rv = descZhView(real[0]);
  assert.equal(rv.translated, true);
  assert.equal(rv.zh, real[1]);
  // 表里没有的一句（上游改过词）也要能显示：退回原文，不许空串把那一格打掉。
  const gone = descZhView('a sentence the upstream rewrote yesterday');
  assert.equal(gone.zh, 'a sentence the upstream rewrote yesterday');
  assert.equal(gone.translated, false);
  assert.equal(descZhView('').zh, '');
  assert.equal(descZhView(null).zh, '');
});

check('界面上那句日期只有一份（NOTE/LABEL 都从 DESC_ZH_AT 拼，不许各写一个）', () => {
  assert.ok(DESC_ZH_NOTE.includes(DESC_ZH_AT) && DESC_ZH_LABEL.includes(DESC_ZH_AT));
  assert.ok(DESC_ZH_NOTE.includes(DESC_ZH_ORIGIN));
  const lit = SRC.split(DESC_ZH_AT).length - 1;
  assert.equal(lit, 1, `日期字面量在源码里出现 ${lit} 次，改一处会漏一处`);
});

check('这张表零出网、零模型句柄（抠掉数据段再扫，扫描面自己先自证）', () => {
  const start = SRC.indexOf('export const DESC_ZH_ROWS = [');
  const end = SRC.indexOf('\n];', start);
  assert.ok(start > 0 && end > start, '没抠出数据段边界（导出口径变了，本判据扫不到东西）');
  const code = SRC.slice(0, start) + SRC.slice(end);
  assert.ok(code.length > 800, `代码段只剩 ${code.length} 字符，抠法不对，别拿空文本当通过`);
  for (const re of [/fetch\s*\(/, /ctx\.llm/, /XMLHttpRequest/, /^\s*import\s/m, /require\s*\(/]) {
    if (re.test(code)) throw new Error(`内置表里出现了 ${re}：这张表按口径必须离线，运行期零出网`);
  }
});

check('归一化口径只有一处定义：抽原文的生成器不许自己再写一份正则', () => {
  const gens = fs.readdirSync(path.resolve('tmp')).filter((f) => /^gen-desc.*\.mjs$/.test(f));
  assert.ok(gens.length >= 1, 'tmp 下找不到 gen-desc*.mjs，判据没东西可扫');
  for (const g of gens) {
    const t = fs.readFileSync(path.resolve('tmp', g), 'utf8');
    assert.ok(t.length > 400, `${g} 只有 ${t.length} 字符，读的不是生成器`);
    assert.ok(/from '\.\.\/lib\/desc-zh\.js'/.test(t) && t.includes('descZhNorm'),
      `${g} 没引用 lib/desc-zh.js 的 descZhNorm：两处各写一份归一化，「逐字相同」就是假的`);
    assert.ok(!/replace\(\/\\s\+\/g,\s*' '\)\.trim\(\)/.test(t), `${g} 里还留着自己那份归一化正则`);
  }
});

await runAll('desc-zh');
