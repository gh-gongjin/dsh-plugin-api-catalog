/* api-catalog S3+S4 变异电池：把读侧口径（query）、路由与推流（api）、入口载荷（index）、
 * 浏览器半边（client）的每条判据逐个改坏，看离线用例是否当场抓住。
 * 覆盖面：搜索与打分（norm 抹分隔符 / 多词 AND / 四档序 / limit 三态 / hidden 只藏浏览态 /
 *        starred 不掺相关度 / category 与 host 精确 / truncated 如实 / facet 候选取自库里实际值 /
 *        派生句三态 / noteRows 的 orphan 与视图 / 引擎的 sha 缓存门 / host 聚合门槛与截断）、
 *        路由（body 自拼流 / 写操作回环门 / x-forwarded-for / 超长报错不截断 / limit 与 int 缺省口径 /
 *        405 与 404 / 撞车按 409 / 偏好落库即重挂 / orphan 不由界面写 / 删没有的批注 404 /
 *        SSE 首帧整份快照 / 快照坏了塞 error 帧 / update 帧同形 / : ok 冲缓冲 / 心跳摘牌 /
 *        facet 逗号同义 / body 尺寸上限 / slug 与标签闸门 / 档位白名单 / category 必填 / 存储错转 503 /
 *        严格读偏好 / 批注视图白名单 / 路由前缀剥离）、
 *        载荷（少推键 / 多推键 / 全局键名 / api 路径 / 源表只带界面要说的）、
 *        界面（详情跟行 / col 类名撞名 / 零浮层 / 禁 100vh / 草稿不被冲掉 /
 *        防抖 / 迟到响应 / 三态色 / 409 话术 / 三种空态 / POST 只带改过的字段 / 变更页跟后台轮重读 /
 *        从笔记跳回必开详情 / 不能下载就不演已下载 / 样式只一发 / 没载荷不注册入口 / 上限只取载荷 /
 *        update 帧整体替换）、
 *        2026-10-05 走查后裁定（AG-1 聚合条撤干净 / CAT-1..CAT-7 分类中文 + 原文并列：映射表、载荷带 label、
 *        侧栏两行、结果列、catMap 只认快照那份标签）、
 *        批注行的 name 快照（NM-1..NM-5：声明 / 只从在册条目取 / 条目消失不洗快照 / 读侧带出去 / 界面用起来）。
 * 约定同 S1/S2：锚点在文件里必须恰好命中 1 次；跑完按字节还原并比 sha。
 * 跑法（bash）——注意 ANCHOR_ONLY 是环境变量，写成 argv 不生效（会当成"跑全量"直接开跑）：
 *   cd /f/dsh-plugins/dsh-plugin-api-catalog && ANCHOR_ONLY=1 node tmp/mut_ac03.mjs
 *   cd /f/dsh-plugins/dsh-plugin-api-catalog && node tmp/mut_ac03.mjs > tmp/ac03-mut.txt 2>&1
 * 只跑部分：MUT_ONLY=QU-3,AP-7。
 * 每条都必须被抓住（红）；「绿（漏网）」就是本轮的欠账，要当场判定：补用例还是承认判不到。
 * 本轮判定为等价变异、已从电池里摘出的两条（各自的理由写在摘除处的注释上）：
 *   AP-25（prefs 的严格读改成宽容读：五表同域，快照那发必先 reject，走不到这一行）、
 *   AP-5（limitParam 的 `|| n <= 0`：两个下游同口径钳制，删了观测不到）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'F:/dsh-plugins/dsh-plugin-api-catalog';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

const PATHS = {
  query: 'lib/query.js',
  api: 'lib/api.js',
  index: 'index.js',
  client: 'client.js',
  domain: 'lib/domain.js',
  categories: 'lib/categories.js',
};
const SUITES = {
  query: 'test/query.test.mjs',
  api: 'test/api.test.mjs',
  client: 'test/client.test.mjs',
  hcompat: 'test/host-compat.test.mjs',
  store: 'test/store.test.mjs',
};

const MUTS = [
  // ---- 读侧：搜索、打分、聚合、派生句、缓存 ----
  ['QU-1', 'query', 'query', 'norm 不再抹 - _ 空格（搜 "open api" 的人因为上游写成 open-api 就查不到）',
    "  return String(v ?? '').toLowerCase().replace(/[\\s\\-_]/g, '');",
    "  return String(v ?? '').toLowerCase();"],
  ['QU-2', 'query', 'query', '多词从 AND 退成 OR（任何一词没命中不再出局，结果集里混进只沾一个词的条目）',
    '    if (!hit) return 0;',
    '    if (!hit) continue;'],
  ['QU-3', 'query', 'query', 'name 前缀与词中同档（"github" 排在 "octokit github client" 后面，最该先看的沉底）',
    '    if (rec.nameN.startsWith(w)) hit = SCORE.NAME_PREFIX;',
    '    if (rec.nameN.startsWith(w)) hit = SCORE.NAME;'],
  ['QU-4', 'query', 'query', 'limit 上限摘掉（界面问 10 万条就把 2019 条全塞进一帧）',
    '  const eff = Number.isFinite(n) && n > 0 ? Math.min(SEARCH_LIMIT_MAX, Math.trunc(n)) : SEARCH_DEFAULT_LIMIT;',
    '  const eff = Number.isFinite(n) && n > 0 ? Math.trunc(n) : SEARCH_DEFAULT_LIMIT;'],
  ['QU-5', 'query', 'query', 'hidden 从"只藏浏览态"变成"带关键词也藏"（§5 口径：藏的是默认别烦我，不是从库里消失）',
    '    if (!words.length && !includeHidden && note?.hidden === true) continue;',
    '    if (!includeHidden && note?.hidden === true) continue;'],
  ['QU-6', 'query', 'query', 'starred 不再影响浏览态次序（置顶的全部含义没了）',
    '  else matched.sort((a, b) => (b.note?.starred ? 1 : 0) - (a.note?.starred ? 1 : 0)\n    || String(a.rec.item.category).localeCompare(String(b.rec.item.category))\n    || byName(a, b));',
    '  else matched.sort((a, b) => String(a.rec.item.category).localeCompare(String(b.rec.item.category))\n    || byName(a, b));'],
  ['QU-7', 'query', 'query', 'CORS 未知说成"不支持"（第三种状态没了自己的文案，用户会拿它去接线上的东西）',
    '  else if (cors === UNKNOWN) out.push(CORS_LABELS.unknown);',
    '  else if (cors === UNKNOWN) out.push(CORS_LABELS.No);'],
  ['QU-8', 'query', 'query', '不支持 HTTPS 只留标签不补忠告（派生句是"注意事项"，只说不支持用户不知道该干什么）',
    "  if (String(entry?.https ?? UNKNOWN) === 'No') out.push(`${HTTPS_LABELS.No}：仍是明文，生产别用`);",
    "  if (String(entry?.https ?? UNKNOWN) === 'No') out.push(HTTPS_LABELS.No);"],
  ['QU-9', 'query', 'query', '笔记的 orphan 只认库里的标记（上游删了条目但差分还没写标记，那条笔记就假装还在册）',
    '    const isOrphan = !entry || note.orphan === true;',
    '    const isOrphan = note.orphan === true;'],
  ['QU-10', 'query', 'query', '「置顶」视图不筛（切过去看到的还是全量，四个视图各自问服务端就成了空话）',
    "    if (view === 'starred' && !note.starred) continue;",
    "    if (view === 'never-starred' && !note.starred) continue;"],
  ['QU-11', 'query', 'query', '索引缓存不再跟 sha 走（新一轮写完了读侧还在用旧索引，界面永远慢一轮）',
    '    if (cache && cache.sha === sha) return { ...cache, meta };',
    '    if (cache) return { ...cache, meta };'],
  ['QU-12', 'query', 'query', 'host 聚合的门槛退成 1（只有一条的供应商占九成，「散在多个分类」的信号被淹掉）',
    '    .filter((g) => g.count >= min)',
    '    .filter((g) => g.count >= 1)'],
  ['QU-13', 'query', 'query', '分类筛选摘掉（点一类等于没点，51 类那根栏是装饰）',
    '    if (cat && String(rec.item.category) !== cat) continue;',
    '    if (false && String(rec.item.category) !== cat) continue;'],
  ['QU-14', 'query', 'query', 'facet 候选不再兜底 UNKNOWN（上游脏值/缺列的那几条从筛选清单里消失，永远筛不出来）',
    '    const v = String(rec.item[field] ?? UNKNOWN);',
    "    const v = String(rec.item[field] ?? '');"],
  ['QU-15', 'query', 'query', 'truncated 永假（只列前 100 条却报"命中 2019 条"，界面说不出还有多少没看）',
    '  return { rows, total: matched.length, truncated: matched.length > rows.length };',
    '  return { rows, total: matched.length, truncated: false };'],
  ['QU-16', 'query', 'query', 'host 精确匹配摘掉（点一家供应商的结果里混进别家）',
    '    if (hostW && String(rec.item.host) !== hostW) continue;',
    '    if (false && String(rec.item.host) !== hostW) continue;'],
  ['QU-17', 'query', 'query', 'facet 筛选与清单两套兜底（清单按 unknown 报了数，点 unknown 却筛不出缺列那一条 —— S3 电池跑出来的真错）',
    '    if (!list.includes(String(item[field] ?? UNKNOWN))) return false;',
    "    if (!list.includes(String(item[field] ?? ''))) return false;"],

  // ---- 路由与推流 ----
  ['AP-1', 'api', 'api', 'POST body 不再自己从流里拼（宿主只传两个参数，真机上每条写请求都收到空 body）',
    '        body = await readBody(req);',
    '        body = req?.__parsedBody ?? {};'],
  ['AP-2', 'api', 'api', '写操作的回环门摘掉（服务被反代出去时，面板就成了改库的口子）',
    '    if (entry.loopback && !isLoopback(req)) {',
    '    if (false && !isLoopback(req)) {'],
  ['AP-3', 'api', 'api', '回环判定不看 x-forwarded-for（经代理进来 remoteAddress 仍是本机，门形同虚设）',
    "  return forwarded.every((hop) => hop === '127.0.0.1' || hop === '::1' || hop.startsWith('::ffff:127.0.0.1'));",
    '  return true;'],
  ['AP-4', 'api', 'api', '批注超长从报错改成不判（超界的半句话悄悄进不了库，用户以为存上了）',
    '    if (body.purpose.length > NOTE_PURPOSE_MAX_LEN) {',
    '    if (false) {'],
  // （AP-5 不在电池里：把 limitParam 的 `|| n <= 0` 删掉，离线面判不到 —— 两个下游本来就同口径。
  //   /api/search 那一发进 query.js:220 的 `n > 0 ? 夹取 : 默认`，/api/changes 那一发进 stores.js:296
  //   的同一句；limit=0 / -5 / 0.5 在变异体与原件上落库读数完全一样（都回落到各自默认）。
  //   这句 `n <= 0` 是第二遍说同一句话，删了不改变任何可观测行为 ⇒ 等价变异。
  //   "0 与没填是一回事"这条口径另有两处真判据：GET /api/search 的 limit 段与 GET /api/changes 的
  //   120 行真数据段（0 / abc / 空串都等于默认 100），两条在原件上都是绿的。）
  ['AP-6', 'api', 'api', 'intParam 不先判"有没有这个参数"（Number(null)=0 被夹到下限，hosts 的默认门槛 5 顶成 1）',
    "  if (raw === null || String(raw).trim() === '') return dflt;",
    '  if (raw === null) return dflt;'],
  ['AP-7', 'api', 'api', '路径存在但方法不对不再报 405（对 POST /snapshot 说"没有这个接口"，客户端按 404 说话就说错了）',
    '      if (PATH_METHODS.has(path)) {',
    '      if (false) {'],
  ['AP-8', 'api', 'api', '撞车那一发不再按 409（装配层给的是 {skipped:true}，回 200 等于说"跑完了"）',
    '      if (result?.skipped) return json(res, SYNC_BUSY.http, errBody(SYNC_BUSY.code, SYNC_BUSY.message));',
    '      if (false) return json(res, SYNC_BUSY.http, errBody(SYNC_BUSY.code, SYNC_BUSY.message));'],
  ['AP-9', 'api', 'api', '偏好落库后不重挂节拍（新档位要等下一轮才生效，§1 那条口径没了）',
    '      d.onPrefsSaved?.(saved);   // 落库之后立刻重挂节拍，否则新档位要等下一轮才生效',
    '      // 落库之后立刻重挂节拍，否则新档位要等下一轮才生效'],
  ['AP-10', 'api', 'api', 'orphan 改由界面写（用户删掉半句话就让一条笔记从"上游已删"变成"还在"）',
    '        orphan: Boolean(cur?.orphan),',
    '        orphan: Boolean(body.orphan ?? cur?.orphan),'],
  ['AP-11', 'api', 'api', '删一条不存在的批注报成功（界面说"批注已删除"而它本来就没有）',
    "      if (!cur) return json(res, 404, errBody('NOT_FOUND', `这条没有批注可删：${slug}`));",
    '      if (!cur) return jsonOk(res, { removed: slug });'],
  ['AP-12', 'api', 'api', '长连接接上不发首帧快照（客户端要"先 GET 再订阅"，两发之间有空窗）',
    "        sse.send('snapshot', await snapshotOf(d));",
    '        await snapshotOf(d);'],
  ['AP-13', 'api', 'api', 'SSE 首帧失败改为外抛（200 头已冲出去，再写一次头就是 ERR_HTTP_HEADERS_SENT，异常还会从 catch 逃逸）',
    "        sse.send('error', { code: err.code, message: err.message });",
    '        throw err;'],
  ['AP-14', 'api', 'api', 'update 帧发增量（客户端要自己拼，拼错一次就显示一份不存在的目录 —— gh-trending S17）',
    "    hub.broadcast('update', snap);",
    "    hub.broadcast('update', { builtAt: snap.builtAt, rows: snap.result.rows });"],
  ['AP-15', 'api', 'api', '首帧注释少一个空行（响应头冲不出去，浏览器卡在"连接中"）',
    "  res.write(': ok\\n\\n');",
    "  res.write(': ok\\n');"],
  ['AP-16', 'api', 'api', 'facet 不再认逗号写法（重复键与逗号同义是两侧口径，只认一种就各说一套）',
    "  const raw = url.searchParams.getAll(field).flatMap((v) => String(v).split(','));",
    '  const raw = url.searchParams.getAll(field).map((v) => String(v));'],
  ['AP-17', 'api', 'api', '心跳写失败不摘牌（断掉的连接留在 hub 里，每轮同步为它摊一份 2019 条的快照）',
    '      closed = true;\n      clearIntervalMod(hb);\n      onBroken?.();\n    }\n  };',
    '      closed = true;\n      clearIntervalMod(hb);\n    }\n  };'],
  ['AP-18', 'api', 'api', '请求体大小上限摘掉（一发 100 MB 的 JSON 就能把宿主进程压住）',
    '      if (size > MAX_BODY_BYTES) {',
    '      if (false) {'],
  ['AP-19', 'api', 'api', 'slug 长度闸门摘掉（顶到路径长度的键写进 notes 域，读侧静默当不存在）',
    "  if (slug.length > 300) throw new ApiError('INVALID_PARAM', `slug 过长（${slug.length} 字）`);",
    "  if (false) throw new ApiError('INVALID_PARAM', 'x');"],
  ['AP-20', 'api', 'api', '标签不再去空白/去空/去重（"a, ,a," 存成三个标签，界面里的计数与筛出的结果对不上）',
    "    const tags = [...new Set(body.tags.map((t) => String(t ?? '').trim()).filter(Boolean))];",
    "    const tags = body.tags.map((t) => String(t ?? ''));"],
  ['AP-21', 'api', 'api', '档位白名单摘掉（界面点不出 7 分钟，但脚本能写进去，节拍退成一个没人认识的档）',
    '    if (!CHECK_INTERVALS.includes(n)) {',
    '    if (false) {'],
  ['AP-22', 'api', 'api', 'category 不再必填（搬家时算不出新行，笔记从此挂在找不到它的键上）',
    "      if (!category) throw new ApiError('INVALID_PARAM', '缺少 category（搬家时靠它算新行，不许留空）');",
    "      if (false) throw new ApiError('INVALID_PARAM', 'x');"],
  ['AP-23', 'api', 'api', '存储侧的错不再转 503（那不是"参数不对"，界面会跟着说"改个条件再试"）',
    '  if (code === RECORDS_ERROR.UNAVAILABLE || code === RECORDS_ERROR.CLOSED || code === RECORDS_ERROR.INVALID) {',
    '  if (false) {'],
  ['AP-24', 'api', 'api', '详情读不到改成 200 + null（界面按"条目存在但读不出"说话，掩盖了上游删掉这一条）',
    "      if (!entry) return json(res, 404, errBody('NOT_FOUND', `目录里没有这一条：${slug}（上游可能删了，去「我的笔记」看批注还在不在）`));",
    '      if (!entry) return jsonOk(res, { entry: null });'],
  // （AP-25 不在电池里：把 snapshotOf 的 prefs 从 {strict:true} 改成宽容读，离线面判不到 ——
  //   五表共用一个域（§9.1c 的 facility.open 计数 1），快照这一发在 engine.snapshot 那一步就必然 reject，
  //   永远走不到 prefs 那一行。strict 这句口径另有两处判据：GET /api/prefs 的 503（E 段）与装配层的
  //   能力位（S2 电池 AZ-2，已红）。等价变异不假装成战果，也不当判据欠账。）

  ['AP-26', 'api', 'api', '批注视图不再校验（?view=tag 静默当"全部"，切视图与看到的行数对不上）',
    "      if (!['all', 'starred', 'tags', 'orphan'].includes(view)) throw new ApiError('INVALID_PARAM', `没有这种批注视图：${view}`);",
    "      if (false) throw new ApiError('INVALID_PARAM', 'x');"],
  ['AP-27', 'api', 'api', '路由前缀不剥（注册的是 prefix，宿主把整条路径递进来 ⇒ 每条路由都 404）',
    '  if (p.startsWith(`${ROUTE_PREFIX}/`)) return p.slice(ROUTE_PREFIX.length);',
    '  if (false) return p.slice(ROUTE_PREFIX.length);'],

  // ---- 入口载荷 ----
  ['IX-1', 'index', 'hcompat', '载荷少推一个界面真读的键（真机上那几枚标志画成 undefined）',
    '        authLabels: AUTH_LABELS,',
    '        authLabelsX: AUTH_LABELS,'],
  ['IX-2', 'index', 'hcompat', '载荷顺手多推一个界面不读的键（宿主侧口径漂进浏览器半边，两边就开始各有一份枚举）',
    '        parseNote: PARSE_NOTE,',
    "        parseNote: PARSE_NOTE,\n        authOptions: ['No', 'OAuth', 'API Key'],"],
  ['IX-3', 'index', 'hcompat', '全局键名字加一个字符（客户端永远读不到入口载荷，面板只会说"宿主还没推进来"）',
    '      name: GLOBAL_KEY,',
    "      name: GLOBAL_KEY + '-x',"],
  ['IX-4', 'index', 'hcompat', 'api 基址少打 /api（客户端每一发都打在 404 上）',
    '        api: `${ROUTE_PREFIX}/api`,',
    '        api: ROUTE_PREFIX,'],
  ['IX-5', 'index', 'hcompat', '源表整份推给界面（url / 凭据类字段跟着进了浏览器半边的全局对象）',
    '        sources: SOURCES.map((s) => ({ id: s.id, label: s.label, note: s.note })),',
    "        sources: SOURCES.map((s) => ({ ...s })),"],

  // ---- 浏览器半边 ----
  ['CL-1', 'client', 'client', '详情不再跟着那一行走（默认结果一屏 100 行，画在看不见的地方等于点了没反应）',
    '              if (expandedSlug === r.slug) {',
    '              if (false && expandedSlug === r.slug) {'],
  ['CL-2', 'client', 'client', 'col 类名与单元内 span 撞名（.ac-flag{display:block} 连 col 一起命中，fixed 布局不吃这一列的宽）',
    "            h('col', { className: 'ac-q-flag' }), h('col', { className: 'ac-q-flag' }), h('col', { className: 'ac-q-flag' }),",
    "            h('col', { className: 'ac-flag' }), h('col', { className: 'ac-flag' }), h('col', { className: 'ac-flag' }),"],
  ['CL-3', 'client', 'client', '表头从 sticky 改成 fixed（宿主主列 overflow:hidden，浮层会盖住别的面板 —— 零浮层铁律）',
    '.ac-tbl th{position:sticky;top:0;z-index:1;',
    '.ac-tbl th{position:fixed;top:0;z-index:1;'],
  ['CL-4', 'client', 'client', '分类栏按视口高度取高（100vh 在宿主主列里被裁 —— 外观插件真机抓过）',
    '.ac-rail-list{display:flex;flex-direction:column;gap:1px;max-height:460px;overflow-y:auto}',
    '.ac-rail-list{display:flex;flex-direction:column;gap:1px;max-height:calc(100vh - 120px);overflow-y:auto}'],
  ['CL-6', 'client', 'client', '输入框的值回到只认库里那份（后台那一轮跑完把用户正打的半句话冲掉）',
    "              value: d.purpose ?? note.purpose ?? '',",
    "              value: note.purpose ?? '',"],
  ['CL-7', 'client', 'client', '搜索不再防抖（打一个字发一发，宿主被问烦且迟到的响应成片）',
    '        timer.current = setTimeout(() => { loadSearch(filters); }, 250);',
    '        loadSearch(filters);'],
  ['CL-8', 'client', 'client', '迟到响应不再判序号（两发在飞时前一发把后一发覆盖掉）',
    '          if (searchSeq.current !== seq) return;\n          setResult(r);',
    '          setResult(r);'],
  ['CL-9', 'client', 'client', 'cors 的 unknown 用 No 的颜色（第三种状态在表里看起来就是"不支持"）',
    "    const flagClass = (v) => (v === 'Yes' ? 'ac-flag-yes' : v === 'No' ? 'ac-flag-no' : 'ac-flag-unk');",
    "    const flagClass = (v) => (v === 'Yes' ? 'ac-flag-yes' : 'ac-flag-no');"],
  ['CL-10', 'client', 'client', '撞车那一发按成功说话（409 与"跑完了"在界面上长一样）',
    "          if (e?.code === cfg().syncBusyCode) setSyncErr('上一轮同步还没结束，这一发被跳过（不并发跑第二轮）');",
    "          if (e?.code === cfg().syncBusyCode) setSyncNote('这一轮跑完，目录已更新');"],
  ['CL-11', 'client', 'client', '「条件太严」说成「库里还没有条目」（三种空态合一，用户去点同步而库里其实有 2019 条）',
    "                        : '这个条件下没有条目：换一个词，或清空筛选看全表。'),",
    "                        : '库里还没有条目：点页头「立即同步」跑第一轮。'),"],
  ['CL-12', 'client', 'client', '保存批注时把没改过的字段也一起发（置顶一下就把用户的正文覆盖成屏幕上那份）',
    '          if (d.tags !== undefined) body.tags = textToTags(d.tags);',
    '          body.tags = textToTags(d.tags);'],
  ['CL-13', 'client', 'client', '变更页的 effect 不再跟 snap 重读（定时器那一轮跑完，流水停在旧的那一份）',
    '      useEffect(() => { if (tab === \'changes\') loadChanges(changesKind); }, [tab, changesKind, loadChanges, snap]);',
    '      useEffect(() => { if (tab === \'changes\') loadChanges(changesKind); }, [tab, changesKind, loadChanges]);'],
  ['CL-14', 'client', 'client', '从笔记跳回目录不再强制开详情（那一条正是上次展开过的，就被"再点同一行收起"送回一个收起着的目录）',
    '        if (!force && detail && detail.slug === row.slug) { setDetail(null); setDraft({}); return; }',
    '        if (detail && detail.slug === row.slug) { setDetail(null); setDraft({}); return; }'],
  ['CL-15', 'client', 'client', '这个环境下载不了仍写「已下载为 …」（演一个没发生的动作）',
    "            canDownload ? h('span', { className: 'ac-card-n' }, '已下载为 api-catalog-notes.json') : null),",
    "            h('span', { className: 'ac-card-n' }, '已下载为 api-catalog-notes.json')),"],
  ['CL-16', 'client', 'client', '已有同 id 的样式还再塞一份（宿主重新激活时叠第二份 CSS）',
    '      if (document.getElementById(STYLE_ID)) return () => {};',
    '      // 已有同 id 也再塞一份'],
  ['CL-17', 'client', 'client', '载荷没到也注册入口（点开一个全是 404 的面板，比看不到入口更糟）',
    "      if (!cfg().routePrefix) return;   // 没路由前缀 = 没 webServer：一个入口都不注册（点开全是 404 的面板比看不到入口更糟）",
    '      // 没载荷也注册'],
  ['CL-18', 'client', 'client', '计数器写死 2000 而不是取载荷（服务端按别的数拒，界面那句"/ 2000"就是冒充）',
    '      const maxLen = Number(cfg().notePurposeMaxLen);',
    '      const maxLen = 2000;'],
  ['CL-19', 'client', 'client', 'update 帧被忽略（屏幕上的数字停在首屏那份，后台跑完一轮界面不跟着变）',
    "                if (ev === 'snapshot' || ev === 'update') setSnap(data);",
    "                if (ev === 'snapshot') setSnap(data);"],

  // ---- 2026-10-06「显示不全，为什么不能滚动」：滚动层必须在根上、且全场只此一发 ----
  ['CL-20', 'client', 'client', '撤掉根的 overflow-y:auto（宿主那一格是 overflow:hidden 且不滚 ⇒ 超出格子底边的内容被裁掉、没有一层能滚）',
    '  height:100%;overflow-y:auto;overscroll-behavior:contain;',
    '  height:100%;overscroll-behavior:contain;'],
  ['CL-21', 'client', 'client', '直接子项回到 flex 默认（根成了滚动容器后 column flex 会把子项按内容高度压扁 —— modelwatch 真机把页签条压成 1px）',
    '.ac-root>*{flex:none}',
    '.ac-root>*{flex:0 1 auto}'],
  ['CL-22', 'client', 'client', 'height:100% 写成 max-height:100%（第一代「这个框无法滚动」的截断写法，截图上看不出有东西被藏）',
    '  height:100%;overflow-y:auto;overscroll-behavior:contain;',
    '  max-height:100%;overflow-y:auto;overscroll-behavior:contain;'],

  // ---- 2026-10-05 用户真面板走查后的两处裁定 ----
  // CL-5 那一发（「聚合条只在目录画」）随 HostsStrip 一起退役，改判成 AG-1「撤了就不许回快照」；
  // CAT-* 钉的是「中文 + 原文小字并列」这条口径的四个面：映射表、读侧载荷、侧栏两行、结果列。
  ['AG-1', 'query', 'query', '撤掉的同 host 聚合又塞回快照（每轮推流摊 20 行没人读的数，载荷替一个不存在的界面占地方）',
    '        notes: { total: notes.size, orphan: orphanNotes },',
    '        hosts: hostGroups(records, { top: 20 }),\n        notes: { total: notes.size, orphan: orphanNotes },'],
  ['CAT-1', 'query', 'query', '分类清单不再带 label（界面拿不到中文，整栏退回英文）',
    'map(([name, count]) => ({ name, label: categoryLabel(name), count }))',
    'map(([name, count]) => ({ name, count }))'],
  ['CAT-2', 'categories', 'query', '查不到的分类回原文而不是空串（界面据此判断"有没有中文"，于是每个未映射分类都多出一行与原文一模一样的小字）',
    "  return CATEGORY_ZH[key] || '';",
    "  return CATEGORY_ZH[key] || key;"],
  ['CAT-3', 'categories', 'query', '标签表少配一个键（真数据 51 类里那一类在界面上悄悄只剩原文，没人会去数）',
    "  'Books': '图书',",
    "  'BooksX': '图书',"],
  ['CAT-4', 'client', 'client', '侧栏主名用上游原文（中文标签白做：这条线就是用户走查时点名的「分类要显示成中文」）',
    "                h('span', { className: 'nm' }, c.label || c.name),",
    "                h('span', { className: 'nm' }, c.name),"],
  ['CAT-5', 'client', 'client', '侧栏不画原文小字（中文是我们给的标签，只显中文就是冒充上游写了中文）',
    "                c.label ? h('span', { className: 'en' }, c.name) : null,",
    '                null,'],
  ['CAT-6', 'client', 'client', '结果列的分类标签用原文顶掉中文（侧栏中文、表格里英文，同一栏两套名字）',
    '                    catZh(cats, r.category) || r.category)),',
    '                    r.category)),'
  ],
  ['CAT-7', 'client', 'client', 'catMap 不吃快照那份 label，自己拿原文当中文（映射表漏配那一类就永远显示不出来，界面还自称有中文）',
    'for (const c of snap?.facets?.category || []) if (c.label) m.set(c.name, c.label);',
    'for (const c of snap?.facets?.category || []) m.set(c.name, c.name);'],

  // ---- 批注行的 name 快照（U-6 裁定：orphan 也要显示人话名；S5 收尾后补的一小段）----
  ['NM-1', 'domain', 'store', '批注行不再声明 name（record() 丢未声明字段 ⇒ 快照根本落不了库，orphan 又只剩 slug 尾巴）',
    "  name: optionalString('名称快照（上游删条目后界面还显示人话）'),",
    "  nameX: optionalString('名称快照（上游删条目后界面还显示人话）'),"],
  ['NM-2', 'api', 'api', 'name 优先吃界面递的那一份（用户能给不存在的条目安名字，也能把 orphan 的快照改成别的条目）',
    "        name: live?.name ?? cur?.name ?? '',",
    "        name: body.name ?? live?.name ?? cur?.name ?? '',"],
  ['NM-3', 'api', 'api', '条目一消失就把快照洗成空（orphan 那一行退回 slug 尾巴，正是 U-6 要修的病）',
    "        name: live?.name ?? cur?.name ?? '',",
    "        name: live?.name ?? '',"],
  ['NM-4', 'query', 'query', 'noteRows 不把 name 带出去（库里有快照，界面拿不到）',
    "      name: note.name || '',",
    "      name: '',"],
  ['NM-5', 'client', 'client', '界面不用批注自己的 name 快照（orphan 行只剩 norm 过的 slug 尾巴）',
    "                      h('span', { className: 'ac-nm' }, n.entry?.name || n.name || n.slug.split('::').slice(1).join('::')),",
    "                      h('span', { className: 'ac-nm' }, n.entry?.name || n.slug.split('::').slice(1).join('::')),"],
];

const P = (f) => `${ROOT}/${PATHS[f]}`;
const ONLY = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const RUN = ONLY.length ? MUTS.filter((m) => ONLY.includes(m[0])) : MUTS;
const files = {};
for (const m of RUN) {
  const f = m[1];
  if (!files[f]) files[f] = fs.readFileSync(P(f), 'utf8');
}
const origins = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha(t)]));

// ★ 起跑前先比一次基线 sha（记在 spec §9.1d）：上一轮中途挂掉会把变异留在树上，
//   拿脏文件当基线跑出来的红点就说不清是谁的了（mut_hc 那次假红就是这么来的）。
// 基线于 2026-10-05 走查修正后重记（分类中文标签 + 撤掉聚合条改了 query/client/domain，categories.js 是新增文件）。
const PRISTINE = { query: '6fc0713f82b6', api: '6a0527fc580b', index: 'a3f9f5020c48', client: '3b5330598bed', domain: 'cc9d383a5be2', categories: 'f14c68b465d0' };
for (const [f, s] of Object.entries(origins)) {
  if (PRISTINE[f] && PRISTINE[f] !== s) console.log(`!! ${PATHS[f]} 与记录的基线不一致（期望 ${PRISTINE[f]}，实际 ${s}）：先确认树上没留着变异`);
}

const rows = [];
for (const [id, file, suite, why, fromRaw, toRaw] of RUN) {
  const src = files[file];
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const fix = (s) => s.replace(/\r?\n/g, eol);
  const from = fix(fromRaw);
  const to = fix(toRaw);
  const hits = src.split(from).length - 1;
  if (hits !== 1) {
    rows.push({ id, file, error: hits === 0 ? 'ANCHOR_NOT_FOUND' : `ANCHOR_HITS_${hits}` });
    console.log(`${id}  锚点问题：${hits} 次命中  ${file}`);
    continue;
  }
  if (process.env.ANCHOR_ONLY === '1') {
    rows.push({ id, file, ok: true });
    console.log(`${id}  锚点 1 次  ${file}`);
    continue;
  }
  fs.writeFileSync(P(file), src.replace(from, to), 'utf8');
  const r = spawnSync('node', [SUITES[suite]], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SKIP_LOCAL: '1' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const red = out.split('\n').filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim().replace(/^FAIL\s*/, ''));
  const tail = out.split('\n').filter((l) => l.includes('pass ')).pop() || `exit ${r.status}`;
  fs.writeFileSync(P(file), src, 'utf8');
  const restored = sha(fs.readFileSync(P(file), 'utf8'));
  rows.push({
    id, file, suite, why,
    verdict: red.length ? '红（被抓住）' : '绿（漏网！）',
    tail: tail.trim(),
    red: red.slice(0, 3),
    ok: restored === origins[file],
  });
  console.log(`${id}  ${rows[rows.length - 1].verdict}  [${suite}] ${file} · ${why}\n      ${tail.trim()}${red.length ? `\n      红例：${red.slice(0, 3).join(' / ')}` : ''}`);
}
const finalShas = Object.fromEntries(Object.keys(files).map((f) => [f, sha(fs.readFileSync(P(f), 'utf8'))]));
const greens = rows.filter((x) => x.verdict && x.verdict.startsWith('绿')).map((x) => x.id);
console.log('\n汇总：', JSON.stringify({ total: RUN.length, caught: rows.filter((x) => x.verdict === '红（被抓住）').length, greens, anchorsBad: rows.filter((x) => x.error).length }, null, 2));
console.log('还原核对：', JSON.stringify({ origins, finalShas, allRestored: Object.keys(files).every((f) => finalShas[f] === origins[f]) }, null, 2));
if (rows.some((x) => x.error || x.verdict === '绿（漏网！）' || x.ok === false)) process.exitCode = 1;
