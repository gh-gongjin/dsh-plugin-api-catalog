/**
 * lib/keys.js —— per-record 布局的键编码（U-4 裁定的实现处）。
 *
 * 为什么需要这一层：宿主 per-record 把键直接当文件名（`<root>/<domain>/<table>/<key>.json`），
 * 写不过 SAFE_KEY_RE 就抛，读的时候不过就**静默当不存在**（本机 0.1.7-rc.2 实测：
 * `dsh-storage-json/lib/index.js:535` 抛、`:416` 静默跳过）。而我们的两种天然键都不合规：
 *   · 分类名带空格与 &（实测 51 类里 17 个）；
 *   · slug 带 `::`（分类与名称的分隔符）。
 *
 * ★ 一条规矩：前缀只是给人看的，**身份全靠 shortHash**。
 *   所以前缀被削短、被洗空、遇到非 ASCII 都撞不了键；反过来只靠前缀（直接拿 foldKey 当键）一定会撞 ——
 *   实测当前 51 类里前缀是唯一的，但同名同分类的一组里有一条真撞：
 *   Transportation 下两个「Transport for The Netherlands」折叠后前 24 字符一模一样
 *   （`transportforthenetherlan`），全靠尾哈希分开，读数在 spec §9.1b。
 *
 * ★ 键规则版本（KEY_RULE_VERSION）不进键里，但 meta 行要存一份：
 *   规则一改所有键全变，notes 是用户资产 ⇒ 必须走显式迁移（U-2b），不许当场重算装没事。
 */
import { SLUG_SEP, RECORD_KEY_RE } from './domain.js';
import { foldKey, shortHash } from './parse.js';

/** 键规则版本；与 meta 行的 keyRule 对得上才允许直接读，对不上走迁移。 */
export const KEY_RULE_VERSION = 1;

/** 前缀封顶：够人眼看出来是哪一类，又不至于让 note 键顶到路径长度。 */
const PREFIX_MAX = 24;

/** 单段哈希是 FNV-1a 32 位转 base36 ⇒ 最多 7 字符；键长上限据此推出来，不是拍的。 */
export const KEY_MAX_LEN = PREFIX_MAX * 2 + 7 * 2 + 2;

/**
 * foldKey 之后再把非 ASCII 字母数字洗掉：宿主那条是 `[a-zA-Z0-9_-]`，
 * 而 `\p{L}` 会把假名、西里尔字母一并留下 ⇒ 光靠 foldKey 不合规。
 * 洗空了也不影响身份（哈希还在），只是前缀没了。
 */
function asciiPrefix(raw) {
  return foldKey(raw).replace(/[^a-z0-9]/g, '').slice(0, PREFIX_MAX);
}

/** 是不是宿主认的键（Stores 写库前挡一道，别把抛异常留给落盘那一刻）。 */
export function isSafeKey(key) {
  return typeof key === 'string' && RECORD_KEY_RE.test(key) && key.length <= KEY_MAX_LEN;
}

/**
 * 分类 → entries 表的行键。
 * trim 是刻意的：标题写成「Animals 」与「Animals」是同一次同步里的同一类，不该看起来像搬家。
 * 除此之外**大小写与符号差异都算换类** —— 那是诚实口径：上游真改了名，差分就该报 removed+added 或 moved。
 */
export function categoryKey(category) {
  const raw = String(category ?? '').trim();
  return `${asciiPrefix(raw) || 'cat'}-${shortHash(raw)}`;
}

/**
 * slug → notes 表的行键（个人批注挂这里）。
 * 只在**第一个** `::` 处切：分类段与名称段各自带自己的哈希，
 * 所以即便上游把分类名写成含 `::` 的怪形状，也凑不出两个同键的 slug（见用例「分类名里含 ::」）。
 */
export function noteKey(slug) {
  const s = String(slug ?? '');
  const at = s.indexOf(SLUG_SEP);
  const category = at < 0 ? s : s.slice(0, at);
  const tail = at < 0 ? '' : s.slice(at + SLUG_SEP.length);
  return `${categoryKey(category)}_${asciiPrefix(tail) || 'entry'}-${shortHash(tail)}`;
}

/**
 * 原文 → trans 表的行键。★ 主键是**句子的内容哈希**，不是 slug、不是条目号：
 * 上游两条条目写同一句描述时只译一遍，而条目搬家/改名都不该让一句已经译好的中文失效。
 * 折叠空白与 descZhNorm（lib/desc-zh.js）同一个口径 —— 命中判据的一半是"两边用同一个归一函数"，
 * 这条由 test/desc-zh.test.mjs 的「归一化口径只有一处定义」钉着。
 * 原文长过任何上限都不影响键长（哈希定长）。
 * ★ 归一化只有 transNorm 这一处定义，落库的 src 与键都从它派生：两边都算键而行里存原样的话，
 *   zhMap 的键（行里的 src）就对不上读侧查的键（归一后的原文），中文存进去了却一句都显示不出来。
 */
export function transNorm(src) {
  return String(src ?? '').replace(/\s+/g, ' ').trim();
}

export function transKey(src) {
  return `t-${shortHash(transNorm(src))}`;
}

/**
 * 渠道 + 字段 → secrets 表的行键。
 * ★ channel 与 field 都是 domain.js 里登记的字面量（`^[a-z0-9][a-z0-9_]*$`），
 *   所以这里不需要前缀+哈希那一套：键要**人能看懂**（这些文件用户会翻），
 *   而任何不在登记表里的组合在写侧就被挡了（lib/stores.js 的 writeSecret）。
 */
export function secretKey(channel, field) {
  return `sec-${String(channel ?? '')}_${String(field ?? '')}`;
}
