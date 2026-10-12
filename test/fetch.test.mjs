/**
 * test/fetch.test.mjs —— 抓取半边（lib/fetch.js）。
 *
 * 这里不碰库、不碰真网（真机那轮另说）：判据全是"降级链走对了没有、失败原因留没留下、
 * 上限拦没拦住"。三条最容易骗自己的：
 *  · 只断言"最后拿到了正文"就以为降级链对了 —— 不看 failures 就看不出第一个源是静默跳过的；
 *  · 用 text() 之后判长度当"上限生效" —— 真读进来过才知道拦得住；
 *  · 超时抢跑后不管那条还在飞的 promise —— 现场不留痕，宿主进程里凭空多一发 unhandled rejection。
 */
import { check, runAll, assert, makeFakeFetch, fixture } from './_helpers.mjs';
import { createHash } from 'node:crypto';
import { fetchOne, fetchCatalog, orderedSources, sha256Hex, sourceById } from '../lib/fetch.js';
import { SOURCES, FETCH_FAIL, MAX_BODY_BYTES, DEFAULT_PREFS, FETCH_TIMEOUT_MS } from '../lib/domain.js';

const README = await fixture('public-apis-README.md');
const CN_README = await fixture('public-apis-cn-README.md');
const URLS = Object.fromEntries(SOURCES.map((s) => [s.id, s.url]));
// 链上的位置从登记表来，不在用例里手抄源 id：换源那次（2026-10-07）就是靠这两行把整篇一次改对的。
const FIRST = SOURCES[0].id;
const SECOND = SOURCES[1].id;

/* ---------------- 成功半边 ---------------- */

check(`真源（链上第一档 ${FIRST}）200：正文、字节数、sha 三者都算得出`, async () => {
  const f = makeFakeFetch({ [URLS[FIRST]]: { status: 200, text: CN_README } });
  const got = await fetchCatalog({ fetchImpl: f });
  assert.equal(got.ok, true);
  assert.equal(got.sourceId, FIRST);
  assert.equal(got.bytes, Buffer.byteLength(CN_README, 'utf8'));
  assert.equal(got.bytes, 191468, '夹具字节数变了要同步 spec §9.1 的读数');
  assert.equal(got.sha, createHash('sha256').update(CN_README, 'utf8').digest('hex'));
  assert.deepEqual(got.failures, []);
});

check('中文源两档都不通时才走到降级源：拿到的仍是能解析的正文，失败那两档一条不少', async () => {
  const f = makeFakeFetch({
    [URLS[FIRST]]: { fail: 'getaddrinfo ENOTFOUND' },
    [URLS[SECOND]]: { status: 500 },
    [URLS.jsdelivr]: { status: 200, text: README },
  });
  const got = await fetchCatalog({ fetchImpl: f });
  assert.equal(got.ok, true, `降级没接住：${JSON.stringify(got.failures)}`);
  assert.equal(got.sourceId, 'jsdelivr');
  assert.equal(got.bytes, 291096, '降级那份就是英文夹具（读数变了同步 spec §9.1）');
  assert.deepEqual(got.failures.map((x) => x.sourceId), [FIRST, SECOND]);
  assert.deepEqual(got.failures.map((x) => x.code), [FETCH_FAIL.NETWORK, FETCH_FAIL.STATUS]);
});

check('sha 是正文的指纹：改一个字节就变（哈希门的前提）', () => {
  const a = sha256Hex(README);
  assert.equal(a, sha256Hex(README));
  assert.notEqual(a, sha256Hex(`${README}x`));
  assert.equal(a.length, 64);
  assert.equal(sha256Hex('').length, 64, '空正文也要有确定指纹，不能回空串');
});

check('全程只读 GET，且带 signal（红线：对上游一个字都不写）', async () => {
  const f = makeFakeFetch({ [URLS[FIRST]]: { status: 200, text: CN_README } });
  await fetchCatalog({ fetchImpl: f });
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].method, 'GET');
  assert.ok(f.seen[0].signal, '没带 signal 就意味着超时后连接还挂着');
});

check('没有 body 的 fetch 实现也走得通（兜底走 text()）', async () => {
  const f = makeFakeFetch({ [URLS.jsdelivr]: { status: 200, text: README, stream: false } });
  const got = await fetchCatalog({ fetchImpl: f });
  assert.equal(got.ok, true);
  assert.equal(got.bytes, Buffer.byteLength(README, 'utf8'));
  assert.equal(f.counts.textCalls, 1);
});

/* ---------------- 降级链 ---------------- */

