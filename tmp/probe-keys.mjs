/**
 * tmp/probe-keys.mjs —— 真 README 上量键编码：合规性、唯一性、键长、以及「前缀撞了、靠哈希区分」有几组。
 * 只读，不碰库。读数往 spec §9.1b 抄。
 */
import fs from 'node:fs';
import path from 'node:path';
import { foldKey, parseCatalog } from '../lib/parse.js';
import { SLUG_SEP } from '../lib/domain.js';
import { categoryKey, noteKey, isSafeKey, KEY_MAX_LEN, KEY_RULE_VERSION } from '../lib/keys.js';

const text = fs.readFileSync(path.resolve('test/fixtures/public-apis-README.md'), 'utf8');
const { entries, report } = parseCatalog(text);

const cats = report.categories.map((c) => c.name);
const catKeys = cats.map((c) => categoryKey(c));
const slugKeys = entries.map((e) => noteKey(e.slug));

const unsafe = [...catKeys, ...slugKeys].filter((k) => !isSafeKey(k));
const longest = [...catKeys, ...slugKeys].reduce((a, b) => (b.length > a.length ? b : a), '');

const asciiFold = (s) => foldKey(s).replace(/[^a-z0-9]/g, '');

// 分类：完整折叠同形（不加哈希就一定撞）
const catByFoldFull = new Map();
for (const c of cats) catByFoldFull.set(asciiFold(c), [...(catByFoldFull.get(asciiFold(c)) || []), c]);
const catFoldCollisions = [...catByFoldFull.entries()].filter(([, l]) => l.length > 1);

// 笔记：前缀（含截断）撞了但 tail 不同的组 —— 这是哈希后缀真正在干活的场合
const noteByPrefix = new Map();
for (const e of entries) {
  const at = e.slug.indexOf(SLUG_SEP);
  const tail = e.slug.slice(at + SLUG_SEP.length);
  const prefix = `${categoryKey(e.category)}_${asciiFold(tail).slice(0, 24) || 'entry'}`;
  noteByPrefix.set(prefix, [...(noteByPrefix.get(prefix) || []), { slug: e.slug, tail, foldFull: asciiFold(tail) }]);
}
const notePrefixCollisions = [...noteByPrefix.entries()]
  .filter(([, l]) => new Set(l.map((x) => x.slug)).size > 1)
  .map(([prefix, l]) => ({
    prefix,
    slugs: l.map((x) => x.slug),
    dueToTruncation: new Set(l.map((x) => x.foldFull)).size === 1,
  }));

// 三 slug 段（同名消歧）的键样本 + 同分类同折叠名的组
const threeSeg = entries.filter((e) => e.slug.split(SLUG_SEP).length === 3);

console.log(JSON.stringify({
  keyRule: KEY_RULE_VERSION,
  KEY_MAX_LEN,
  categories: cats.length,
  distinctCategoryKeys: new Set(catKeys).size,
  entries: entries.length,
  distinctNoteKeys: new Set(slugKeys).size,
  unsafeKeys: unsafe.slice(0, 10),
  longestKey: { key: longest, length: longest.length },
  sampleCategoryKeys: catKeys.slice(0, 4),
  sampleNoteKeys: slugKeys.slice(0, 2),
  threeSegSlugs: threeSeg.map((e) => ({ slug: e.slug, key: noteKey(e.slug) })).slice(0, 4),
  catFoldCollisions,
  notePrefixCollisions,
}, null, 2));
