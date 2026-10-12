/* api-catalog S2 变异电池：把键编码 / 记录基座 / 五表仓储 / 一轮同步 / 抓取 / 装配的每条口径逐个改坏，
 * 看对应的离线用例是否当场抓住。
 * 覆盖面：键编码（身份靠哈希 / 非 ASCII / :: 切段 / trim / 键长闸门）、
 *        基座（schema 挡脏行 / 同域只 open 一次）、
 *        仓储（读-并-写 / 流水 id 补零 / trim 方向 / 排序尾键 / 撞键搬家不删笔记 / 源优先级补齐 / 档位闸门 / orphan）、
 *        同步（单飞 rejected / 哈希门 / 解析门 / 键规则门 / 写序 meta 最后 / baseline 不写流水 / 指纹不含时刻 /
 *             桥两侧唯一 / orphan 标注 / 退避封顶 / firstSeenAt 继承 / detail 截断 / 迁移只认有笔记的）、
 *        抓取（流式上限 / content-length 预拒 / 非 2xx / base64 字符集 / failures 台账 / abort / 源降级）、
 *        装配（disposer 语义 / 能力位谎报 / 每轮刷偏好视图 / 撞车不外抛 / tick 重挂 / teardown 停表 / config 白名单 / 首轮延迟钳）。
 * 约定同 S1：锚点在文件里必须恰好命中 1 次；跑完按字节还原并比 sha。
 * 跑法（bash）：
 *   cd /f/dsh-plugins/dsh-plugin-api-catalog && node tmp/mut_ac02.mjs ANCHOR_ONLY=1   （只验锚点）
 *   cd /f/dsh-plugins/dsh-plugin-api-catalog && node tmp/mut_ac02.mjs > tmp/ac02-mut.txt 2>&1
 * 只跑部分：MUT_ONLY=KE-1,SY-2。
 * 每条都必须被抓住（红）；「绿（漏网）」就是本轮的欠账，要当场判定：补用例还是承认判不到。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'F:/dsh-plugins/dsh-plugin-api-catalog';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

const PATHS = {
  keys: 'lib/keys.js',
  base: 'lib/kv-records-base.js',
  stores: 'lib/stores.js',
  schema: 'lib/kv-schema.js',
  sync: 'lib/sync.js',
  fetch: 'lib/fetch.js',
  index: 'index.js',
};
const SUITES = {
  keys: 'test/keys.test.mjs',
  store: 'test/store.test.mjs',
  sync: 'test/sync.test.mjs',
  fetch: 'test/fetch.test.mjs',
  assembly: 'test/assembly.test.mjs',
};

const MUTS = [
  // ---- 键编码（per-record 的命门：键不合规 = 读侧静默当不存在）----
  ['KE-1', 'keys', 'keys', '键的身份从哈希退化成前缀（实测 Transportation 下两个 Transport for The Netherlands 折叠前缀一模一样，批注会串到别人身上）',
    "  return `${asciiPrefix(raw) || 'cat'}-${shortHash(raw)}`;",
    "  return `${asciiPrefix(raw) || 'cat'}`;"],
  ['KE-2', 'keys', 'keys', '前缀不洗非 ASCII（假名分类名直接成为宿主不认的键名）',
    "  return foldKey(raw).replace(/[^a-z0-9]/g, '').slice(0, PREFIX_MAX);",
    '  return foldKey(raw).slice(0, PREFIX_MAX);'],
  ['KE-3', 'keys', 'keys', 'noteKey 在最后一个 :: 处切（分类名里含 :: 时两条不同 slug 凑出同一个批注键）',
    '  const at = s.indexOf(SLUG_SEP);',
    '  const at = s.lastIndexOf(SLUG_SEP);'],
  ['KE-4', 'keys', 'keys', '分类键不吃 trim（标题写成「Animals 」与「Animals」被判成搬家）',
    "  const raw = String(category ?? '').trim();",
    "  const raw = String(category ?? '');"],
  ['KE-5', 'keys', 'keys', '键长闸门摘掉（前缀封顶失效时写出顶到路径长度的键）',
    '  return typeof key === \'string\' && RECORD_KEY_RE.test(key) && key.length <= KEY_MAX_LEN;',
    "  return typeof key === 'string' && RECORD_KEY_RE.test(key);"],

  // ---- 记录基座 ----
  ['RB-1', 'base', 'store', 'schema 闸门摘掉（脏行直接落库，半条脏记录留在域里）',
    '      return domain.tables[tableName].valueSchema.parse(value);',
    '      return value;'],
  ['RB-3', 'base', 'store', '同域登记表作废（五张表各 open 一次 ⇒ 域名排他当场抛 already-open）',
    '  let entry = byName.get(domain.name);',
    '  let entry = undefined;'],

  // ---- schema：枚举集合 ----
  ['SC-1', 'schema', 'store', '可选枚举不吃允许集合（meta.lastStatus 能被写成任意字符串，界面按枚举渲染就落空）',
    '    if (v === undefined || v === null) return undefined;\n    if (typeof v !== \'string\' || !allowed.includes(v)) {',
    '    if (v === undefined || v === null) return undefined;\n    if (typeof v !== \'string\') {'],

  // ---- 五表仓储 ----
  ['ST-1', 'stores', 'store', 'meta 不再读-并-写（半份覆盖把 sha / counts / backoff 整行抹掉）',
    "        const merged = repo.parseOrInvalid({ ...cur, ...(fields && typeof fields === 'object' ? fields : {}) });",
    "        const merged = repo.parseOrInvalid({ ...(fields && typeof fields === 'object' ? fields : {}) });"],
  ['ST-2', 'stores', 'store', '流水 id 的同毫秒序号不补零（字典序把 c-…-9 排在 c-…-10 之后，trim 砍掉的是最新那批）',
    "          id: `c-${when}-${String(seq).padStart(4, '0')}`, at: when, kind,",
    '          id: `c-${when}-${seq}`, at: when, kind,'],
  ['ST-3', 'stores', 'store', 'trim 方向反了（留下最旧的 KEEP 条，把最新一轮的变化全砍了）',
    '        const doomed = rows.slice(n);',
    '        const doomed = rows.slice(0, Math.max(0, rows.length - n));'],
  ['ST-4', 'stores', 'store', '流水排序丢掉 id 尾键（同毫秒的多行退化成插入序，从库里重读时按文件名序就乱了）',
    '    return [...t.entries()].map(([, v]) => v).sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1));',
    '    return [...t.entries()].map(([, v]) => v).sort((a, b) => b.at - a.at);'],
  ['ST-5', 'stores', 'store', '搬家无条件删旧键（两条 slug 撞进同一个键时先 put 后 delete = 把用户的批注删了）',
    '        if (toKey !== fromKey) await t.delete(fromKey);',
    '        await t.delete(fromKey);'],
  ['ST-6', 'stores', 'store', '源优先级不补未排的源（用户把某源排到最后 = 永远不试它）',
    '  p.sourcePriority = [...picked, ...known.filter((id) => !picked.includes(id))];',
    '  p.sourcePriority = picked;'],
  ['ST-7', 'stores', 'store', '档位闸门摘掉（库里的 7 分钟被当成合法档位，节拍退化成 7 分钟一轮）',
    '    p.intervalMin = DEFAULT_PREFS.intervalMin;',
    '    p.intervalMin = Number.isFinite(Number(p.intervalMin)) ? Number(p.intervalMin) : DEFAULT_PREFS.intervalMin;'],
  ['ST-8', 'stores', 'store', 'setOrphan 不写回标记（上游删了条目，批注还显示成在册 API 的笔记）',
    '        const next = repo.parseOrInvalid({ ...cur, orphan });',
    '        const next = repo.parseOrInvalid({ ...cur });'],

  // ---- 一轮同步 ----
  ['SY-1', 'sync', 'sync', '单飞锁改成同步 throw（异常从宿主定时器回调里漏出去 = 整块打挂）',
    '      if (running) return Promise.reject(new SyncBusyError());',
    '      if (running) throw new SyncBusyError();'],
  ['SY-2', 'sync', 'sync', '哈希门摘掉（正文一模一样也整库重写一遍，per-record 下 51 个文件全动）',
    '    if (meta && meta.sha && meta.sha === fetched.sha) {',
    '    if (false) {'],
  ['SY-3', 'sync', 'sync', '解析门摘掉（表结构变了照样往下走，旧快照被半份数据覆盖）',
    '    if (!parsed.ok) {',
    '    if (false) {'],
  ['SY-4', 'sync', 'sync', '键规则门放开（旧键规则的 notes 还在库里就把新键写下去，批注变成看不见的文件）',
    '    if (meta && Number(meta.keyRule) !== KEY_RULE_VERSION) {',
    '    if (false) {'],
  ['SY-5', 'sync', 'sync', '写序被破坏：meta 在 entries 之前落（中途崩就留下"sha 已推进但目录是残缺的"假成功）',
    '      await stores.changes.appendMany(diff.ledger);',
    "      await stores.meta.patch({ keyRule: KEY_RULE_VERSION, sha: fetched.sha, lastStatus: 'success' });\n      await stores.changes.appendMany(diff.ledger);"],
  ['SY-6', 'sync', 'sync', '首轮基线也写流水（2019 条「上游新增」挤爆 200 行的流水，也不是事实）',
    '  if (!baseline) {',
    '  if (true) {'],
  ['SY-7', 'sync', 'sync', '内容指纹吃进 lastSeenAt（每轮时刻都新 ⇒ 51 行全被判成变了）',
    "const CONTENT_FIELDS = ['slug', 'name', 'url', 'host', 'desc', 'auth', 'https', 'cors', 'category'];",
    "const CONTENT_FIELDS = ['slug', 'name', 'url', 'host', 'desc', 'auth', 'https', 'cors', 'category', 'lastSeenAt'];"],
  ['SY-8', 'sync', 'sync', '配对桥不再要求上一侧唯一（歧义时随机认一条 ⇒ 批注可能挂到另一个 API 上）',
    '    if (!prevList || prevList.length !== 1) continue;',
    '    if (!prevList) continue;'],
  ['SY-9', 'sync', 'sync', '被删条目的批注不转 orphan（用户以为笔记不见了）',
    '      for (const slug of diff.noteOrphans) await stores.notes.setOrphan(slug, true);',
    '      for (const slug of []) await stores.notes.setOrphan(slug, true);'],
  ['SY-10', 'sync', 'sync', '退避不封顶（连续故障把节拍推到几十倍，恢复后一整天不更新）',
    '  return Math.min(clampBackoff(meta?.backoff) + 1, BACKOFF_STEPS.length - 1);',
    '  return clampBackoff(meta?.backoff) + 1;'],
  ['SY-11', 'sync', 'sync', 'firstSeenAt 不继承（每条都变成"刚加进来"，界面再也说不出这条在册多久）',
    '  const firstSeenByNext = new Map(pairs.map((p) => [p.next, Number(p.prev.firstSeenAt) || at]));',
    '  const firstSeenByNext = new Map();'],
  ['SY-12', 'sync', 'sync', '流水 detail 不截断（128 字描述抄两遍，流水不再是"一眼看出这轮动了什么"）',
    "  return s.length > CHANGE_DETAIL_MAX_LEN ? s.slice(0, CHANGE_DETAIL_MAX_LEN - 1) + '…' : s;",
    '  return s;'],
  ['SY-13', 'sync', 'sync', '搬家不再看有没有真笔记（为不存在的笔记生成迁移流水，台账谎报动过批注）',
    '    if (notes.has(p.prev.slug)) {',
    '    if (true) {'],

  // ---- 抓取 ----
  ['FE-1', 'fetch', 'fetch', '流式字节上限摘掉（源把 100 MB 灌进宿主进程）',
    '    if (total > cap) {',
    '    if (false) {'],
  ['FE-2', 'fetch', 'fetch', 'content-length 预拒摘掉（声明超限还照读，超限判定晚了几兆字节）',
    '  if (Number.isFinite(declared) && declared > cap) {',
    '  if (false) {'],
  ['FE-3', 'fetch', 'fetch', '非 2xx 不再判失败（错误页的 HTML 被当成目录正文）',
    '    if (!res.ok) throw new FetchFail(FETCH_FAIL.STATUS, `${source.label} 给了 HTTP ${res.status}`);',
    "    if (false) throw new FetchFail(FETCH_FAIL.STATUS, 'x');"],
  ['FE-4', 'fetch', 'fetch', 'base64 字符集预检摘掉（坏镜像静默解出"合法的短正文"，差分报出上游删了两千条）',
    '  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {',
    '  if (false) {'],
  ['FE-5', 'fetch', 'fetch', '全失败时不再交 failures 台账（界面只回一句"失败了"，说不出哪个源出了什么事）',
    "    reason: list.length ? `${list.length} 个源都没拿到正文` : '源优先级是空的，没有可试的源',\n    failures,",
    "    reason: list.length ? `${list.length} 个源都没拿到正文` : '源优先级是空的，没有可试的源',\n    failures: [],"],
  ['FE-6', 'fetch', 'fetch', '超时不再 abort 连接（抢跑那一发一直在飞，白占宿主一条socket）',
    '      controller.abort();',
    '      // 不 abort'],
  ['FE-7', 'fetch', 'fetch', '源降级摘掉（第一个源断了就整轮失败，备用源形同虚设）',
    '  for (const source of list) {',
    '  for (const source of list.slice(0, 1)) {'],

  // ---- 装配 ----
  ['AZ-1', 'index', 'assembly', '宿主 timer 的返回值被当 handle 去 clearInterval（disposer 从没被调 ⇒ 每轮叠加一发定时器）',
    '      if (typeof timerHandle === \'function\') timerHandle();\n      else clearInterval(timerHandle);',
    '      clearInterval(timerHandle);'],
  ['AZ-2', 'index', 'assembly', '能力位谎报：域 open 失败不参与 ⇒ 界面显示「存储在位」而每次写都在失败',
    '      Boolean(storageFacility) && !storageOpenFailure,',
    '      Boolean(storageFacility),'],
  ['AZ-4', 'index', 'assembly', '一轮跑完不刷偏好视图（库里的档位要到下一次装配才算数）',
    '      await reloadPrefs();\n      return result;',
    '      return result;'],
  ['AZ-5', 'index', 'assembly', '撞车那一发改成外抛（定时器回调里漏出异常）',
    '      return { ok: false, status: \'failure\', code: SYNC_BUSY.code, reason: why, skipped: true };',
    '      throw new Error(why);'],
  ['AZ-6', 'index', 'assembly', 'tick 跑完不重挂（退避倍率只写进库，节拍永远停在老档位）',
    '    // 节拍随退避变，所以每轮重挂；重挂必须在跑完之后（跑之前重挂等于把这一轮的时长也排进去）\n    reschedule();',
    '    // 节拍随退避变，所以每轮重挂；重挂必须在跑完之后（跑之前重挂等于把这一轮的时长也排进去）'],
  ['AZ-7', 'index', 'assembly', 'teardown 不停定时器（插件卸载后还在按节拍出网）',
    '    stopTimer();\n    for (const store of [stores.entries,',
    '    for (const store of [stores.entries,'],
  ['AZ-8', 'index', 'assembly', 'profile 配置不再走白名单（旧版残留的 proxyUrl 一路带进运行时，界面以为代理能配）',
    '  for (const key of Object.keys(DEFAULT_CONFIG)) {\n    if (key in src) cfg[key] = src[key];\n  }',
    '  Object.assign(cfg, src);'],
  ['AZ-9', 'index', 'assembly', '首轮延迟不钳上限（配成 24 小时等于把"定时更新"关了）',
    '  cfg.firstSyncDelayMs = clampInt(cfg.firstSyncDelayMs, DEFAULT_CONFIG.firstSyncDelayMs, 0, 300_000);',
    '  cfg.firstSyncDelayMs = Number(cfg.firstSyncDelayMs) || 0;'],
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