check('第一个源 403：换下一个源拿到，且失败原因留在 failures 里', async () => {
  // 夹具按"这一档自己怎么解码"给（登记表说了算）：写死 base64 的话，链一重排这条就变成测解码。
  const second = SOURCES[1];
  const asBody = second.decode === 'base64'
    ? { json: { content: Buffer.from(CN_README, 'utf8').toString('base64') } }
    : { text: CN_README };
  const f = makeFakeFetch({
    [URLS[FIRST]]: { status: 403 },
    [URLS[SECOND]]: { status: 200, ...asBody },
  });
  const got = await fetchCatalog({ fetchImpl: f });
  assert.equal(got.ok, true, JSON.stringify(got.failures));
  assert.equal(got.sourceId, SECOND);
  assert.equal(got.bytes, 191468);
  assert.equal(got.failures.length, 1);
  assert.equal(got.failures[0].sourceId, FIRST);
  assert.equal(got.failures[0].code, FETCH_FAIL.STATUS);
  assert.match(got.failures[0].reason, /403/);
  assert.equal(f.seen.length, 2, '成功的源之后不该再多试第三个');
});

check('整条链全断：ok:false，但每一档失败一条不少（界面要逐个说得出）', async () => {
  const map = {};
  SOURCES.forEach((s, i) => {
    map[s.url] = i % 2 === 0 ? { fail: 'getaddrinfo ENOTFOUND' } : { status: 500 };
  });
  const f = makeFakeFetch(map);
  assert.equal(SOURCES.length >= 3, true, '登记表被改到三档以下 ⇒ 这一条测不到"一条不少"');
  const got = await fetchCatalog({ fetchImpl: f });
  assert.equal(got.ok, false);
  assert.equal(got.failures.length, SOURCES.length);
  assert.deepEqual(got.failures.map((x) => x.code),
    SOURCES.map((_, i) => (i % 2 === 0 ? FETCH_FAIL.NETWORK : FETCH_FAIL.STATUS)));
  assert.match(got.reason, new RegExp(`${SOURCES.length} 个源`));
});

check('优先级是用户定的：改了顺序就按新顺序试', async () => {
  const f = makeFakeFetch({
    [URLS['github-api']]: { status: 200, json: { content: Buffer.from(README, 'utf8').toString('base64') } },
    [URLS.jsdelivr]: { fail: '不该被试到' },
  });
  const got = await fetchCatalog({ sourcePriority: ['github-api', 'jsdelivr'], fetchImpl: f });
  assert.equal(got.ok, true);
  assert.equal(got.sourceId, 'github-api');
  assert.equal(f.seen.length, 1);
});

check('orderedSources：未登记的 id 消失，空值回落默认，绝不返回空链', () => {
  assert.deepEqual(orderedSources(['nope']).map((s) => s.id), []);
  assert.deepEqual(orderedSources([]).map((s) => s.id), DEFAULT_PREFS.sourcePriority);
  assert.deepEqual(orderedSources(undefined).map((s) => s.id), DEFAULT_PREFS.sourcePriority);
  assert.equal(sourceById('nope'), null);
});

/* ---------------- 上限与超时 ---------------- */

check('content-length 超上限：一个字节都不读就拒掉', async () => {
  const f = makeFakeFetch({
    [URLS[FIRST]]: { status: 200, text: 'x', headers: { 'content-length': String(MAX_BODY_BYTES + 1) } },
  });
  const got = await fetchCatalog({ fetchImpl: f });
  assert.equal(got.ok, false);
  assert.equal(got.failures[0].code, FETCH_FAIL.TOO_LARGE);
  assert.equal(f.counts.reads, 0, '声明超限还去读流，上限就成了事后统计');
  assert.equal(f.counts.textCalls, 0);
});

check('没有 content-length：流式累计到上限立刻中断', async () => {
  const huge = 'x'.repeat(MAX_BODY_BYTES + 10);
  const f = makeFakeFetch({
    [URLS[FIRST]]: { status: 200, text: huge, headers: { 'content-length': '' }, chunkSize: 256 * 1024 },
  });
  const got = await fetchCatalog({ fetchImpl: f });
  assert.equal(got.ok, false);
  assert.equal(got.failures[0].code, FETCH_FAIL.TOO_LARGE);
  assert.match(got.failures[0].reason, /已中断连接/);
  assert.equal(f.counts.cancels, 1, '超了没 cancel 就是让源继续灌');
  assert.ok(f.counts.reads <= Math.ceil(MAX_BODY_BYTES / (256 * 1024)) + 1, `读了 ${f.counts.reads} 块，中断得太晚`);
});

check('超时：到点就判 TIMEOUT，抢跑那条不留下 unhandled rejection', async () => {
  const seenRejections = [];
  const onTap = (r) => seenRejections.push(r);
  process.on('unhandledRejection', onTap);
  const f = makeFakeFetch({ [URLS[FIRST]]: { fail: '连接一直挂着', after: 60 } });
  const got = await fetchCatalog({ fetchImpl: f, timeoutMs: 10 });
  assert.equal(got.ok, false);
  assert.equal(got.failures[0].code, FETCH_FAIL.TIMEOUT);
  await new Promise((r) => setTimeout(r, 120));
  process.off('unhandledRejection', onTap);
  assert.deepEqual(seenRejections, [], `抢跑后没人接住 reject：${seenRejections[0]}`);
  // 光"判成超时"不够：那一发得真的掐掉，否则它还在源上占着连接飞。
  // 只断第一发：后面那些是"假 fetch 没登记 URL"直接 reject 的，本来就没走到该 abort 的那一支。
  assert.equal(f.seen.length, SOURCES.length, `第一个源超时后该把整条链试完：${f.seen.length}`);
  assert.equal(f.seen[0].signal.aborted, true, '超时后没 abort：抢跑那一发还占着连接');
});

