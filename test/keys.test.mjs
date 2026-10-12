/**
 * test/keys.test.mjs —— per-record 键编码（lib/keys.js）。
 *
 * 这一层的判据只有一条：**宿主认不了键 = 数据静默消失**
 * （读侧 `dsh-storage-json/lib/index.js:416` 对不合规文件名是直接跳过，不报错）。
 * 所以真 README 的全量合规 + 全量唯一是主判据，构造用例只是把边界钉住。
 */
import { check, runAll, assert, fixture } from './_helpers.mjs';
import { parseCatalog } from '../lib/parse.js';
import { RECORD_KEY_RE, SLUG_SEP, META_KEY, PREFS_KEY } from '../lib/domain.js';
import { categoryKey, noteKey, isSafeKey, KEY_MAX_LEN, KEY_RULE_VERSION } from '../lib/keys.js';

const README = await fixture('public-apis-README.md');
const { entries, report } = parseCatalog(README);
const cats = report.categories.map((c) => c.name);

check('宿主闸门口径逐字对齐（RECORD_KEY_RE 变了必须同时改 keys.js）', () => {
  assert.equal(RECORD_KEY_RE.source, '^[a-zA-Z0-9_-]+$');
  assert.equal(KEY_RULE_VERSION, 1);
});

check('真 README：51 个分类键全部合规且互不相同', () => {
  assert.equal(cats.length, 51);
  const keys = cats.map((c) => categoryKey(c));
  assert.deepEqual(keys.filter((k) => !RECORD_KEY_RE.test(k)), []);
  assert.equal(new Set(keys).size, 51);
});

check('真 README：2019 条 slug 的笔记键全部合规且互不相同', () => {
  assert.equal(entries.length, 2019);
  const keys = entries.map((e) => noteKey(e.slug));
  assert.deepEqual(keys.filter((k) => !RECORD_KEY_RE.test(k)), []);
  assert.equal(new Set(keys).size, 2019);
});

check('真 README：17 个带空格或 & 的分类确实过不了原始闸门（编码层存在的原因）', () => {
  const rough = cats.filter((c) => /[\s&]/.test(c));
  assert.equal(rough.length, 17);
  assert.ok(rough.every((c) => !RECORD_KEY_RE.test(c)));
  assert.ok(rough.includes('Art & Design'));
});

check('实测正在撞的那一组：Transportation 两个同名条目靠尾哈希分开', () => {
  const group = entries.filter((e) => e.category === 'Transportation' && e.name === 'Transport for The Netherlands');
  assert.equal(group.length, 2);
  // 前缀（截断到 24）完全一样 ⇒ 去掉哈希后缀就塌成一条
  const prefixes = group.map((e) => noteKey(e.slug).slice(0, 'transportation-1f69lqb_transportforthenetherlan'.length));
  assert.equal(new Set(prefixes).size, 1);
  assert.equal(new Set(group.map((e) => noteKey(e.slug))).size, 2);
});

check('键长封顶：真数据最长键不超过 KEY_MAX_LEN，且上限推得出来', () => {
  const all = [...cats.map((c) => categoryKey(c)), ...entries.map((e) => noteKey(e.slug))];
  const longest = all.reduce((a, b) => (b.length > a.length ? b : a), '');
  assert.equal(longest.length, 62);
  assert.ok(longest.length <= KEY_MAX_LEN, `最长键 ${longest.length} 超过上限 ${KEY_MAX_LEN}`);
  // 上限 = 前缀 24×2 + 哈希 7×2 + 两个分隔符；不是拍的
  assert.equal(KEY_MAX_LEN, 24 * 2 + 7 * 2 + 2);
});

check('确定性：同输入两次调用相等（跨进程可复算，不落缓存）', () => {
  assert.equal(categoryKey('Animals'), categoryKey('Animals'));
  assert.equal(noteKey('Animals::catfacts::elyh91'), noteKey('Animals::catfacts::elyh91'));
});

check('尾空格不算搬家：trim 后同键（差分不许把排版当改名）', () => {
  assert.equal(categoryKey('Animals '), categoryKey('Animals'));
  assert.equal(noteKey('Animals ::catfacts'), noteKey('Animals::catfacts'));
});

check('大小写与符号差异算搬家：不同键（诚实口径，不许静默合并两个分类）', () => {
  assert.notEqual(categoryKey('animals'), categoryKey('Animals'));
  assert.notEqual(categoryKey('Art & Design'), categoryKey('Art and Design'));
});

check('非 ASCII 分类名：前缀被洗空但键仍合规、仍区分得开', () => {
  const a = categoryKey('アニメ');
  const b = categoryKey('アニメ ');
  const c = categoryKey('漫画');
  assert.match(a, /^cat-[a-z0-9]+$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(isSafeKey(a));
});

check('纯符号与空分类：走 cat 兜底，互不串门（trim 让它们合并是刻意的）', () => {
  const keys = ['', '??', '--'].map((c) => categoryKey(c));
  assert.ok(keys.every((k) => isSafeKey(k)));
  assert.equal(new Set(keys).size, 3);
  assert.match(keys[0], /^cat-[a-z0-9]+$/);
  // '   ' 与 '' 是同一条空分类：trim 后同键（差分不许把排版当新增）
  assert.equal(categoryKey('   '), categoryKey(''));
});

check('分类名里含 ::：切在第一处，两条不撞也不抛', () => {
  const k1 = noteKey(`A${SLUG_SEP}B${SLUG_SEP}c`);
  const k2 = noteKey(`A${SLUG_SEP}bc`);
  assert.ok(isSafeKey(k1) && isSafeKey(k2));
  assert.notEqual(k1, k2);
});

check('畸形 slug（没有分隔符 / 空串）：照样合规，不靠异常兜', () => {
  assert.ok(isSafeKey(noteKey('BareName')));
  assert.ok(isSafeKey(noteKey('')));
  assert.notEqual(noteKey(''), noteKey('BareName'));
});

check('isSafeKey 挡掉宿主会抛或会静默跳过的键', () => {
  assert.equal(isSafeKey('good_key-1'), true);
  assert.equal(isSafeKey('带 空格'), false);
  assert.equal(isSafeKey('a::b'), false);
  assert.equal(isSafeKey('../etc/passwd'), false);
  assert.equal(isSafeKey(''), false);
  assert.equal(isSafeKey('x'.repeat(KEY_MAX_LEN)), true);
  assert.equal(isSafeKey('x'.repeat(KEY_MAX_LEN + 1)), false);
  assert.equal(isSafeKey(null), false);
  assert.equal(isSafeKey(42), false);
});

check('meta 与 prefs 的固定键本来就合规（不需要编码）', () => {
  assert.ok(isSafeKey(META_KEY));
  assert.ok(isSafeKey(PREFS_KEY));
});

check('编码不吞哈希：不同 tail 段数（2 段与 3 段 slug）键不同', () => {
  const two = noteKey('Animals::catfacts');
  const three = noteKey('Animals::catfacts::elyh91');
  assert.ok(isSafeKey(two) && isSafeKey(three));
  assert.notEqual(two, three);
});

await runAll('keys');