check('默认超时会传给 fetchOne（不在调用方各写一个数）', async () => {
  assert.equal(FETCH_TIMEOUT_MS, 12000);
  const f = makeFakeFetch({ [URLS[FIRST]]: { status: 200, text: 'ok' } });
  const got = await fetchOne(sourceById(FIRST), { fetchImpl: f });
  assert.equal(got.text, 'ok');
});

/* ---------------- 解码 ---------------- */

check('GitHub Contents API：base64 带换行也解得回原文', async () => {
  const b64 = Buffer.from(README, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n');
  const f = makeFakeFetch({ [URLS['github-api']]: { status: 200, json: { content: b64 } } });
  const got = await fetchCatalog({ sourcePriority: ['github-api'], fetchImpl: f });
  assert.equal(got.ok, true);
  assert.equal(got.text.length, README.length);
  assert.equal(got.sha, sha256Hex(README));
  assert.equal(got.bytes, Buffer.byteLength(README, 'utf8'), '字节数要按解码后算，不然上限判错');
});

check('content 是混着非法字符的坏镜像：当场报 DECODE，不许交出一份"看着合法"的短正文', async () => {
  // Buffer.from(..., 'base64') 对非法字符是**静默丢弃**：一个被劫持/截断的镜像会解出非空的乱码正文，
  // 一路走到解析层报「目录读不出」，把源的问题说成上游改了结构 —— 差分还会把它当新一轮快照。
  // 只用 '@@@@' 那种解出空串的样本测不到这条（空串那一支由后面的判据兜住，字符集闸门等于没测）。
  const garbage = '<html>这不是 base64，是被劫持的镜像页</html>';
  const f = makeFakeFetch({ [URLS['github-api']]: { status: 200, json: { content: garbage } } });
  const got = await fetchCatalog({ sourcePriority: ['github-api'], fetchImpl: f });
  assert.equal(got.ok, false);
  assert.equal(got.failures[0].code, FETCH_FAIL.DECODE);
  assert.match(got.failures[0].reason, /不是 base64/, '报错要指到"这不是 base64"，不能把乱码说成上游给了空内容');
});

check('Contents API 给的不是 JSON / content 是空的 / 解出空正文：都归 DECODE', async () => {
  const notJson = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => { throw new Error('body 不是 JSON'); },
  });
  const got1 = await fetchCatalog({ sourcePriority: ['github-api'], fetchImpl: notJson });
  assert.equal(got1.ok, false);
  assert.equal(got1.failures[0].code, FETCH_FAIL.DECODE);

  const got2 = await fetchCatalog({
    sourcePriority: ['github-api'],
    fetchImpl: makeFakeFetch({ [URLS['github-api']]: { status: 200, json: { content: '' } } }),
  });
  assert.equal(got2.failures[0].code, FETCH_FAIL.DECODE);

  // '@' 不是合法 base64 字符，Buffer 会静默丢掉 ⇒ 解出空正文。这条必须报 DECODE，
  // 不能让它带着空正文往下走、由解析层报一句「正文是空的」（那是把源的问题说成上游改了结构）
  const got3 = await fetchCatalog({
    sourcePriority: ['github-api'],
    fetchImpl: makeFakeFetch({ [URLS['github-api']]: { status: 200, json: { content: '@@@@' } } }),
  });
  assert.equal(got3.ok, false);
  assert.equal(got3.failures[0].code, FETCH_FAIL.DECODE);
});

check('解码后的字节数也受上限约束（base64 源绕过判据的那条路堵上）', async () => {
  const huge = 'x'.repeat(MAX_BODY_BYTES + 10);
  const f = makeFakeFetch({
    [URLS['github-api']]: { status: 200, json: { content: Buffer.from(huge, 'utf8').toString('base64') }, headers: { 'content-length': '' } },
  });
  const got = await fetchCatalog({ sourcePriority: ['github-api'], fetchImpl: f });
  assert.equal(got.ok, false);
  assert.equal(got.failures[0].code, FETCH_FAIL.TOO_LARGE);
});

/* ---------------- 逐字判据 ---------------- */

check('fetch 半边不许出现写方法（红线：对上游只读）', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync('lib/fetch.js', 'utf8'));
  for (const banned of ['method: \'POST\'', 'method: \'PUT\'', 'method: \'DELETE\'', 'XMLHttpRequest']) {
    assert.equal(src.includes(banned), false, `lib/fetch.js 里出现了 ${banned}`);
  }
  assert.match(src, /method: 'GET'/);
});

await runAll('fetch');
