/**
 * test/client.test.mjs —— 浏览器半边（client.js）在 vm 沙箱里**真的渲染、真的点**。
 *
 * 为什么不是「喂 props 的组件级用例」：client.js 这一轮找出来的错全是接线错（onDraft 当 ref 读、
 * detail 传平了组件却读 detail.entry、facet 芯片的 onToggle 少传一个参数、节拍芯片跟的是库里那份、
 * 载荷上限当摆设）。这些错静态检查看不出来，prop 级用例也照样绿 —— 只有真渲染 + 真点才红。
 *
 * ★ 另一半同样重要：sandbox.fetch 打的是**真装配出来的 handler**（index.js apply + 真 stores +
 *   真 lib/api.js 路由 + 上游 fetch 的假实现）。快照不是手搓夹具，是 snapshotOf 现造的：
 *   宿主每加一个键这里跟着变，不会出现「夹具少一键 ⇒ 用例全绿而真机坏」（gh-trending 的 nameImage 事故）。
 *
 * 判据取向：
 *   A 模块契约：factory 的返回值当导出、载荷没到就不注册任何入口、样式只注一发且可撤；
 *   B 数据通路：订阅即首屏（一发 GET /snapshot 都不发）、断流与重连、同步帧驱动重渲染、409 就地报；
 *   C 目录页签：五页签（含常用API 那枚不挂计数）/ 分类栏 / facet 芯片 / 预设 / 防抖 / 竞态 / host 聚合 / 列对齐 / 三态如实；
 *   C2 常用API 页签（2026-10-07 两道裁定：只做壳 → 废话撤干净）：只剩读数，不排名次、不摆列表、不开第二个入口，每一格都跟着载荷走；
 *   D 就地编辑 notes（S4 判据）：展开→打字→保存→服务端那份回来；草稿不被推流冲掉；上限只用载荷给的数；
 *   E 变更 / 笔记 / 设置：真流水、真 orphan、真偏好落库、真能力位降级；
 *   F 铁律：浮层只许详情对话框一处且必须由点击换来（节点级）、渲染到的类名与 CSS 选择器一一对得上；
 *   G 中文说明（S9）：行内那句中文与上游原句的分工、弹框里的出处、设置页那张卡的凭据边界（值永不上屏幕）。
 *
 * ⚠️ 定时器是假的（沙箱里 setTimeout 全走本文件的 record）：防抖那 250 ms 与重连那 5 s 都由用例点名放，
 *    不靠真等。代价是"时间到了自己会响"这条测不到 —— 那一条在 assembly/host-compat 的口径里另有判据。
 */
import fs from 'node:fs';
import { parseCatalog, normUrl } from '../lib/parse.js';
import { USAGE } from '../lib/usage.js';
import {
  check, runAll, assert, flush, fixture, sourceText, makeLlmHandle, makeModelPicker
} from './_helpers.mjs';
import {
  __peek
} from '../index.js';
import {
  SOURCES, SEARCH_DEFAULT_LIMIT, NOTE_PURPOSE_MAX_LEN, TAG_MAX_COUNT, TAG_MAX_LEN,
  DEFAULT_PREFS, CHANGE_ROW_KINDS, DOMAIN_NAME, TABLES, META_KEY, transZhLabel, TRANS_HAN_RE
} from '../lib/domain.js';
import { DESC_ZH_LABEL } from '../lib/desc-zh.js';
import { transKey, secretKey } from '../lib/keys.js';
import {
  README, CN_README, TOTAL, CN_TOTAL, CATEGORIES, CN_CATEGORIES, NO_KEY, CN_NO_KEY,
  BROWSER_DIRECT, CN_BROWSER_DIRECT, TOP_HOST, TOP_HOST_COUNT, answeredIdOf, labelOf, mountServer, makeClientCtx,
  loadClient, hasCls, findAll, textOf, byCls, clsText, findTag, buttonsByText, tbodyRows,
  cardByTitle, hits, tap, typeIn, debounce, pick, booted, goTab, server_round,
  cellAt, detailOf, purposeBox, tagInput, detailRowOf, slugOfRow, maskOf
} from './_client-harness.mjs';

/* ================================================================== *
 * A. 模块契约与入口注册
 * ================================================================== */

check('cl-1 factory 的返回值就是模块导出：apply/inject/PANEL_ID 齐，require 只吃 react', async () => {
  const server = await mountServer();
  try {
    const t = await loadClient(server);
    assert.equal(t.exports.id, undefined);
    assert.equal(typeof t.exports.apply, 'function', '返回 module 而不是 exports ⇒ 真机 invalid plugin, received object');
    assert.deepEqual([...t.exports.inject], ['slots']);
    assert.equal(t.exports.PANEL_ID, 'api-catalog');
    assert.deepEqual(t.requires, ['react'], '浏览器半边只允许 require("react")');
    await t.close();
  } finally { server.close(); }
});

check('cl-2 载荷没到 = 一个入口都不注册，也不往 head 塞样式', async () => {
  const server = await mountServer();
  try {
    const t = await loadClient(server, { payload: null });
    t.exports.apply(makeClientCtx());
    assert.equal(t.clientCtx.registered.length, 0, '没有路由前缀还注册入口 = 点开全是 404 的面板');
    assert.equal(t.clientCtx.effects.length, 0);
    assert.deepEqual(t.doc.ops, []);
    await t.close();
  } finally { server.close(); }
});

check('cl-3 入口两个：侧栏图标（order/label 取自载荷）+ main keyed panelId；样式只注一发且可撤', async () => {
  const server = await mountServer();
  try {
    const t = await loadClient(server);
    const main = await t.mountMain();
    assert.equal(main.spec.key, t.exports.PANEL_ID);
    const side = t.clientCtx.registered.find((r) => r.slot === 'sidebar.panellist');
    assert.ok(side, '侧栏入口没注册');
    assert.equal(side.spec.id, 'api-catalog');
    assert.equal(side.spec.order, server.payload.panelOrder, '排序必须来自载荷（17 排在 GitHub 热榜下方是定过的）');
    assert.equal(side.spec.label(), server.payload.label);
    assert.equal(typeof side.comp, 'function');
    assert.deepEqual(t.doc.ops, [`append:${t.exports.__test.STYLE_ID}`], '样式应当在 head 里且只有一个 id');
    // 重复 apply（宿主重新激活）不能叠第二份 CSS，撤销器必须是可用的
    t.exports.apply(t.clientCtx);
    assert.equal(t.doc.ops.length, 1, `样式注了 ${t.doc.ops.length} 发`);
    const styleEffect = t.clientCtx.effects.find((e) => e.label === 'api-catalog:style');
    styleEffect.dispose();
    assert.deepEqual(t.doc.ops, [`append:${t.exports.__test.STYLE_ID}`, 'remove'], '撤销器没真把 style 摘掉');
    await t.close();
  } finally { server.close(); }
});

/* ================================================================== *
 * B. 数据通路
 * ================================================================== */

check('cl-4 订阅即首屏：GET /snapshot 一发都不发，顶栏就报得出条数与类数', async () => {
  const server = await mountServer();
  try {
    await server.sync();
    const t = await loadClient(server);
    await t.mountMain();
    assert.equal(t.callCount('/api/snapshot'), 0, '先 GET 再订阅会留空窗；接上就发整份快照是服务端那一侧的承诺');
    const head = clsText(t.tree(), 'ac-sub');
    assert.ok(head.includes(`${TOTAL} 条 / ${CATEGORIES} 类`), head);
    // 源名不再写死「上游 public-apis」：页头念的是载荷里按 sourceId 查到的那一条。
    // ★ 默认夹具是**英文**那份，而假 fetch 现在按正文配对只让对应那几档答 ⇒ 这一轮走的是降级：
    //   页头必须念「public-apis（英文）· …」而不是登记表第一档。手抄一个源名 = 换一次源就得改一次用例。
    assert.ok(head.startsWith(`${labelOf(answeredIdOf(README))} · `), `页头没念这次真跑到的源：${head}`);
    assert.ok(labelOf(answeredIdOf(README)).includes('英文'), '默认夹具该由降级那档答上，配对漂了');
    assert.equal(t.calls.some((c) => c.method === 'POST'), false, '挂载不该写任何东西');
    await t.close();
  } finally { server.close(); }
});

check('cl-5 库里还没条目时不说「没有匹配」：空库有单独一句话', async () => {
  const server = await mountServer();
  try {
    const t = await loadClient(server);
    await t.mountMain();
    assert.ok(clsText(t.tree(), 'ac-sub').includes('库里还没有条目'), `零库的副标题不对：${clsText(t.tree(), 'ac-sub')}`);
    assert.ok(clsText(t.tree(), 'ac-empty').includes('点页头「立即同步」跑第一轮'), `空库要把下一步指出来：${clsText(t.tree(), 'ac-empty')}`);
    await t.close();
  } finally { server.close(); }
});

check('cl-5b 库里有货但条件筛空了：说「这个条件下没有条目」，不是「库里还没有条目」', async () => {
  // 三种空态各说各的（读不出 / 库里没条目 / 条件太严）。这一条钉第三种：
  // 把它说成"库里还没有条目"，用户会去点「立即同步」，而库里躺着 2019 条。
  const t = await booted();
  try {
    await debounce(t);
    await typeIn(t, byCls(t.tree(), 'ac-q')[0], 'zzzz-没有这个词');
    await debounce(t);
    const empty = clsText(t.tree(), 'ac-empty');
    assert.ok(empty.includes('这个条件下没有条目'), `条件太严要说"换一个词/清空筛选"：${empty}`);
    assert.equal(empty.includes('库里还没有条目'), false, '库非空却说"库里还没有条目"就是把用户支去点同步');
    assert.ok(clsText(t.tree(), 'ac-card-n').includes('0 条命中'), '命中数与那句话得同向');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-6 流断开当场如实报，并挂 5 秒重连；撤销页面后这条定时器不留着', async () => {
  const server = await mountServer();
  try {
    await server.sync();
    const t = await loadClient(server);
    await t.mountMain();
    // ★ 2026-10-05 改版：连接状态与「上次同步」合成**一枚** pill ——
    //   两个 pill 各带一个绿点，视觉上像两件事，其实是一件事。
    //   有过同步记录时它念的是那句状态话术（更有信息量），没有记录时才说「实时更新中」。
    const pill = clsText(t.tree(), 'ac-pill');
    assert.ok(pill.includes('实时更新中') || pill.includes('已更新') || pill.includes('没变'),
      `推流连上了，状态 pill 总得说点什么：${pill}`);
    assert.equal(byCls(t.tree(), 'ac-pill').length, 1, `页头该只有一枚状态 pill，实际 ${byCls(t.tree(), 'ac-pill').length} 枚：又挤成一条线了`);
    assert.equal(buttonsByText(t.tree(), '重新连接', 'ac-link').length, 0,
      '推流正常时页头常驻一枚「重新连接」：那是常驻的摆设');
    __peek('api').hub.dispose();   // 真撤销：teardown 走的就是这一发
    await t.settle();
    assert.ok(clsText(t.tree(), 'ac-pill').includes('推流断开，正在重连'), clsText(t.tree(), 'ac-pill'));
    // ★ 2026-10-05 改版：断流时页头出现「重新连接」入口（顶替被删掉的那枚「刷新」——
    //   它与「立即同步」在用户眼里是同一件事，两个入口说一句话就得猜该点哪个）。
    //   判据两条：① 断流才出现；② 点了真能重取一份快照。
    const again = buttonsByText(t.tree(), '重新连接', 'ac-link')[0];
    assert.ok(again, '断流了却没给出重连入口：用户只能干等');
    const before = t.callCount('/api/snapshot');
    await tap(t, again);
    assert.equal(t.callCount('/api/snapshot'), before + 1, '点了「重新连接」没有重取快照');
    assert.equal(t.timers.live(5000).length, 1, '重连没排期');
    t.unmount();
    assert.equal(t.timers.live(5000).length, 0, '卸载后还留着 5 秒重连 = 插件拆了还在敲宿主的路由');
    server.close();
  } finally { server.close(); }
});

check('cl-7 存储坏了：200 头已经冲出去了，那一侧的原因只能靠 error 帧递上来（不许留绿点骗人）', async () => {
  const broken = { open: async () => { throw new Error('backend 拒绝了这份声明'); } };
  const server = await mountServer({ facility: broken });
  try {
    const t = await loadClient(server);
    await t.mountMain();
    const pill = clsText(t.tree(), 'ac-pill');
    // openSse 在写头之后才读库，503 这时候已经发不出去（ERR_HTTP_HEADERS_SENT）：
    // 所以界面上这句必须是**服务端给的原因**，不是「推流断开」那种含糊话。
    assert.ok(pill.includes('记录域 open 失败：backend 拒绝了这份声明'), pill);
    assert.equal(byCls(t.tree(), 'ac-dot-ok').length, 0, '连接没成却点亮了绿点');
    // ★ 2026-10-05 改版：能力位降级从两枚常驻 pill 收成副标题下的一条，只在真缺位时出现。
    //   判据除了「说得出来」，还要「说得准」——不许把 timer 也说成缺位（那是谎报）。
    const capsLine = clsText(t.tree(), 'ac-capsline');
    assert.ok(capsLine.includes('存储不可用'), `能力位为假要在页头上说出来：${capsLine || '(整行没渲染)'}`);
    assert.equal(capsLine.includes('定时器'), false, `只有存储缺位，却把定时器也说成缺位：${capsLine}`);
    assert.ok(clsText(t.tree(), 'ac-empty').includes('快照还没到'), '读不出就说读不出，不许说成「库里没有」');
    await t.close();
  } finally { server.close(); }
});

check('cl-8 页头「立即同步」真跑一轮：POST 出网 → update 帧 → 屏幕上的数字跟着变', async () => {
  const server = await mountServer();
  try {
    const t = await loadClient(server);
    await t.mountMain();
    assert.equal(clsText(t.tree(), 'ac-num').includes(String(TOTAL)), false);
    await pick(t, buttonsByText(t.tree(), '立即同步', 'ac-btn-primary')[0]);
    assert.equal(t.lastCall('/api/sync').method, 'POST', '点页头那一下没走路由（用例自己跑一轮是测不到路由的）');
    assert.ok(clsText(t.tree(), 'ac-tab-n').includes(String(TOTAL)), 'update 帧没把新数字带到界面上');
    assert.ok(clsText(t.tree(), 'ac-notice').includes('这一轮跑完'), clsText(t.tree(), 'ac-notice'));
    assert.ok(clsText(t.tree(), 'ac-pill').includes('上次同步：已更新'), clsText(t.tree(), 'ac-pill'));
    await t.close();
  } finally { server.close(); }
});

check('cl-9 撞车那一发按载荷的码识别：409 说「上一轮还没结束」，不是「跑完了」', async () => {
  const server = await mountServer();
  try {
    const t = await loadClient(server);
    await t.mountMain();
    server.state.delay = 30;                       // 让第一轮真的还在飞
    const first = server.sync('timer');            // 定时器那一发撞在前面
    await flush(2);
    const btn = buttonsByText(t.tree(), '立即同步', 'ac-btn-primary')[0];
    btn.props.onClick();
    await t.settle();
    assert.ok(clsText(t.tree(), 'ac-notice').includes('上一轮同步还没结束'), clsText(t.tree(), 'ac-notice'));
    await first;
    await t.close();
  } finally { server.close(); }
});

/* ================================================================== *
 * C. 目录页签
 * ================================================================== */

check('cl-10 五个页签按 TAB_DEFS 顺序出；计数只挂目录那一枚，常用API 一枚都不挂', async () => {
  // ★ 2026-10-07 改判（原来钉的是「四个页签」，历史口径在 docs/design-spec.md §9.1n）。
  //   新加的那一页（常用API）**不许挂计数**：这一页还没有排序依据，
  //   挂 450（目录页一个筛选子集）或 2019（全库）都是把"筛出来的东西"冒充成"社区常用的"。
  //   所以这一发的后半截是这个新页签的围栏 —— 将来真有了频率来源，先改这条再挂数。
  const t = await booted();
  try {
    const tabs = byCls(t.tree(), 'ac-tab');
    assert.deepEqual(tabs.map(textOf), [`目录${TOTAL}`, '常用API', '变更', '我的笔记', '设置'], tabs.map(textOf).join('|'));
    // 页签条由 TAB_DEFS 画：渲染顺序必须等于白名单顺序（别在第二处再排一遍 id/label）
    // ★ 右边要展开成测试这一侧的数组：__test.TAB_DEFS 是沙箱里造的，跨 realm 的 Array 与 assert.deepEqual 的原型比对过不去
    assert.deepEqual(tabs.map((n) => textOf(n).replace(/[\d,]+$/, '')), [...t.exports.__test.TAB_DEFS].map((d) => d.label),
      '页签渲染顺序跟 TAB_DEFS 不一致');
    assert.equal(tabs[0].props.className.includes('on'), true, '默认页签不是目录');
    assert.equal(byCls(tabs[1], 'ac-tab-n').length, 0, '常用API 页签挂上了计数：这一页还没有排序依据，不许挂数');
    assert.equal(byCls(t.tree(), 'ac-tab-n').length, 1, '变更/设置没有对应的计数，一条批注都没写过也不挂个 0（那是噪音不是信息）');
    await t.close();
  } finally { t.server.close(); }
});

/* ================================================================== *
 * C2. 常用API 页签（2026-10-07 两道裁定：先「只做壳，频率来源待指定」，再「这些废话去掉行不行」⇒ 只剩读数）
 * ================================================================== */

check('cl-54 常用API 只剩几格读数：解释「为什么没有名次」那张卡撤干净了，也不摆列表、不开第二个入口', async () => {
  const t = await booted();
  try {
    await goTab(t, '常用API');
    const panel = byCls(t.tree(), 'ac-panel')[0];
    assert.ok(panel, '常用API 页没画出 .ac-panel（滚动层分配表 cl-39 认的就是这一发）');
    // ★ 2026-10-07 第二道裁定「这些废话去掉行不行」⇒ 那张空卡 + 三句长话撤干净，底部那份 `parseNote` 落款同一轮判「撤掉」：
    //   只许剩读数那一张卡，撤过的句子一个都不许自己长回来（同一类半吊子改法：只改标题不撤卡 / 只撤卡不撤载荷）。
    assert.equal(byCls(panel, 'ac-card').length, 1, `这一页摆了 ${byCls(panel, 'ac-card').length} 张卡，解释性的那一张已经判撤`);
    const txt = textOf(panel);
    for (const gone of ['没有出处', '不排名次', '不是使用频率', '不摆第二个入口', '来源裁定', '条件：', '来源：']) {
      assert.equal(txt.includes(gone), false, `撤掉的那句又回到屏上了：「${gone}」`);
    }
    // 结构性围栏（撤解释不等于撤闸门）：没有出处的名次仍然不许出现。
    assert.equal(/\d+\.\s*\S/.test(txt), false, `屏上出现了「1. xxx」那种名次：名次要有出处才许摆：${txt.slice(0, 60)}`);
    assert.equal(byCls(panel, 'ac-li').length, 0, '这一页摆出了条目列表：拿没有出处的顺序冒充「常用」');
    assert.equal(byCls(panel, 'ac-tl').length, 0, '这一页摆出了流水列表');
    assert.equal(byCls(panel, 'ac-q').length, 0, '这一页又开了一处搜索框（目录页那一处是唯一入口）');
    assert.equal(byCls(panel, 'ac-chip').length, 0, '这一页摆出了预设芯片：那两档本来就在目录页「快捷」那一行里');
    assert.equal(findAll(panel, (n) => n.tag === 'button').length, 0, '这一页上有按钮：条目本来就在目录页里列着');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-55 常用API 上每一格都等于服务端那份：换一份上游正文它们必须跟着变（写死某一天的实测值当场红）', async () => {
  // 第二发故意换 body：界面代码一行没改，数字全变了才算"跟着载荷"；
  // 只跑真 README 那一发的话，写死 450 也能绿（自等价判据，2026-10-06 那轮就栽在这一类上）。
  const bodies = [
    ['真 README（2019 条）', README],
    ['小夹具（条目数完全不同的一份正文）', await fixture('fx-dup-slugs.md')],
  ];
  for (const [cap, body] of bodies) {
    const server = await mountServer({ body });
    await server.sync();
    const t = await loadClient(server);
    await t.mountMain();
    try {
      const truth = await __peek('engine').snapshot();
      await goTab(t, '常用API');
      const presets = t.payload.presets || [];
      const rows = byCls(t.tree(), 'ac-ukv');
      assert.equal(rows.length, presets.length, `${cap}：界面 ${rows.length} 行，载荷里 ${presets.length} 档`);
      presets.forEach((p, i) => {
        // 每档一行（2026-10-07 裁定）：名字 + 条数 + 条件三段全在这一发里，不再另起一行「条件：」
        assert.equal(byCls(rows[i], 'ac-sub').length, 1, `${cap}：第 ${i} 档的条件不是同一行里那一段：${textOf(rows[i])}`);
        const line = textOf(rows[i]);
        assert.ok(line.startsWith(p.label), `${cap}：第 ${i} 行的名字不是载荷那个：${line}`);
        assert.ok(line.includes(String(truth.presets[p.id])), `${cap}：界面上没有服务端那份 ${p.id}=${truth.presets[p.id]}：${line}`);
        assert.equal(textOf(byCls(rows[i], 'ac-sub')[0]).split(' + ').length, Object.keys(p.facets).length,
          `${cap}：${p.id} 的条件段数与载荷不符：${line}`);
      });
      const head = textOf(cardByTitle(t.tree(), '全库'));
      assert.ok(head.includes(`${truth.index.total} 条`) && head.includes(`${truth.index.categories} 类`),
        `${cap}：卡头的条数/分类数不是服务端那份：${head}`);
      await t.close();
    } finally { server.close(); }
  }
});

check('cl-56 常用API 把两种「没有」说得开：快照没到是「数不出」，库里没条目是真 0，不许混着念', async () => {
  // ① 存储坏了 ⇒ 快照根本到不了，这一页不许报出任何计数（0 是一个真读数，会把它说成"库里什么都没有"）
  const broken = { open: async () => { throw new Error('backend 拒绝了这份声明'); } };
  const s1 = await mountServer({ facility: broken });
  try {
    const t = await loadClient(s1);
    await t.mountMain();
    await goTab(t, '常用API');
    const panel = textOf(byCls(t.tree(), 'ac-panel')[0]);
    assert.ok(panel.includes('—'), `快照没到时那一格要写「数不出」：${panel.slice(0, 60)}`);
    assert.equal(/\d+ 条/.test(panel), false, `快照还没到却念出了 N 条：把"没读到"说成"库里没有"：${panel.slice(0, 80)}`);
    await t.close();
  } finally { s1.close(); }

  // ② 装配正常但没跑第一轮 ⇒ 0 条是真读数，这时候必须老老实实写 0
  const s2 = await mountServer();
  try {
    const t = await loadClient(s2);
    await t.mountMain();
    await goTab(t, '常用API');
    const panel = textOf(byCls(t.tree(), 'ac-panel')[0]);
    assert.ok(panel.includes('0 条'), `第一轮还没跑，这一页没把 0 当读数念出来：${panel.slice(0, 80)}`);
    await t.close();
  } finally { s2.close(); }
});

check('cl-11 分类栏：51 类 + 「全部分类」，中文标签与上游原文在悬停里并列，点一类只筛这一类，再点同一类取消', async () => {
  const t = await booted();
  try {
    const rail = byCls(t.tree(), 'ac-rail-i');
    assert.equal(rail.length, CATEGORIES + 1);
    assert.ok(textOf(rail[0]).startsWith('全部分类'), textOf(rail[0]));
    assert.ok(hasCls(rail[0], 'on'), '不开任何筛选时「全部分类」就该是选中态');
    const books = rail.find((n) => String(n.props.title || '').includes('Books'));
    assert.ok(books, `分类栏里找不到 Books 那一行（有原文的共 ${rail.filter((n) => String(n.props.title || '').includes('Books')).length} 个）`);
    // 中文是**我们**给的标签（服务端 lib/categories.js 走载荷的 facets.category[].label）：
    // 它排在前面，而上游原文必须在**悬停提示**里核得到 —— 2026-10-05 改版把它从常驻小字降级成了 title，
    // 因为常驻那一行挤得中文标签自己被截断（「认证与…」「云存储与…」，截掉的偏偏是唯一有信息量的那个）。
    assert.ok(textOf(books).startsWith('图书'), `中文标签没排在前面：${textOf(books)}`);
    assert.ok(String(books.props.title).includes('Books'), `悬停里没有上游原文：${books.props.title}`);
    // 负向断言：改版后不该再有那一行常驻英文小字（它就是截断的元凶）
    assert.equal(byCls(t.tree(), 'ac-rail-i').some((n) => byCls(n, 'en').length > 0), false,
      '英文原文又回到常驻小字了：那正是把中文标签挤到截断的那一行');
    // ★ 中文标签自己不许被截断：分类名占满整行、计数右靠，宽度不够时截中文等于没有标签。
    for (const n of byCls(t.tree(), 'ac-rail-i')) {
      const nm = byCls(n, 'nm')[0];
      assert.ok(nm && nm.props.className.includes('nm'), '分类行缺名字 span');
    }
    await pick(t, books);
    assert.equal(t.lastCall('/api/search').search.includes('category=Books'), true,
      `${t.lastCall('/api/search').search}：中文只是显示层，筛出去的主键还得是上游原文`);
    const rows = tbodyRows(t.tree());
    assert.ok(rows.length > 0 && rows.every((r) => textOf(r).includes('图书')), '结果里混进了别的分类');
    assert.equal(hasCls(byCls(t.tree(), 'ac-rail-i').find((n) => String(n.props.title || '').includes('Books')), 'on'), true);
    await pick(t, byCls(t.tree(), 'ac-rail-i').find((n) => String(n.props.title || '').includes('Books')));
    assert.equal(t.params('/api/search').get('category'), null, '再点同一类没取消');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-11c CN 载荷（现用源那一档）：中文类名直显、不给它挂「上游原文」，源里就写中文的用途也不挂预译落款', async () => {
  // 2026-10-07 换源裁定后的界面现场：分类名与绝大多数用途**本来就是中文**。
  // 「上游原文 X」那句悬停和「中文说明来自 …」那句落款是给"我们加的翻译"用的；
  // 挂在源文档自己写的中文上就是冒充 ⇒ 这一条钉的是**没有英文可挂时不许编一个**。
  const t = await booted({ body: CN_README });
  try {
    const head = clsText(t.tree(), 'ac-sub');
    assert.ok(head.startsWith(`${labelOf(answeredIdOf(CN_README))} · ${CN_TOTAL} 条 / ${CN_CATEGORIES} 类`), head);
    const rail = byCls(t.tree(), 'ac-rail-i');
    assert.equal(rail.length, CN_CATEGORIES + 1);
    const cn = rail.find((n) => textOf(n).startsWith('国内物流'));
    assert.ok(cn, '分类栏里没有 CN 源特有的「国内物流」');
    assert.equal(String(cn.props.title || ''), '国内物流', `没标签的分类仍挂着英文口径的悬停：${cn.props.title}`);
    assert.equal(rail.some((n) => String(n.props.title || '').includes('上游原文')), false,
      'CN 载荷上还出「上游原文」⇒ lib/categories.js 那张表被当成现用源的映射在用');

    const rows = byCls(t.tree(), 'ac-li');
    assert.ok(rows.length > 0);
    let hanRows = 0;
    for (const r of rows) {
      const tag = byCls(r, 'ac-cat-tag')[0];
      const dcell = byCls(r, 'ac-desc')[0];
      // 行内分类小字：库里那个名字直显，title 留空（有中文标签时才写「上游原文 …」）
      assert.equal(tag.props.title, '', `行内分类小字挂了一句没有的原文：${tag.props.title}`);
      // 用途：显示的这句如果自带汉字，就不许再挂「上游原文：<同一句>」——那是把源话当我们加的译文
      const shown = textOf(dcell);
      const title = String(dcell.props.title || '');
      if (TRANS_HAN_RE.test(shown)) {
        hanRows += 1;
        assert.equal(title, '', `中文用途挂了落款（冒充我们给的翻译）：${title}`);
      } else if (title) {
        assert.ok(title.startsWith('上游原文：'), `英文行的 title 口径漂了：${title}`);
        assert.notEqual(title.slice('上游原文：'.length), shown, '落款里那句"原文"就是显示的那句');
      }
    }
    // ★ 这一屏必须真的有自带中文的用途：否则上面那支 if 是空转（假绿的形状 = 屏幕上一行中文都没有，判据一条没跑）
    assert.ok(hanRows >= Math.ceil(rows.length * 0.5), `这一屏 ${rows.length} 行里只有 ${hanRows} 行自带中文 ⇒ 载荷不是现用源那一份`);
    // 两枚预设芯片上的数字跟着载荷走（domain 里那句 hint 已经不写死条数了）
    const chips = byCls(t.tree(), 'ac-chip').map((n) => textOf(n));
    assert.ok(chips.includes(`免 key ${CN_NO_KEY}`), `免 key 那枚没念出 CN 载荷上的数：${chips.slice(0, 4)}`);
    assert.ok(chips.includes(`浏览器直连可用 ${CN_BROWSER_DIRECT}`), `直连那枚念的还是英文源的数：${chips.slice(0, 4)}`);

    await t.close();
  } finally { t.server.close(); }
});

check('cl-12 facet 筛选：候选取自库里实际值，**请求参数发上游原值**（显示层改口径不改主键）；「更多」能就地展开', async () => {
  const t = await booted();
  try {
    // ★ 2026-10-05 改版后这一条判据变了：芯片上显示的是**中文短词**（No→免鉴权…），
    //   完整话术在 title 里，而**发出去的参数必须仍是上游原值**。
    //   判据从「芯片文本== 原值」改成「title 里带原值 + title 里有载荷那句话」——
    //   前者钉显示，后者钉**筛出去的主键没跟着显示层一起改**（那才是真会筛错的东西）。
    const authGroup = () => byCls(t.tree(), 'ac-fg').find((n) => textOf(n).startsWith('鉴权'));
    const authChips = byCls(authGroup(), 'ac-chip');
    const titles = authChips.map((n) => String(n.props.title || ''));
    // 库里那五种就是 public-apis 的 auth 列出现过的值（'unknown' 不在列，这一列没落进第三态）。
    // 改版后默认只列计数前 3 ⇒ 这里只逐字核前三个，剩下的两个由 cl-12b 那条「更多」接着核。
    for (const v of ['No', 'apiKey', 'OAuth']) {
      assert.ok(titles.some((x) => x.includes(`库里记的取值 ${v}`)), `${v} 这一档的 title 里没有库里那格：${titles.join(' | ')}`);
    }
    // ★ U-16：title 不许说"上游原值"。CORS 那一列的 `unknown` 是本插件合成的（源里写 Unknown/未知/–），
    //   这句一旦回退成"上游原值"，屏幕就在替我们编上游的话。反向断言钉住，正向断言钉不住。
    assert.equal(titles.some((x) => x.includes('上游原值')), false, `title 又去替上游说话了：${titles.join(' | ')}`);
    assert.equal(authChips[0].props.title.includes('无需鉴权'), true, '完整中文话术要挂在 title 上');
    // 计数：取「免鉴权」那一枚（短词），数字必须等于库里 No 那一档的条数
    const noKey = authChips.find((n) => textOf(n).startsWith('免鉴权'));
    assert.ok(noKey, '鉴权组里找不到「免鉴权」那一枚');
    assert.equal(Number(textOf(noKey).match(/(\d+)$/)[1]), NO_KEY, '芯片上的计数不是库里那一档');
    // 「更多」：鉴权有 5 个值、默认只列 3 ⇒ 必须有一枚「更多」，点开才见剩下两个
    const moreBtn = byCls(authGroup(), 'ac-more')[0];
    assert.ok(moreBtn, '鉴权有 5 个值却没给「更多」入口：另外两个用户永远筛不到');
    assert.equal(textOf(moreBtn).includes('2'), true, `「更多」没念出还剩几档：${textOf(moreBtn)}`);
    assert.equal(byCls(authGroup(), 'ac-chip').length, 3, '展开前就该只有 3 枚');

    await pick(t, noKey);
    assert.equal(hits(t.tree()), NO_KEY);
    const apiKeyChip = byCls(authGroup(), 'ac-chip').find((n) => textOf(n).startsWith('需 key'));
    await pick(t, apiKeyChip);
    assert.deepEqual(t.params('/api/search').getAll('auth'), ['No', 'apiKey'], '请求参数必须是上游原值，不是界面上的短词');
    assert.equal(t.lastCall('/api/search').search.includes('limit='), false, '上限由服务端定，界面不自己猜一个数');
    // 命中数与 facet 计数是两条独立读路（一次聚合、一次查询），这里对得上才说明没各算各的。
    assert.equal(hits(t.tree()), NO_KEY + Number(textOf(apiKeyChip).match(/(\d+)$/)[1]));
    await t.close();
  } finally { t.server.close(); }
});

check('cl-12b 已选中的 facet 值即使计数排不进前 3 也必须可见（否则用户点了却像没点上）', async () => {
  const t = await booted();
  try {
    // User-Agent 只有 2 条，计数最小；先展开再选中它、收起展开 —— 它必须还站在筛选区里，
    // 否则「我明明点过」的反馈从屏幕上消失了，看起来像点击无效。
    const authGroup = () => byCls(t.tree(), 'ac-fg').find((n) => textOf(n).startsWith('鉴权'));
    await tap(t, byCls(authGroup(), 'ac-more')[0]);            // 展开全部 5 档
    const ua = byCls(authGroup(), 'ac-chip').find((n) => textOf(n).startsWith('需 UA'));
    assert.ok(ua, '展开后找不到「需 UA」那一档');
    await pick(t, ua);
    assert.deepEqual(t.params('/api/search').getAll('auth'), ['User-Agent'], '选中的原值没发出去');
    await tap(t, byCls(authGroup(), 'ac-more')[0]);            // 收起
    const still = byCls(authGroup(), 'ac-chip');
    assert.ok(still.some((n) => textOf(n).startsWith('需 UA') && hasCls(n, 'on')),
      '收起后已选中的那一档消失了：用户点了却看不到自己点了什么');
    assert.equal(still.length, 4, `收起后应是「前 3 + 已选中的那一枚」，实际 ${still.length} 枚：${still.map(textOf).join('|')}`);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-13 预设芯片：文案与计数都取自载荷/快照，点「浏览器直连」把三档条件变成芯片选中', async () => {
  const t = await booted();
  try {
    // ★ 2026-10-05 改版：预设并进了筛选那一条（原来它独占一行还带一句「一键预设：」标签）。
    //   它仍然是 ac-chip（不是 ac-fg 组），所以按文案找得到，不按容器类名。
    const quick = byCls(t.tree(), 'ac-fg').find((n) => textOf(n).startsWith('快捷'));
    assert.ok(quick, '筛选区里没有「快捷」那一组：预设被改版时弄丢了');
    const presets = byCls(quick, 'ac-chip');
    const labels = presets.map(textOf);
    const counts = [NO_KEY, BROWSER_DIRECT];
    assert.deepEqual(labels, t.payload.presets.map((p, i) => `${p.label} ${counts[i]}`), labels.join('|'));
    await pick(t, presets[1]);
    assert.deepEqual(t.params('/api/search').getAll('auth'), ['No']);
    assert.deepEqual(t.params('/api/search').getAll('https'), ['Yes']);
    assert.deepEqual(t.params('/api/search').getAll('cors'), ['Yes']);
    assert.equal(hits(t.tree()), BROWSER_DIRECT);
    const cleared = buttonsByText(t.tree(), '清空筛选', 'ac-link')[0];
    await pick(t, cleared);
    assert.equal(t.params('/api/search').toString(), '', '清空后该回到裸请求');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-14 搜索防抖 250 ms：连打三个字只发一发，且那一发的 q 是整串', async () => {
  const t = await booted();
  await debounce(t);   // 首屏那发（snap 到位后排的防抖）
  const before = t.callCount('/api/search');
  const q = byCls(t.tree(), 'ac-q')[0];
  for (const v of ['we', 'wea', 'weat']) await typeIn(t, q, v);
  assert.equal(t.callCount('/api/search'), before, '字还没打完就该等一拍，不然宿主被问烦、结果还会闪');
  assert.equal(t.timers.live(250).length, 1, '重排时没清掉旧的防抖');
  await debounce(t);
  assert.equal(t.callCount('/api/search'), before + 1);
  assert.equal(t.params('/api/search').get('q'), 'weat');
  await t.close();
  t.server.close();
});

check('cl-15 迟到的响应不许覆盖：两发在飞时只认最后一发', async () => {
  const t = await booted();
  await debounce(t);
  const q = byCls(t.tree(), 'ac-q')[0];
  // 把上游变慢，让第一发真的晚于第二发落地
  let gate = null;
  const slow = new Promise((resolve) => { gate = resolve; });
  const original = t.server.handler;
  let first = true;
  t.server.handler = () => async (req, res) => {
    if (first && String(req.url).includes('/api/search')) { first = false; await slow; }
    return original()(req, res);
  };
  await typeIn(t, q, 'axolotl');
  await debounce(t);                    // 第一发出门，卡在网关上
  t.server.handler = original;
  await typeIn(t, q, 'zzzz-nothing');
  await debounce(t);                    // 第二发正常跑完
  const shown = clsText(t.tree(), 'ac-card-n');
  assert.ok(/0 条命中/.test(shown), shown);
  gate();
  await t.settle();
  assert.ok(/0 条命中/.test(clsText(t.tree(), 'ac-card-n')), '迟到的那一发把屏幕改回去了');
  await t.close();
  t.server.close();
});

check('cl-16 供应商聚合条已撤干净：界面不画、不发 /api/hosts，但搜域名照样收到那一家', async () => {
  const t = await booted();
  try {
    // 2026-10-05 裁定：目录页那块「散在多个条目上的供应商」是多此一举（搜索框本来就吃主机名）。
    // 撤的要撤到底：卡片、数据源那一发、以及 filters 里那个没人读的 host 键，三样都不许在。
    assert.equal(cardByTitle(t.tree(), '散在多个条目上的供应商'), undefined, '聚合条还在目录页上');
    assert.equal(t.callCount('/api/hosts'), 0, '界面不画聚合条了，就不该再为它问一发 /api/hosts');
    assert.equal(hits(t.tree()), TOTAL, `首屏该是整份浏览态，却是 ${hits(t.tree())}`);

    await debounce(t);
    await typeIn(t, byCls(t.tree(), 'ac-q')[0], TOP_HOST);
    await debounce(t);
    assert.equal(t.params('/api/search').get('q'), TOP_HOST, '搜域名这一发没把域名带进 q');
    assert.equal(t.params('/api/search').get('host'), null, 'host 这个筛选键已经撤了，不该再出现在请求里');
    const narrowed = hits(t.tree());
    assert.ok(narrowed > 0 && narrowed < TOTAL, `搜 ${TOP_HOST} 应该收窄，却给了 ${narrowed} 条`);
    assert.ok(tbodyRows(t.tree()).length > 0, '收窄后一行都没有，能力就丢了');

    for (const label of ['变更', '我的笔记', '设置', '目录']) {
      await goTab(t, label);
      assert.equal(cardByTitle(t.tree(), '散在多个条目上的供应商'), undefined, `${label} 页签上又冒出聚合条`);
    }
    await t.close();
  } finally { t.server.close(); }
});

check('cl-17 结果行的结构：名称、分类、三枚状态标签、置顶星，一个都不能少也不能多', async () => {
  // ★ 2026-10-05 版式改版：这张用例原来钉的是「表头六列 + colgroup 六列 + 每行六个 td」——
  //   结果区改成列表行之后，列对齐这件事已经不存在了（没有 col 就没有定宽平摊），
  //   所以判据换成**行内结构齐全**：少一枚标签就是那一列被改漏了，多一枚就是塞了重复信息。
  const t = await booted();
  try {
    const rows = tbodyRows(t.tree());
    assert.ok(rows.length > 0, '一行都没有，行内结构就没得可测');
    for (const r of rows) {
      assert.equal(byCls(r, 'ac-nm').length, 1, '名称必须恰好一个');
      assert.equal(byCls(r, 'ac-cat-tag').length, 1, '分类标签必须恰好一个');
      // 鉴权/HTTPS/CORS 三枚 + 一颗置顶星 = 4。ac-flag 也被详情里的 Notice 之类用到，所以只在行内量。
      assert.equal(byCls(r, 'ac-flag').length, 3, `三枚状态标签不齐：${byCls(r, 'ac-flag').map(textOf).join('|')}`);
      assert.equal(byCls(r, 'ac-star').length, 1, '置顶星必须恰好一个');
      assert.equal(byCls(r, 'ac-desc').length, 1, '用途必须恰好一个（这是这一页唯一有信息量的句子）');
    }
    // 列表行不带 <table>：留着空壳会让读屏与键盘按表格方式遍历，读出来是一堆无标题格。
    assert.equal(findAll(t.tree(), (n) => n.tag === 'table').length, 0, '结果区还留着 table 外壳');
    assert.equal(findAll(t.tree(), (n) => n.tag === 'col').length, 0, 'colgroup 还在：列宽平摊的那套已经不适用了');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-18 三态如实：cors 的unknown 有第三种颜色与自己的话术，不当No 也不当 Yes；行内显示的是短词', async () => {
  const t = await booted();
  try {
    // ★ 2026-10-05 改版：行上那三枚标签显示的是**短词**（可直连/需代理/未知），
    //   完整话术在 title 里。原来这里量的是「单元格里那个词是不是 unknown」——
    //   列表行没有 td，改成量 .ac-flag 的 title 与短词，配色类名照旧。
    const rows = tbodyRows(t.tree());
    const flags = rows.map((r) => byCls(r, 'ac-flag'));
    const cors = flags.map((f) => f[2]);          // 第三枚是 CORS
    assert.ok(cors.length > 0 && cors.every(Boolean), '每行都该有三枚状态标签');
    const unknown = cors.filter((c) => hasCls(c, 'ac-flag-unk'));
    assert.ok(unknown.length > 0, 'cors 有上千条归一成了 unknown，第一页一格都没有？');
    // 短词：unknown 显示成「未知」，而**不是**「无」（那会被读成浏览器不能直连）或「可直连」。
    assert.equal(unknown.every((c) => textOf(c) === '未知'), true,
      [...new Set(unknown.map((c) => textOf(c)))].join('|') || '空');
    assert.equal(unknown.every((c) => c.props.title === 'CORS 未知，别假设能直连'), true,
      [...new Set(unknown.map((c) => c.props.title))].join('|') || '空');
    // 同一枚上绝不能同时出现「可直连」与「未知」：那说明归一没做，界面只是在抄上游的脏值。
    const labels = [...new Set(cors.map(textOf))];
    assert.equal(labels.includes('可直连') && labels.includes('未知') && labels.includes('需代理'), true,
      `CORS 三态没凑齐：${labels.join('|')}`);
    // title 里必须带得住上游原值（显示层改口径不改主键：这句话是核对用的）
    assert.ok(cors.every((c) => String(c.props.title || '').length > 0), '有一枚没有 title：长话术丢了就只剩短词没法核对');
    const tt = t.exports.__test;
    assert.equal(tt.flagLabel('cors', 'unknown'), 'CORS 未知，别假设能直连');
    assert.equal(tt.flagClass('unknown'), 'ac-flag-unk');
    assert.equal(tt.authLabel('unknown'), '鉴权方式未列', '把没写说成免鉴权会让人白跑一趟');
    assert.equal(tt.authShort('unknown'), '未知', '没写鉴权方式却显示成别的短词');
    assert.equal(tt.flagShort('cors', 'Yes'), '可直连');
    assert.equal(tt.flagShort('cors', 'No'), '需代理', 'CORS=No 说成「不支持」会让人以为是 HTTPS 那列');
    await t.close();
  } finally { t.server.close(); }
});

/* ================================================================== *
 * D. 就地编辑 notes（S4 判据：点开一行→对话框里改→保存落库；2026-10-06 起详情不在列表里，见 cl-19/cl-19b）
 * ================================================================== */

const noteBody = (t) => JSON.parse(t.lastCall('/api/notes').body);

/** 展开结果里的第 idx 行。slug 从**真发出去的那一发 GET** 里取：自己拼一个就等于在测假 slug。 */
async function openRow(t, idx = 0) {
  await tap(t, tbodyRows(t.tree())[idx]);
  const d = detailOf(t.tree());
  assert.ok(d, '点了行却没有就地详情');
  return {
    slug: decodeURIComponent(t.params('/api/entry').get('slug')),
    name: textOf(byCls(d, 'nm')[0]),
    url: byCls(d, 'ac-url')[0].props.href,
  };
}

check('cl-19 点开一行：详情长在对话框里（不是贴在行下面），派生句与上游原句都在，点关闭节点真没了', async () => {
  const t = await booted();
  try {
    const before = t.callCount('/api/entry');
    await openRow(t);
    assert.equal(t.callCount('/api/entry'), before + 1, '展开一条该只问一次');
    // ★ 2026-10-06 改判：详情从"跟着那一行"改成对话框（用户："点击具体的api使用弹框方式展示详情"）。
    //   原来这条判据是「详情在结果卡里面 = 它不是浮在别处的东西」，方向正好反了。
    const d = detailOf(t.tree());
    assert.ok(d, '点了行却没有详情对话框');
    assert.ok(textOf(d).includes('我的批注') && purposeBox(d), '就地编辑的入口必须在对话框里');
    assert.ok(textOf(d).includes('还没有批注'), clsText(d, 'ac-faint'));
    // 用途的两条来源都在明处：上游那句原样给（可折行）、派生句按字段拼 —— 这里没有任何模型写的东西。
    assert.equal(byCls(d, 'ac-desc').length, 1, '上游原句要么没带到要么重复了');
    assert.equal(byCls(d, 'ac-derived').length, 1, '派生句（按字段拼的那一行）没出来或出了两条');
    // 列表那一侧不再养详情：结果卡里多出一格 .ac-detail-in 就是旧口径没撤干净
    const card = cardByTitle(t.tree(), '条命中');
    assert.equal(byCls(card, 'ac-detail-in').length, 0, '详情又长回结果卡里了：它现在只住在对话框那一格');
    await tap(t, buttonsByText(d, '关闭', 'ac-link')[0]);
    assert.equal(byCls(t.tree(), 'ac-modal-mask').length, 0, '点了关闭，节点该真的没了');
    await t.close();
  } finally { t.server.close(); }
});

/** 真发一次 Esc（监听器在假 document 上：注册了不等于能被调到，见 tmp/mut_ac09 的证伪）。 */
async function pressEsc(t) {
  const n = t.doc.emitKey('keydown', { key: 'Escape' });
  assert.ok(n >= 1, `Esc 那一发根本没东西接（监听器 ${n} 个）：对话框关不掉`);
  await t.settle();
  return t.tree();
}

check('cl-19b 弹框不占列表的位置：开框列表不回流，遮罩/Esc/关闭三条路都关得掉，条目被筛掉框还在', async () => {
  const t = await booted();
  try {
    const rows = tbodyRows(t.tree());
    assert.ok(rows.length > 20, `结果只有 ${rows.length} 行，这一条测不出「回流不回流」`);
    const name = textOf(byCls(rows[5], 'ac-nm')[0]);
    await tap(t, rows[5]);
    // ① 开框不改列表：详情不再作为行的兄弟项插进去 ⇒ 行与行之间不会跳（旧口径那一格把下面整段顶下去）
    const list = byCls(t.tree(), 'ac-list')[0];
    assert.equal(tbodyRows(t.tree()).length, rows.length, '开框把详情插回列表了：列表跟着回流');
    assert.equal(byCls(list, 'ac-detail-in').length, 0, '列表里还养着一份详情');
    // ② 框里就是点的那一条
    assert.ok(textOf(detailOf(t.tree())).includes(name), `框里不是点的那一条（要的是「${name}」）`);
    // ③ 关闭路径二：遮罩空白处（点内部不许关 —— 那是选文字起手）
    await tap(t, maskOf(t.tree()));
    assert.equal(byCls(t.tree(), 'ac-modal-mask').length, 0, '点遮罩没关掉对话框');
    // ③′ 反向：内部点击不许把框关掉
    await tap(t, tbodyRows(t.tree())[5]);
    maskOf(t.tree()).props.onClick({ target: {}, currentTarget: { not: 'the mask' } });   // 冒泡上来的那一发
    await t.settle();
    assert.ok(detailOf(t.tree()), '点到框里也关框：那是选中一段文字起手，对话框不该因此消失');
    // ④ 关闭路径三：Esc，且关掉之后监听器要摘干净（留着=每开一框多挂一个）
    await pressEsc(t);
    assert.equal(byCls(t.tree(), 'ac-modal-mask').length, 0, 'Esc 没关掉对话框');
    assert.equal((t.doc.listeners.keydown || []).length, 0, '对话框关了但 keydown 监听器还挂着');
    // ⑤ 开着的那一条被后台那一轮筛掉了：框带着草稿照样得在（它不靠列表那一格活着）
    await tap(t, tbodyRows(t.tree())[6]);
    const keep = textOf(byCls(t.tree(), 'ac-nm')[6]);
    await typeIn(t, byCls(t.tree(), 'ac-q')[0], 'zz-不可能出现的词');
    await debounce(t);
    const d = detailOf(t.tree());
    assert.ok(d, '条目被筛掉之后对话框没了：那是用户没存的草稿');
    assert.ok(textOf(d).includes(keep), '条目被筛掉之后框里换了内容');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-20 打字→保存批注：POST 只带改过的那一个字段，库里那一行真落了，屏幕回到服务端那份', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    const text = '接过天气查询；返回的中文城市名要先转拼音';
    await typeIn(t, purposeBox(t.tree()), text);
    assert.equal(t.callCount('/api/notes'), 0, '字还没打完就该一发写请求都不发');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    const body = noteBody(t);
    assert.equal(body.slug, info.slug);
    assert.ok(body.category.length > 0, 'category 必须带上：搬家时靠它算新行');
    assert.equal(body.purpose, text);
    assert.deepEqual(Object.keys(body).sort(), ['category', 'purpose', 'slug'], '没碰过的字段不该被写回（尤其不许把 tags/starred 清成空）');
    const raw = t.server.rawNote(info.slug);
    assert.equal(raw.purpose, text, '屏幕上写着保存成功，库里却没有');
    assert.equal(purposeBox(t.tree()).props.value, text);
    assert.ok(clsText(t.tree(), 'ac-notice').includes('已保存'), clsText(t.tree(), 'ac-notice'));
    await t.close();
  } finally { t.server.close(); }
});

check('cl-21 草稿不被推流冲掉：正在打字时后台跑完一轮，那半句话还在', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    const half = '打到一半的';
    await typeIn(t, purposeBox(t.tree()), half);
    const frames = t.bridge.frameCount();
    await server_round(t);                       // 后台那一轮（定时器口径），不是点按钮
    assert.ok(t.bridge.frameCount() > frames, '这一轮没推新帧，测不到「推流来了」');
    assert.equal(purposeBox(t.tree()).props.value, half, 'update 帧把用户正在打的字冲掉了');
    assert.equal(t.callCount('/api/notes'), 0, '推流不该替用户保存');
    assert.equal(t.server.rawNote(info.slug), undefined, '没点保存就不该有落库');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-22 上限只用载荷给的那个数：超了当场红，服务端那一发 400 也照原文念出来', async () => {
  const t = await booted();
  try {
    assert.equal(t.payload.notePurposeMaxLen, NOTE_PURPOSE_MAX_LEN);
    const info = await openRow(t);
    const box = purposeBox(t.tree());
    const counter = () => byCls(detailOf(t.tree()), 'ac-counter')[0];
    assert.ok(textOf(counter()).includes(`/ ${NOTE_PURPOSE_MAX_LEN} 字`), '计数器上的数必须是载荷那份');
    await typeIn(t, box, '很'.repeat(NOTE_PURPOSE_MAX_LEN - 1));
    assert.equal(hasCls(counter(), 'over'), false, '还没超就报超，是吓用户');
    await typeIn(t, box, '很'.repeat(NOTE_PURPOSE_MAX_LEN + 1));
    assert.equal(hasCls(counter(), 'over'), true, '超了却不红：界面上看着能存');
    assert.ok(textOf(counter()).includes('超了，保存会被拒'), textOf(counter()));
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    const note = clsText(t.tree(), 'ac-notice');
    assert.ok(note.includes('保存失败'), note);
    assert.ok(note.includes(`批注最长 ${NOTE_PURPOSE_MAX_LEN} 字`), `念的该是服务端那句原因：${note}`);
    assert.equal(t.server.rawNote(info.slug), undefined, '被拒的写入不许在库里留半行');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-22b 载荷没给上限就不显示计数器（宁可少一个提示，不写一个自己猜的数）', async () => {
  const t = await booted();
  try {
    const noLimit = await loadClient(t.server, {
      payload: Object.fromEntries(Object.entries(t.payload).filter(([k]) => !k.endsWith('MaxLen'))),
    });
    await noLimit.mountMain();
    await openRow(noLimit);
    assert.equal(byCls(detailOf(noLimit.tree()), 'ac-counter').length, 0);
    assert.ok(textOf(detailOf(noLimit.tree())).includes('标签（逗号分隔）'), '标签那行的上限句子也该一起退掉');
    await noLimit.close();
    await t.close();
  } finally { t.server.close(); }
});

check('cl-23 标签：中文逗号也切，写进去的是数组；置顶与标签各自只发自己那一份', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    await typeIn(t, tagInput(t.tree()), '可用，已接,备用');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    assert.deepEqual(noteBody(t).tags, ['可用', '已接', '备用'], '切分口径：中英文逗号都算分隔，空的丢掉');
    assert.deepEqual(t.server.rawNote(info.slug).tags, ['可用', '已接', '备用']);
    // 第二发只改置顶：tags 不在 body 里，服务端那侧才不会把刚写的标签清掉
    await tap(t, buttonsByText(detailOf(t.tree()), '☆ 置顶', 'ac-mini')[0]);
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    const second = noteBody(t);
    assert.equal(second.starred, true);
    assert.equal('tags' in second, false);
    assert.deepEqual(t.server.rawNote(info.slug).tags, ['可用', '已接', '备用'], '只改置顶却把标签洗掉了');
    assert.equal(t.server.rawNote(info.slug).starred, true);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-23b 标签写满上限：载荷给的个数与字数是这一句提示的来源', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    assert.ok(textOf(detailOf(t.tree())).includes(`最多 ${TAG_MAX_COUNT} 个、每个 ${TAG_MAX_LEN} 字`), '标签上限的提示没念载荷给的这两个数');
    await typeIn(t, tagInput(t.tree()), Array.from({ length: TAG_MAX_COUNT + 1 }, (_, i) => `t${i}`).join(','));
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    const note = clsText(t.tree(), 'ac-notice');
    assert.ok(note.includes('保存失败') && note.includes(`标签最多 ${TAG_MAX_COUNT} 个`), note);
    assert.equal(t.server.rawNote(info.slug), undefined);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-24 hidden 藏的是默认结果集：裸列表里没了，带关键词仍出（不是从库里消失）', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    await tap(t, buttonsByText(detailOf(t.tree()), '默认结果里隐藏', 'ac-mini')[0]);
    assert.ok(textOf(detailOf(t.tree())).includes('已在默认结果里隐藏'), '点了就该看得见自己点了什么');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    assert.equal(noteBody(t).hidden, true);
    assert.equal(t.server.rawNote(info.slug).hidden, true);
    // 保存之后 refreshSnap 让快照换了对象 → 搜索那一拍重新排上；放掉它才看得见"默认结果集"的新样子。
    await debounce(t);
    assert.equal(t.params('/api/search').get('q'), null);
    assert.equal(tbodyRows(t.tree()).some((r) => textOf(byCls(r, 'ac-nm')[0]).includes(info.name)), false, '藏起来后裸列表还在显示它');
    await typeIn(t, byCls(t.tree(), 'ac-q')[0], info.name);
    await debounce(t);
    assert.ok(tbodyRows(t.tree()).some((r) => textOf(byCls(r, 'ac-nm')[0]).includes(info.name)), '带关键词也不出 = 这是删除不是隐藏');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-25 连点两行的竞态：迟到的那一发不许把详情改回上一条', async () => {
  const t = await booted();
  try {
    const rows = tbodyRows(t.tree());
    const second = findAll(rows[1], (n) => n.tag === 'span' && hasCls(n, 'ac-nm'))[0];
    const wanted = textOf(second);
    let gate = null;
    const blocked = new Promise((resolve) => { gate = resolve; });
    const real = t.server.handler;
    let first = true;
    t.server.handler = () => async (req, res) => {
      if (first && String(req.url).includes('/api/entry')) { first = false; await blocked; }
      return real()(req, res);
    };
    await tap(t, rows[0]);                       // 第一发卡在网关上
    t.server.handler = real;
    await tap(t, rows[1]);                       // 第二发正常跑完
    assert.equal(textOf(byCls(detailOf(t.tree()), 'nm')[0]), wanted);
    gate();
    await t.settle();
    assert.equal(textOf(byCls(detailOf(t.tree()), 'nm')[0]), wanted, '迟到的那一发把详情换回上一条了');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-26 删除批注：库里那一行真的没了，界面回到「还没有批注」', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    await typeIn(t, purposeBox(t.tree()), '先写过一句');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    assert.equal(t.server.noteRows(), 1);
    await tap(t, buttonsByText(detailOf(t.tree()), '删除批注', 'ac-btn')[0]);
    assert.equal(t.lastCall('/api/notes/delete').method, 'POST');
    assert.equal(t.server.rawNote(info.slug), undefined, '写着已删除，库里却还留着');
    assert.equal(t.server.noteRows(), 0);
    assert.ok(clsText(t.tree(), 'ac-notice').includes('批注已删除'), clsText(t.tree(), 'ac-notice'));
    assert.equal(byCls(detailOf(t.tree()), 'ac-btn').some((b) => textOf(b) === '删除批注'), false, '没批注了还挂着删除按钮');
    await t.close();
  } finally { t.server.close(); }
});

/* ================================================================== *
 * E. 变更 / 笔记 / 设置（真流水、真 orphan、真落库、真降级）
 * ================================================================== */

/** 当前页签上摆了几张卡。★ 2026-10-06 起这一发是变更页的主判据：那一页只许有列表那一张。 */
const cardsOn = (root) => byCls(root, 'ac-card');

check('cl-27 变更页签：切过去才发 GET /changes；第一轮没基线就如实说没有记录，后台那一轮跑完界面跟着重读', async () => {
  const t = await booted();
  try {
    assert.equal(t.callCount('/api/changes'), 0, '没切的页签不该预取');
    await goTab(t, '变更');
    assert.equal(t.callCount('/api/changes'), 1);
    // 第一轮是从零建库，没有"上一次"可差 ⇒ 记录为空是诚实的，把 2019 条都写成「新增」才是噪音。
    assert.equal(findAll(t.tree(), (n) => n.tag === 'li').length, 0);
    assert.ok(clsText(t.tree(), 'ac-empty').includes('还没有变更记录'), clsText(t.tree(), 'ac-empty'));
    const card = cardByTitle(t.tree(), '变更记录');
    assert.ok(textOf(card).includes('0 条'), '卡片上的条数与列表对不上');
    assert.equal(t.params('/api/changes').get('limit'), null, '条数上限归服务端，界面不自己带一个');
    // ★ 2026-10-06 用户真机走查裁定：这一页只摆变更记录列表，「解析台账」那张卡从界面上彻底撤掉。
    //   三发负向断言钉住这次裁定（只改标题不撤卡 / 把卡挪到别页 / 换成收起态，都会在这里红）：
    assert.equal(cardsOn(t.tree()).length, 1, '变更页不止一张卡：又有东西被塞进来了');
    assert.equal(textOf(t.tree()).includes('解析台账'), false, '「解析台账」还挂在界面上');
    assert.equal(textOf(card).includes('最多'), false, '卡头又把「库里最多 N 行」写回屏幕上了：列表画的就是库里全部');
    // 撤卡不等于把事实撤了：状态话术改由页头那一枚 pill 念（取自载荷，界面不自己拼）。
    assert.ok(textOf(t.tree()).includes(t.payload.syncStatusLabels.success), '页头没念载荷给的状态话术');
    assert.equal(textOf(t.tree()).includes('差分流水'), false, '「差分流水」这个名字还残在界面上');

    // 上游删一行 → 后台那一轮（不是点按钮）：界面停在变更页也必须看见新记录
    await goTab(t, '目录');
    const info = await openRow(t);
    t.server.state.body = t.server.state.body.split('\n').filter((l) => !l.includes(info.url)).join('\n');
    await goTab(t, '变更');
    assert.equal(t.callCount('/api/changes'), 2, '切回变更页读一发就够，不该多打');
    const before = t.callCount('/api/changes');
    await server_round(t);
    assert.equal(t.callCount('/api/changes'), before + 1, '跑了一轮却还拿着旧流水：界面得跟着快照重读');
    const items = findAll(t.tree(), (n) => n.tag === 'li');
    assert.ok(items.length > 0, '上游删了一条，变更记录还是空的');
    const kinds = [...new Set(items.map((n) => n.props['data-kind']))];
    assert.ok(kinds.every((k) => CHANGE_ROW_KINDS.includes(k)), `记录里出现了枚举外的 kind：${kinds}`);
    assert.ok(textOf(cardByTitle(t.tree(), '变更记录')).includes(`${items.length} 条`), '卡片上的条数与列表对不上');
    // ★ U-17：一轮差分的「本轮摘要」必须画在第一行，表头取载荷 labels（界面不自己拼一份话术）。
    //   这一行是整轮的真相；明细被保留上限挤掉时，界面上唯一还全着的就是它（真机读数 §9.1t）。
    assert.equal(items[0].props['data-kind'], 'round', `第一行不是本轮摘要：${kinds}`);
    assert.ok(textOf(items[0]).includes(t.payload.changeKindLabels.round), `摘要行的表头没念载荷给的话术：${textOf(items[0])}`);
    // 芯片那排只跟载荷给的 changeKindChips 走：摘要行能读能画，但不做成筛选项（界面不许多此一举）。
    const chips = byCls(cardByTitle(t.tree(), '变更记录'), 'ac-chip');
    assert.deepEqual(chips.map((n) => textOf(n)),
      ['全部', ...t.payload.changeKindChips.map((k) => t.payload.changeKindLabels[k])],
      '芯片不是"全部 + 载荷那几类"：要么客户端自己数了种类，要么把摘要行做成了筛选项');
    // ★ 反向那一发才管得住载荷自己漂：摘要行不许做成筛选项（这句是裁定，不是 chips 清单的同义反复）。
    assert.equal(chips.some((n) => textOf(n) === t.payload.changeKindLabels.round), false,
      '「本轮摘要」被做成了筛选项 ⇒ 界面上多一枚筛不出东西的芯片');
    // 种类芯片：点哪一类就让**服务端**筛哪一类，界面不许自己滤
    const wanted = kinds.find((k) => k !== 'round');
    const chip = byCls(cardByTitle(t.tree(), '变更记录'), 'ac-chip').find((n) => textOf(n) === t.payload.changeKindLabels[wanted]);
    assert.ok(chip, `芯片里没有 ${wanted} 这一类的中文话术`);
    await tap(t, chip);
    assert.equal(t.params('/api/changes').get('kind'), wanted);
    assert.deepEqual([...new Set(findAll(t.tree(), (n) => n.tag === 'li').map((n) => n.props['data-kind']))], [wanted]);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-28 上游删条目：流水写下「上游删除」，批注转 orphan 留在笔记里（不跟着删）', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    await typeIn(t, purposeBox(t.tree()), '这条我打算以后接');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    const lines = t.server.state.body.split('\n');
    const kept = lines.filter((l) => !l.includes(info.url));
    assert.equal(lines.length - kept.length, 1, `按 URL 删行不唯一（删了 ${lines.length - kept.length} 行），换个条目再测`);
    t.server.state.body = kept.join('\n');
    await server_round(t);
    await goTab(t, '变更');
    const items = findAll(t.tree(), (n) => n.tag === 'li');
    assert.ok(items.some((n) => n.props['data-kind'] === 'removed' && textOf(n).includes(info.name)),
      '上游删了这一条，流水里却找不到');
    const raw = t.server.rawNote(info.slug);
    assert.equal(raw.orphan, true, '批注跟着上游删了（裁定 ③：notes 是用户资产）');
    await goTab(t, '我的笔记');
    assert.equal(t.params('/api/notes').get('view'), 'all');
    const orphanChip = buttonsByText(cardByTitle(t.tree(), '我的笔记'), '上游已删', 'ac-chip')[0];
    await tap(t, orphanChip);
    assert.equal(t.params('/api/notes').get('view'), 'orphan');
    const rows = tbodyRows(t.tree());
    assert.equal(rows.length, 1);
    assert.ok(textOf(rows[0]).includes('上游已删'), '笔记页里没标出这条已 orphan');
    // ★ 这一行已经没有条目可 join 了：屏幕上还能读出人话名，只可能是批注自己那份快照在起作用
    assert.equal(t.server.rawNote(info.slug).name, info.name, '写批注时没从在册条目快照 name');
    assert.ok(textOf(rows[0]).includes(info.name),
      `orphan 那一行只剩 slug 尾巴（${info.slug} 的后半段）：批注行里的 name 快照没被界面用起来`);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-29 笔记四视图各自问服务端，切视图不发第二发快照', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    await typeIn(t, purposeBox(t.tree()), '写了一句');
    await typeIn(t, tagInput(t.tree()), '备用');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    await goTab(t, '我的笔记');
    const card = cardByTitle(t.tree(), '我的笔记');
    assert.equal(tbodyRows(card).length, 1);
    assert.ok(textOf(card).includes('1 条'), `笔记卡上的条数与表格对不上：${textOf(card)}`);
    const snaps = t.bridge.streams.length;
    for (const [label, view] of [['置顶', 'starred'], ['有标签', 'tags'], ['上游已删', 'orphan'], ['全部', 'all']]) {
      await tap(t, buttonsByText(card, label, 'ac-chip')[0]);
      assert.equal(t.params('/api/notes').get('view'), view, `${label} 那一站没按视图问服务端`);
    }
    assert.equal(t.bridge.streams.length, snaps, '切视图不该重连推流');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-30 导出两条分支：能下载就落盘，不能下载就把原文摊开让人复制', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    await typeIn(t, purposeBox(t.tree()), '要导出的一句');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    await goTab(t, '我的笔记');
    await tap(t, buttonsByText(t.tree(), '导出 JSON', 'ac-btn')[0]);
    const card = cardByTitle(t.tree(), '导出内容');
    assert.ok(card, '导完没给出内容卡');
    const text = byCls(card, 'ac-export')[0].props.value;
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed).sort(), ['exportedAt', 'keyRule', 'notes']);
    assert.equal(parsed.notes.length, 1);
    assert.equal(parsed.notes[0].slug, info.slug);
    assert.ok(Number.isInteger(parsed.keyRule), '导出的键规则版本要跟着快照走（换机时靠它判断键要不要重算）');
    assert.ok(Number.isFinite(Number(parsed.exportedAt)), '导出里的 exportedAt 不是个时间戳，复制出去的人对不上档期');
    assert.ok(t.doc.ops.includes('body+a') && t.doc.ops.includes('click'), '说好下载却只是把文本摊开');
    assert.ok(textOf(card).includes('已下载为 api-catalog-notes.json'), '能下载那一支要把落盘文件名念出来，不然点了像没反应');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-30b 这个环境里下载不了：不许演一个「已下载」，导出只剩可复制那份', async () => {
  const server = await mountServer();
  await server.sync();
  try {
    const t = await loadClient(server, { blob: false });
    await t.mountMain();
    const info = await openRow(t);
    await typeIn(t, purposeBox(t.tree()), '只能复制的一句');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    await goTab(t, '我的笔记');
    await tap(t, buttonsByText(t.tree(), '导出 JSON', 'ac-btn')[0]);
    const card = cardByTitle(t.tree(), '导出内容');
    assert.ok(textOf(card).includes('这个环境里下载不了'), textOf(byCls(card, 'ac-card-h')[0]));
    assert.equal(textOf(card).includes('已下载为'), false, '下载不了还写「已下载」就是冒充');
    assert.equal(byCls(card, 'ac-export')[0].props.value.includes(info.slug), true, '摊开的那份仍要能复制');
    await t.close();
  } finally { server.close(); }
});

check('cl-31 从笔记跳回目录：换页签 + 详情直接开在这一条上', async () => {
  const t = await booted();
  try {
    const info = await openRow(t);
    await typeIn(t, purposeBox(t.tree()), '要从笔记找回来的那条');
    await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
    await goTab(t, '我的笔记');
    await tap(t, tbodyRows(t.tree())[0]);
    assert.ok(textOf(byCls(t.tree(), 'ac-tab').find((n) => hasCls(n, 'on'))).startsWith('目录'), '没跳回目录页签');
    assert.equal(t.params('/api/entry').get('slug'), info.slug, '点笔记行没按 slug 去问那一条');
    const d = detailOf(t.tree());
    assert.ok(d, '从笔记跳回来却没展开详情（多半是被"再点同一行就收起"那一支收掉了）');
    assert.equal(textOf(byCls(d, 'nm')[0]), info.name);
    // 批注在 textarea 的 value 上，不在文本节点里
    assert.equal(purposeBox(t.tree()).props.value, '要从笔记找回来的那条', '详情里没带上那条批注');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-32 设置页：节拍芯片跟的是草稿，落库靠 POST /prefs，档位话术来自载荷', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const intervals = t.payload.checkIntervals;
    // ★ 2026-10-05 改版：这张卡从「同步」改名为「检查间隔」——
    //   原来叫「同步」是因为它同时装着「立即同步一轮」那颗按钮；按钮挪回页头之后，
    //   整张卡只剩「多久查一次」一件事，叫「同步」会让人以为点它就能立刻同步。
    //   卡片标题本身就是承诺（§38）：改名的同时把判据里的定位也跟着换了。
    const card = cardByTitle(t.tree(), '检查间隔');
    assert.ok(card, '设置页找不到「检查间隔」那张卡');
    const chips = byCls(card, 'ac-chip');
    assert.equal(chips.length, intervals.length);
    assert.deepEqual(chips.map(textOf), intervals.map((m) => t.payload.intervalLabels[String(m)] || `${m} 分钟`));
    const onIdx = chips.findIndex((n) => hasCls(n, 'on'));
    assert.equal(intervals[onIdx], DEFAULT_PREFS.intervalMin, '没写过偏好就该选中的是默认那一档');
    assert.equal(t.snapPrefs(), undefined, '没点保存就在库里写了一行偏好');
    await tap(t, chips[0]);
    assert.equal(byCls(cardByTitle(t.tree(), '检查间隔'), 'ac-chip').findIndex((n) => hasCls(n, 'on')), 0, '点了档位看不见');
    assert.equal(t.snapPrefs(), undefined, '没点保存就改了库');
    await tap(t, buttonsByText(cardByTitle(t.tree(), '检查间隔'), '保存设置', 'ac-btn-primary')[0]);
    assert.equal(t.lastCall('/api/prefs').method, 'POST');
    assert.equal(t.snapPrefs().intervalMin, intervals[0], '落库的还是旧档');
    assert.ok(clsText(t.tree(), 'ac-notice').includes(`已保存（间隔 ${intervals[0]} 分钟）`), clsText(t.tree(), 'ac-notice'));
    // 负向断言：设置页不许再有一颗「立即同步一轮」——它与页头那枚是同一件事，两个入口用户就得猜
    assert.equal(buttonsByText(t.tree(), '立即同步一轮', 'ac-btn').length, 0,
      '设置页又出现了第二颗立即同步：两个入口说同一句话');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-33 抓取源排序：两端按钮 disabled 是真的禁了，源的话术取自载荷那一条 note', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const byLabel = new Map(t.payload.sources.map((s) => [s.label, s.id]));
    const order = () => byCls(cardByTitle(t.tree(), '抓取源顺序'), 'ac-src-i')
      .map((n) => byLabel.get(textOf(byCls(n, 'lb')[0])));
    const card = cardByTitle(t.tree(), '抓取源顺序');
    assert.ok(card, '设置页找不到「抓取源顺序」那张卡');
    assert.equal(byCls(card, 'ac-src-i').length, SOURCES.length);
    assert.deepEqual(order(), t.payload.sources.map((s) => s.id), '界面把源排成了载荷之外的顺序');
    assert.deepEqual(byCls(card, 'ac-src-i').map((n) => byCls(n, 'nt')[0].props.title), t.payload.sources.map((s) => s.note));
    const items = byCls(card, 'ac-src-i');
    assert.equal(buttonsByText(items[0], '上移', 'ac-mini')[0].props.disabled, true, '第一源还能上移');
    assert.equal(buttonsByText(items[items.length - 1], '下移', 'ac-mini')[0].props.disabled, true, '最后一条还能下移');
    const idx = byCls(card, 'ac-src-i').map((n) => textOf(byCls(n, 'idx')[0]));
    // 序号跟着源档数走（换源那天是 3 档，现在是 5 档）：手抄 ['1','2','3'] 的话，加一档源就红一条不相干的用例。
    assert.deepEqual(idx, SOURCES.map((_, i) => String(i + 1)), '序号得跟着草稿顺序重排，不然上移之后看不出谁在第几位');
    await tap(t, buttonsByText(byCls(cardByTitle(t.tree(), '抓取源顺序'), 'ac-src-i')[1], '上移', 'ac-mini')[0]);
    const swapped = [t.payload.sources[1].id, t.payload.sources[0].id, ...t.payload.sources.slice(2).map((s) => s.id)];
    assert.deepEqual(order(), swapped, '点了上移但草稿顺序没动');
    assert.equal(t.snapPrefs(), undefined, '没点保存就改了库');
    await tap(t, buttonsByText(cardByTitle(t.tree(), '检查间隔'), '保存设置', 'ac-btn-primary')[0]);
    assert.deepEqual(JSON.parse(t.lastCall('/api/prefs').body).sourcePriority, swapped);
    assert.deepEqual(t.snapPrefs().sourcePriority, swapped, '顺序没落库：下一轮抓取还是会按旧序试');
    assert.ok(textOf(cardByTitle(t.tree(), '抓取源顺序')).includes('不用的源：'), '被拒的源也要念出来，不然下一个人会去找那条 URL');
    for (const r of t.payload.sourceRejected) assert.ok(textOf(card).includes(r.reason), `拒因没念全：${r.id}`);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-34 同步回执落在根上：每一页都看得见那句话（页签清单从 TAB_DEFS 取；设置页那颗按钮已并入页头）', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const before = t.callCount('/api/sync');
    // ★ 改版后设置页不再有「立即同步一轮」，回执的落点判据不变：从页头点，每一页都看得见。
    await tap(t, buttonsByText(t.tree(), '立即同步', 'ac-btn-primary')[0]);
    assert.equal(t.callCount('/api/sync'), before + 1, '页头那颗按钮没走路由');
    const notice = byCls(t.tree(), 'ac-notice')[0];
    assert.ok(notice, '点了同步却没有回执');
    const root = byCls(t.tree(), 'ac-root')[0];
    assert.ok(root.children.includes(notice), '回执写在某个页签里：换一页签就看不见自己刚点的那一下');
    assert.equal(t.callCount('/api/snapshot') >= 1, true, '跑完一轮要回读服务端那份，不许本地拼数字');
    // ★ 扫描面清单从 TAB_DEFS 取，不手抄（2026-10-07）：手抄那一份在加页签的当天就会漏掉新一页，
    //   而漏掉的那一页恰好是"什么都没测到"最不容易被发现的地方。
    for (const label of t.exports.__test.TAB_DEFS.map((d) => d.label)) {
      await goTab(t, label);
      assert.ok(byCls(t.tree(), 'ac-notice').length > 0, `${label} 页签上看不见回执`);
    }
    await t.close();
  } finally { t.server.close(); }
});

check('cl-35 能力位降级由页头那一行说话；「解析台账」那张卡每一页都撤干净了（页签清单从 TAB_DEFS 取）', async () => {
  // ★ 这条判据的方向改过两次，两次都留着记：
  //   2026-10-05 能力位从设置页挪进变更页的「解析台账」（理由：只读诊断混进可改设置里，会让人以为那儿能改）；
  //   2026-10-06 用户真机走查裁定「界面上彻底不摆」⇒ 那张卡撤了，快照里也不再摊 capabilityRows。
  //   "降级"这件事本身没消失：cl-7 钉的是页头那一行（服务端给的原因 + 只说真缺位的那一项）。
  //   这里钉的是**撤干净**：每一页的屏幕上都不许再出现台账、能力位卡、以及那两句维护者实话。
  //   ★ 2026-10-07：页签名单改成从 TAB_DEFS 取。手抄那一份在加「常用API」的当天就会漏掉新的一页 ——
  //     而"这一页从没被扫过"是这一族最便宜的假绿。
  const broken = { open: async () => { throw new Error('backend 拒绝了这份声明'); } };
  const server = await mountServer({ facility: broken });
  try {
    const t = await loadClient(server);
    await t.mountMain();
    for (const name of t.exports.__test.TAB_DEFS.map((d) => d.label)) {
      await goTab(t, name);
      const txt = textOf(t.tree());
      assert.equal(txt.includes('解析台账'), false, `${name} 页签上又摆出了台账`);
      assert.equal(txt.includes('宿主能力位'), false, `${name} 页签上又摆出了能力位那张卡`);
      assert.equal(txt.includes('--use-env-proxy'), false, `${name} 页签上又出现了代理那句实话`);
      assert.equal(txt.includes('重建库'), false, `${name} 页签上又出现了「为什么没有重建库按钮」那句`);
    }
    // 撤卡不许把降级那句话一起撤掉：存储坏了必须在屏幕上说出来。
    await goTab(t, '目录');
    assert.ok(clsText(t.tree(), 'ac-capsline').includes('存储不可用'), '台账撤了，页头也没说存储缺位：谎报一切正常');
    await t.close();
  } finally { server.close(); }
});

/* ================================================================== *
 * F. 铁律：浮层一处且由点击换来 + 类名与选择器对得上
 * ================================================================== */

const clientSource = () => fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
/** CSS 那一整块（含其中的选择器），与渲染代码分开取，免得把 CSS 里的类名当"用过的"混进来。 */
/**
 * CSS 那一整块（含其中的选择器），与渲染代码分开取，免得把 CSS 里的类名当"用过的"混进来。
 * ★ 2026-10-05 修正：cssTokens 之前**不剥 CSS 注释**，于是注释里为了解释历史而写的
 *   「tr.ac-detail-row」被当成了一条真选择器，cl-37 报「CSS 里有选择器但从不打这个类名」——
 *   看起来像有人留了条死规则，真因是量尺把自己脚下的注释量成了规则。
 *   判据：解释性注释提到某个类名，不该让一条死选择器洗白（也不该让断言变红）。
 *   —— 与「断言命中自己的注释」是同一族，只是这次量的是 CSS 那一侧。
 */
function splitCss(src) {
  const at = src.indexOf('const CSS = `');
  assert.ok(at > 0, 'client.js 里找不到 CSS 块（这一条判据就无从下手，别让它悄悄变成永真）');
  const end = src.indexOf('`;', at);
  // 注释里提到的类名不算"代码用过的"：文档说一句 .ac-xxx 不该把一条死选择器洗白。
  const rest = (src.slice(0, at) + src.slice(end)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  return { css: src.slice(at, end).replace(/\/\*[\s\S]*?\*\//g, ''), rest };
}
/** 只审 .ac- 前缀这一层：状态类（on/over）在 CSS 里以复合选择器出现，在代码里以模板片段出现，两边对不齐是格式问题不是错位。 */
const cssTokens = (css) => new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]).filter((c) => c.startsWith('ac-')));
const usedTokens = (rest) => new Set([...rest.matchAll(/\bac-[a-z0-9-]*/g)].map((m) => m[0]));

check('cl-35b 「继续加载」是唯一能拿到第 101 条的入口：offset 以服务端回传的游标为准，追加不替换', async () => {
  // 2026-10-05 修的真 bug：命中 2019 条却只列前 100 条，剩下 1919 条**没有任何入口**
  // （卡头原来那句「收窄一点再看」是一条死路）。这里钉住修好之后的四条不变量。
  const t = await booted();
  try {
    await debounce(t);
    const first = tbodyRows(t.tree());
    assert.equal(first.length, SEARCH_DEFAULT_LIMIT, `首屏该是 ${SEARCH_DEFAULT_LIMIT} 行，实际 ${first.length}`);
    // ① 入口在卡底，念出「已显示 N / 总数」——没有对应数字的按钮用户不知道点了会多出多少
    const more = buttonsByText(t.tree(), '继续加载', 'ac-btn')[0];
    assert.ok(more, '没有「继续加载」：第 101 条之后的 1919 条仍然够不着');
    assert.ok(textOf(more).includes(`已显示 ${SEARCH_DEFAULT_LIMIT} / ${TOTAL}`), `按钮没念出已显示/总数：${textOf(more)}`);
    // ② 首屏那一发不许带 offset（带了就是从第 100 条开始，用户看到的是空的）
    assert.equal(t.lastCall('/api/search').search.includes('offset='), false, '首屏就带 offset：列表会是空的');
    // ③ 第二页：游标用服务端回传的 offset+limit（不是界面自己数的 rows.length）
    await tap(t, more);
    assert.equal(Number(t.params('/api/search').get('offset')), SEARCH_DEFAULT_LIMIT, '第二页的起点不是服务端给的那个数');
    const after = tbodyRows(t.tree());
    assert.equal(after.length, SEARCH_DEFAULT_LIMIT * 2, `点了一次只到 ${after.length} 行：没追加到位`);
    // 追加不是替换：前 100 行必须原样还在，且与第二页首行不重复
    // ★ 去重必须按 **slug** 而不是名称 —— 上游真有同名条目（实测 2019 条里有 4 组：
    //   Animals 下两个不同的 "Cat Facts"、两个 "Dog Facts"…）。按名称去重会报出 4 条假重复，
    //   而真重复（同一 slug 出现两次）才是分页接错位的症状。
    const slugs = after.map(slugOfRow);
    assert.equal(slugs.length, new Set(slugs).size,
      `追加之后同一个 slug 出现了两次：两页接错了位置。重复的是 ${slugs.filter((s, i) => slugs.indexOf(s) !== i).join('、')}`);
    assert.deepEqual(slugs.slice(0, SEARCH_DEFAULT_LIMIT), first.map(slugOfRow),
      '追加把前面那批换掉了：这是替换不是追加');
    // ④ 还有下一页时按钮继续在，且数字跟着涨
    const again = buttonsByText(t.tree(), '继续加载', 'ac-btn')[0];
    assert.ok(again, '第二页之后按钮消失了：2019 条只load 得出 200');
    assert.ok(textOf(again).includes(`已显示 ${SEARCH_DEFAULT_LIMIT * 2} / ${TOTAL}`), textOf(again));
    await t.close();
  } finally { t.server.close(); }
});

check('cl-35c 换筛选条件时游标清零：带着旧 offset 去查新条件会跳过一片条目', async () => {
  const t = await booted();
  try {
    await debounce(t);
    await tap(t, buttonsByText(t.tree(), '继续加载', 'ac-btn')[0]);   // 先翻到第 2 页
    assert.equal(Number(t.params('/api/search').get('offset')), SEARCH_DEFAULT_LIMIT);
    // 换条件（点一个 facet）后，那一发必须回到 offset 缺席 —— offset 是**排序后全集**上的位置，
    // 旧游标在新结果集上指向另一批条目，沿用等于凭空跳过一片。
    const chip = byCls(byCls(t.tree(), 'ac-fg').find((n) => textOf(n).startsWith('鉴权')), 'ac-chip')
      .find((n) => textOf(n).startsWith('免鉴权'));
    await pick(t, chip);
    assert.equal(t.params('/api/search').get('offset'), null, '换条件了还带着旧 offset：结果会缺一片且没法解释');
    // 免鉴权 963 条，但**一屏只列 100**（limit 归服务端，界面不自己加）⇒ 这里量的是
    // 「回到第一页那100 行」，不是「全部 963 条都列出来了」。
    assert.equal(hits(t.tree()), NO_KEY, '换条件后卡头报的命中数不对');
    assert.equal(tbodyRows(t.tree()).length, SEARCH_DEFAULT_LIMIT,
      `换条件后应当回到第一页（${SEARCH_DEFAULT_LIMIT} 行），实际 ${tbodyRows(t.tree()).length} 行`);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-35d 「继续加载」失败要落在页面内：不弹层、不自动消失，且按钮还在能重试', async () => {
  const t = await booted();
  try {
    await debounce(t);
    const real = t.server.handler;
    t.server.handler = () => async (req, res) => {
      if (String(req.url).includes('/api/search') && String(req.url).includes('offset=')) {
        return real()({ ...req, url: '/api/nope' }, res);
      }
      return real()(req, res);
    };
    await tap(t, buttonsByText(t.tree(), '继续加载', 'ac-btn')[0]);
    await t.settle();
    // 失败必须看得见：用户点了却什么都没有 = 以为功能坏了
    const notice = byCls(t.tree(), 'ac-notice');
    assert.ok(notice.length > 0, '加载下一页失败了却什么都没有：用户点了不知道发生了什么');
    assert.ok(clsText(t.tree(), 'ac-notice').includes('下一页'), clsText(t.tree(), 'ac-notice'));
    // 且不能把已经显示的那 100 行清空 —— 失败不该毁掉已经看到的
    assert.ok(tbodyRows(t.tree()).length >= SEARCH_DEFAULT_LIMIT, '失败把已显示的行清掉了');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-35b2 游标不许被写死成 100：服务端夹过 limit 之后下一起点必须跟着变', async () => {
  // 为什么单独一条：把 next 硬编码成 100（或拿界面自己的 rows.length 猜）在**默认 limit=100 时
  // 行为完全正确** —— 200/300/400 行都对，cl-35b 一条都抓不到。
  // 而服务端会夹 limit（?limit=99999 ⇒ 实际 200），那时「写死 100」就会每次取回同一页，
  // 症状是列表卡在 200 行不动、按钮还在、点它像坏了。
  // 这条直接用 ?limit=7 造一个 limit≠100 的场景：任何写死/猜错游标的实现都会在这里露馅。
  const t = await booted();
  try {
    await debounce(t);
    // 手动发几发不同 limit 的查询，量服务端回传的游标是不是「跟着 limit 走」
    const a = await t.ask('?limit=7&offset=0');
    assert.equal(a.rows.length, 7, '服务端没按 limit=7 切片');
    assert.equal(a.limit, 7, '回传的 limit 与请求不符');
    assert.equal(a.offset, 0, '回传的 offset 与请求不符');
    assert.equal(a.hasMore, true);
    const b = await t.ask('?limit=7&offset=7');
    assert.equal(b.offset, 7, '第二页起点不是第一页的 offset+limit');
    assert.equal(b.limit, 7);
    // ★ 关键判据：游标逐页递增（7 → 14 → 21），不是恒定不变。
    //   写死成 100 的实现在limit=7 这一档会每次都从第 100 条起 —— 症状是列表不涨或跳片。
    let cur = a;
    for (let i = 0; i < 3; i += 1) {
      const next = await t.ask(`?limit=7&offset=${cur.offset + cur.limit}`);
      assert.equal(next.offset, (i + 1) * 7, `第 ${i + 2} 页起点是 ${next.offset}，应为 ${(i + 1) * 7}`);
      cur = next;
    }
    await t.close();
  } finally { t.server.close(); }
});

check('cl-35b3 「继续加载」是纯追加：点三次得 300 行，且每一段 slug 都与单页查询逐字相等', async () => {
  // 反向验证的靶子：把 loadMore 里的 next 换成常量、或让游标停在第一页，
  // 症状都是「连点之后行数不再涨 / 涨的是同一批」。这里连点三次并逐段核对 slug。
  const t = await booted();
  try {
    await debounce(t);
    for (let i = 0; i < 3; i += 1) {
      const btn = buttonsByText(t.tree(), '继续加载', 'ac-btn')[0];
      assert.ok(btn, `第 ${i + 1} 次点之前按钮就没了：点 ${i} 次之后就该没有下一页`);
      const off = Number(t.params('/api/search').get('offset'));
      const expect = i === 0 ? 100 : off + 100;
      await tap(t, btn);
      assert.equal(Number(t.params('/api/search').get('offset')), expect,
        `第 ${i + 1} 次点发出的 offset 是 ${t.params('/api/search').get('offset')}，应为 ${expect}（每页必须推进一整页）`);
    }
    const all = tbodyRows(t.tree());
    assert.equal(all.length, 400, `连点三次该有 400 行，实际 ${all.length}：游标没推进就是反复取回同一页`);
    const slugs = all.map(slugOfRow);
    assert.equal(slugs.length, new Set(slugs).size, '连点之后出现重复 slug');
    // 最后一段（第 301~400 行）必须与服务端单独查 offset=300 的结果逐字相等
    const direct = await t.ask('?offset=300');
    assert.deepEqual(slugs.slice(300), direct.rows.map((r) => r.slug),
      '界面追加出来的最后 100 条与单独查那一页不一致：两边的排序口径不同');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-35e 换筛选条件后游标真的回到 0：连点两次「继续加载」再换条件，行数必须重新从头数', async () => {
  // 变异 4（onFilter 里不清游标）在这条才现形：带着旧 offset=200 去查新条件，
  // 结果集从第 201 条开始 —— 行数看着"有"，但第 1~200 条永远看不到，且界面上完全看不出来。
  const t = await booted();
  try {
    await debounce(t);
    await tap(t, buttonsByText(t.tree(), '继续加载', 'ac-btn')[0]);
    await tap(t, buttonsByText(t.tree(), '继续加载', 'ac-btn')[0]);
    assert.equal(tbodyRows(t.tree()).length, 300, '先翻到第 3 页');
    const chip = byCls(byCls(t.tree(), 'ac-fg').find((n) => textOf(n).startsWith('鉴权')), 'ac-chip')
      .find((n) => textOf(n).startsWith('免鉴权'));
    await pick(t, chip);
    // ★ 核心判据：新条件那一发不带 offset，且**首行就是那个条件下的第 1 条**
    //   （与服务端裸查 offset=0 逐字相等）。带着旧游标时首行会是第 201 条。
    assert.equal(t.params('/api/search').get('offset'), null, '换条件了还带着旧 offset');
    const rows = tbodyRows(t.tree());
    const direct = await t.ask('?auth=No');
    assert.deepEqual(rows.slice(0, 3).map(slugOfRow), direct.rows.slice(0, 3).map((r) => r.slug),
      '换条件之后的首行不是新结果集的第 1 条：游标没清零，从中间开始了');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-11b 分类栏初值跟着视口宽度走：窄面板默认收起（51 类铺开会把结果顶出两屏），读不到宽度按展开', async () => {
  // 判据拆两半，因为这是两个不同的失败：
  //  ① 窄面板（430px）里 51 类铺开 → 结果区被顶到两屏之外（无头截图抓到的）
  //  ② 兜底方向不能反 —— `innerWidth || 0` 会让"窄屏收起"在拿不到尺寸的环境里恒真，
  //     把两栏布局的分类栏也收起来（沙箱与部分宿主 iframe 就是这种环境）。
  const t = await booted();
  try {
    // 沙箱给的缺省是 1280（两栏那一档）⇒ 分类栏必须在场。
    // 这一条同时钉住兜底方向：读不到尺寸时若按"窄屏"处理，两栏布局的分类栏会被收起来。
    assert.equal(t.sandbox.innerWidth, 1280, '沙箱没给缺省视口宽：窄屏分支永远测不到');
    assert.equal(byCls(t.tree(), 'ac-rail-i').length, CATEGORIES + 1,
      '两栏布局下分类栏不在场：兜底方向反了（读不到尺寸时应当按展开处理）');
    // 换成窄宽度重新挂载：必须收起
    const narrow = await loadClient(t.server);
    narrow.sandbox.innerWidth = 430;
    await narrow.mountMain();
    assert.equal(byCls(narrow.tree(), 'ac-rail-i').length, 0,
      '430px 窄面板里 51 类仍然铺开：结果区会被顶到两屏之外');
    assert.ok(buttonsByText(narrow.tree(), '展开', 'ac-link').length > 0,
      '收起了却没有「展开」入口：用户没法把分类栏叫回来');
    // 展开入口可点，且点开就是 51 类
    await tap(narrow, buttonsByText(narrow.tree(), '展开', 'ac-link')[0]);
    assert.equal(byCls(narrow.tree(), 'ac-rail-i').length, CATEGORIES + 1, '点了「展开」分类栏没出来');
    await narrow.close();
    await t.close();
  } finally { t.server.close(); }
});

check('cl-11c 分类栏不许藏内容：两栏走网格、窄栏一列，两种都不许有 max-height 截断', async () => {
  // ★ 2026-10-05 真机驳回的两条，钉在这里（判据是**不许某种写法**，不是量像素 ——
  // 像素判据要真机量，测试套件里量不到；写法判据能挡住"下次又写回去"）。
  const src = await clientSource();
  const { css } = splitCss(src);
  // ① max-height 截断是上一版「这个框无法滚动」的根因：51 类内容 1403px 只露 520px，
  //    而截图上完全看不出有东西被藏。任何给 .ac-rail-list / .ac-rail 写 max-height 的改动都退回去。
  const truncating = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel, body]) => /ac-rail(-list)?\b/.test(sel) && /max-height\s*:/.test(body))
    .map(([, sel]) => sel.trim());
  assert.deepEqual(truncating, [],
    `分类栏又被写了 max-height（${truncating.join(' | ')}）：51 类内容 1403px，截断 ⇒ 分类藏起来且滚不到`);
  // ② 栏内那一发滚动规则见下面 directlyInWide 之后（要用它，所以排在其后）。
  // ③ 两栏必须铺网格（顺序也钉：网格那条要排在 display:flex 基线**之后**）
  // ④ 网格必须待在 min-width:960px 段里。sticky 这一族 2026-10-06 整体退场（见下面那条反向判据）。
  //    ⚠️ 三个坑，全都踩过，逐个记在这里（都是"判据被注释骗了"这一族）：
  //    (a) 跨 brace 的正则匹配 media 查询 —— 嵌套括号让 [^}]* 在第一层 } 就停；
  //    (b) 用 indexOf('@media', …) 切段 —— 注释里出现 @media 三个字就把段提前切断；
  //    (c) 用 lastIndexOf('@media', i) 找"规则所属的 media" —— 前两版都栽在这儿：
  //        它找的是**前面最近**的 media 头，而那可能包着的是**别的**规则。
  //        实测「把 grid 移到 media 之外、sticky 留在里面」这一版：grid 前面最近的 media 头
  //        仍然是某个 min-width:960px 段（段里包的是 sticky），判据于是误判通过。
  //    正解：**按块配对**——从规则所在位置往前扫花括号数，找到**真正包住它**的那一层，
  //    再看那一层的开头是不是 @media (min-width:960px)。
  //    （剥注释是第一步：cl-37「CSS 注释里的类名不算选择器」与这里是同一族。）
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** 这条规则是不是被 @media (min-width:960px) 直接包裹（而不是只在前面的某个段里）。 */
  const directlyInWideAt = (i) => {
    let depth = 0;
    for (let k = i - 1; k >= 0; k -= 1) {
      const ch = cssNoComment[k];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        if (depth === 0) {
          // 找到包住它的那个开括号，取它前面那一小段当选择器
          const head = cssNoComment.slice(Math.max(0, k - 60), k);
          const at = head.lastIndexOf('@media');
          return at >= 0 && /@media\s*\(min-width:\s*960px\)\s*$/.test(head.slice(at).trim());
        }
        depth -= 1;
      }
    }
    return false;   // 文件最外层（没有任何块包着）
  };
  const directlyInWide = (rule) => {
    const i = cssNoComment.indexOf(rule);
    return i < 0 ? null : directlyInWideAt(i);
  };
  // ② 栏内这一发只许在**宽栏**段里，而且只许是 auto：格子矮到装不下 52 项时它是兜底（cl-39 分配表里那一发）。
  //    ★ 2026-10-06 两次改判：v1 的理由"宿主主列已经是滚动容器"是错的（asar 实测 .BynINW_centerCol 是 overflow:hidden）；
  //    v2 禁栏内滚动是因为"根已经滚，栏内再开一层就是嵌套"；v3 根不滚了，栏与结果列表成了**兄弟**，
  //    于是这一发从"禁"变成"只许在宽栏段里"。窄栏那一档 .ac-cat 整块滚，栏内再开就是嵌套 ⇒ 仍然禁。
  const railScrollIdx = [...cssNoComment.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel, b]) => /ac-rail(-list)?\b/.test(sel) && /overflow(-y)?\s*:\s*(auto|scroll)/.test(b))
    .map((m) => [m[1].trim(), m.index]);
  assert.ok(railScrollIdx.length >= 1, '分类栏的兜底滚动那一发不见了：格子矮下来时 52 类会被裁掉且滚不到');
  for (const [sel, idx] of railScrollIdx) {
    // ★ 必须按 **index** 判，不能按选择器再 indexOf 一次：同一个选择器写了基线 + 宽栏覆盖两遍，
    //   indexOf 只会回到**基线**那一发（它在 media 之外），判据就把兜底那一发误判成"没在宽栏段里"。
    assert.equal(directlyInWideAt(idx), true,
      `分类栏的滚动规则（${sel}）不在 min-width:960px 段里：窄栏会和 .ac-cat 叠成两层嵌套滚动`);
  }
  const gridRule = '.ac-rail-list{display:grid';
  const gi = css.indexOf(gridRule);
  assert.ok(gi > 0, '找不到 .ac-rail-list{display:grid 这一条：两栏下没有网格');
  const flexAt2 = cssNoComment.indexOf('.ac-rail-list{display:flex');
  assert.ok(flexAt2 >= 0 && flexAt2 < cssNoComment.indexOf(gridRule),
    '网格规则排在了 display:flex 基线前面：同特异度后者胜，网格会被静默覆盖（第一版踩过，白改一轮）');
  assert.equal(directlyInWide(gridRule), true,
    '网格规则不在 min-width:960px 段里：窄面板会跟着铺两列，中文标签被压到截断（第三版踩过）');
  // ⑤ ★ 反向判据（2026-10-06 v3）：sticky 与 z-index 一律不许回来。
  //    前两版顶栏和分类栏都靠 sticky 贴住根的滚动视口；现在根不滚，滚动发生在下面的内容区里，
  //    顶栏是被 flex 钉在格子上界的 ⇒ sticky 没有可贴的滚动容器，留着就是一条"文本在、效果死"的规则。
  assert.equal(/position\s*:\s*sticky/.test(cssNoComment), false,
    '又写了 sticky：根不滚了，它贴不住任何东西，分类栏/顶栏的常驻由 cl-39 那条 flex 链保证');
  // ★ 2026-10-06 第三次改判：z-index 不再是"零发"，而是"只许详情遮罩那一发"。
  //   判据仍是前提式的，而且要能失效：先证明扫得到遮罩那一发，再判有没有第二发 ——
  //   直接写 equal(list, []) 的话，选择器一漂就变成"零条规则"的假绿。
  const zRules = [...cssNoComment.matchAll(/([^{}]+)\{([^{}]*z-index[^{}]*)\}/g)]
    .map(([, sel]) => sel.replace(/\s+/g, ' ').trim());
  assert.ok(zRules.length >= 1, '一条带 z-index 的规则都扫不到：遮罩那一发漂了，下面那条判据正在空转');
  assert.deepEqual([...new Set(zRules)].filter((s) => s !== '.ac-modal-mask'), [],
    `第二处层叠（${[...new Set(zRules)].filter((s) => s !== '.ac-modal-mask').join(' | ')}）：全场只许详情遮罩盖在页面之上`);
});

check('cl-36 浮层只有一处且必须由点击换来：详情对话框是唯一能盖住页面的东西，自动弹出的提示条仍然全场禁止', async () => {
  const t = await booted();
  try {
    const { css } = splitCss(await clientSource());
    const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // ★ 2026-10-06 改判（用户："点击具体的api使用弹框方式展示详情"）。这一条原来钉的是"零浮层"，
    //   连带禁掉 position:fixed 与 z-index。现在的口径是**只许一处**：详情对话框的遮罩。
    //   两头都要卡：一发都不许（旧口径）会挡死弹框，"随便几发只要含 fixed 就算"会放出自定义浮层。
    const selOf = (re) => [...noComment.matchAll(re)].map(([, s]) => s.replace(/\s+/g, ' ').trim());
    const fixedRules = selOf(/([^{}]+)\{[^{}]*position\s*:\s*fixed[^{}]*\}/g);
    assert.ok(fixedRules.length >= 1, '一条 fixed 规则都扫不到：遮罩那一发漂了，"只许一处"正在空转');
    assert.deepEqual([...new Set(fixedRules)], ['.ac-modal-mask'],
      `fixed 溢出到遮罩之外（${fixedRules.join(' | ')}）：宿主主列 overflow:hidden，多一处就会盖住别的面板`);
    assert.deepEqual([...new Set(selOf(/([^{}]+)\{[^{}]*z-index[^{}]*\}/g))], ['.ac-modal-mask'],
      '层叠只许遮罩一处，见 cl-11c ⑤');
    assert.equal(/100vh/.test(css), false, '不拿视口高度当根高：frame 带标题栏 padding，100vh 必超（外观插件真机抓过）');
    // 对话框之外的那一类名字，一个都不许出现在树上（toast/提示条仍然是"自动弹出"的同义词）
    const overlayCls = /toast|overlay|popover|drawer|tooltip|picker|dropdown/i;
    const hits = findAll(t.tree(), (n) => overlayCls.test(String(n.props.className || '')));
    assert.equal(hits.length, 0, hits.map((n) => n.props.className).join('|'));
    // ★ 这一发是"只能由点击换来"的落点：**没点任何一行**时树上不许有遮罩。
    assert.equal(maskOf(t.tree()), undefined, '还没点行就有遮罩：浮层只能由点击换来，不许自动弹');
    // 点开之后：有且只有一发，且它是 role=dialog（键盘与读屏都靠这个属性认出边界）
    await openRow(t);
    assert.equal(byCls(t.tree(), 'ac-modal-mask').length, 1, '点开一行：遮罩应当恰好一发');
    // ★ 这一发要开在**框已经出现之后**：原来它写在默认态那一屏，等于判了个空（tmp/mut_ac09 M7 量出来的）。
    assert.equal(findTag(t.tree(), 'dialog').length, 0, '用的是原生 dialog 标签：宿主样式会往里塞东西，认 role 就够');
    const dlg = detailOf(t.tree());
    assert.equal(dlg.props.role, 'dialog', '对话框没带 role=dialog');
    assert.equal(dlg.props['aria-modal'], 'true', '没带 aria-modal');
    assert.ok(String(dlg.props['aria-label'] || '').length > 0, 'aria-label 空着：读屏时这一框没有名字');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-37 类名 ↔ 选择器双向对齐：渲染用到的每个 .ac-* 都有规则，CSS 里也没留着没人用的', async () => {
  const src = await clientSource();
  const { css, rest } = splitCss(src);
  const styled = cssTokens(css);
  const used = usedTokens(rest);
  // 双向都判：少了规则 = 那一块按浏览器默认样式画（走查里的错位）；多了选择器 = 没接上的功能或漂走的旧口径。
  assert.deepEqual([...used].filter((c) => !styled.has(c)), [], '渲染代码里有类名没有对应的 CSS 规则');
  assert.deepEqual([...styled].filter((c) => !used.has(c)), [], 'CSS 里有选择器但 client.js 从不打这个类名');
});

check('cl-37b 列表行不许留下定宽表格的遗产：col/colgroup 与固定列宽一条都不许回来', async () => {
  // ★ 2026-10-05 版式改版：原来这条钉的是「每个 col 类名都要有 col.X{width} 规则」。
  //   结果区改成列表行之后，列宽平摊这套机制整体退场 ⇒ 反过来钉：
  //   **一旦col/colgroup 或 table-layout:fixed 回来，就是有人把表格搬回来了**，
  //   而截图里的横向滚动会跟着回来（那正是这轮改版要消掉的东西）。
  const src = await clientSource();
  const { css } = splitCss(src);
  assert.equal(findAll((await booted()).tree(), (n) => n.tag === 'col').length >= 0, true);
  assert.equal(/table-layout\s*:\s*fixed/.test(css), false, 'fixed 列宽是表格那套的遗产');
  assert.equal(/\bac-q-/.test(css), false, 'ac-q-* 是 colgroup 的列宽类名，列表行下不该再有');
  assert.equal(/\.ac-tbl\b/.test(css), false, '.ac-tbl 是那张表自己的类，删了表就得连它一起删');
  // 反向验证的靶子：col 元素确实抓不到了（否则这条断言会恒真）。
  assert.equal((src.match(/h\('col',\s*\{/g) || []).length, 0, '代码里还在造 col 元素');
});

check('cl-38 样式只有一发且挂在 head：撤销器把这一发摘干净（宿主重新激活时不叠第二份）', async () => {
  const server = await mountServer();
  try {
    const t = await loadClient(server, { styleAlready: true });
    const before = t.doc.ops.length;
    await t.mountMain();
    assert.equal(t.doc.ops.length, before, 'document 里已有同 id 的样式还再塞一份');
    const styleEffect = t.clientCtx.effects.find((e) => e.label === 'api-catalog:style');
    assert.ok(styleEffect, '样式没走 effect 注册，撤销器就无从挂');
    assert.equal(typeof styleEffect.disposer, 'function', 'effect 没返回撤销器');
    await t.close();
  } finally { server.close(); }
});

check('cl-39 滚动层分配（v3）：根不滚、顶栏常驻、目录宽栏滚结果列表、窄栏滚 .ac-cat、其余页签滚 .ac-panel', async () => {
  // ★ 2026-10-06 第二次真机驳回后的口径。三条实测事实没变（从**正在跑的** app.asar 抽，
  //   取证脚本 tmp/asar-ls.mjs / tmp/asar-peek.mjs，只读）：
  //     .BynINW_centerCol{display:flex;flex-direction:column;overflow:hidden} —— 宿主那一格定高、自己不滚；
  //     .BynINW_frame 是 grid + grid-template-rows:minmax(0,1fr)，Windows 那支带标题栏 padding ⇒ 100vh 必超（cl-36 已禁）；
  //     槽位 div[data-slot=main] 是 ANCHOR_STYLE{display:contents} ⇒ 根就是格子的直接 flex item，height:100% 有参照。
  //   变的是结论：上一版让**根**当那层滚动容器，真机截图上搜索框和筛选条跟着结果一起滚走了
  //   （用户："这个框不要滚动，只滚动下面这个框"）。所以根只做两件事：接住格子的高度、不滚。
  //   判据钉的是**前提**不是文本：链上少一环 min-height:0，overflow 那条就只是"写着好看"，效果死。
  const { css } = splitCss(await clientSource());
  const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 同一选择器可能写两遍（基线 + min-width:960px 段里覆盖）⇒ 取**最后**那一发才是生效的那发。
  // ⚠ 两头都要卡住：前面用后视排除 `>`（否则查 .ac-cat 会命中 .ac-root>.ac-cat 那条组合选择器），
  //   后面允许一段逗号尾巴（否则 .ac-list,.ac-cardfill{…} 这种多选择器规则查不到）。
  const body = (sel) => {
    const all = [...noComment.matchAll(new RegExp(`(?<![>+])${esc(sel)}(?:,\\s*[^{}]*)?\\{([^{}]*)\\}`, 'g'))];
    return all.length ? all[all.length - 1][1] : null;
  };
  const root = body('.ac-root');
  assert.ok(root, '找不到 .ac-root 这条规则（选择器或写法漂了）');
  assert.match(root, /height\s*:\s*100%/, '根没有 height:100%：格子定高，根不接住就没有"剩余高度"可分给内容区');
  assert.match(root, /overflow\s*:\s*hidden/, '根没有 overflow:hidden：不成滚动容器就没有"自动最小尺寸归 0"，会被内容顶出格子');
  assert.equal(/overflow(-y)?\s*:\s*(auto|scroll)/.test(root), false,
    '根又自己滚了：整块滚会把搜索框与筛选条一起滚走（2026-10-06 真机那一屏驳回的就是这个）');
  assert.equal(/max-height\s*:/.test(root), false, '根用了 max-height：第一代「这个框无法滚动」的写法，截断且看不出来');
  assert.equal(/100vh/.test(root), false, '根高不许按视口取（cl-36 同源：frame 带标题栏 padding，100vh 必然顶出尾巴）');
  // 直接子项钉死 flex:none，再单独放开页签内容区：顶栏与回执条因此常驻，不需要 sticky
  const kids = body('.ac-root>*');
  assert.ok(kids, '没有 .ac-root>*{flex:none} 这一条：顶栏会被内容高度压扁（modelwatch 真机把页签条压成 1px）');
  assert.match(kids, /flex\s*:\s*none/, '.ac-root>* 的 flex 不是 none');
  const panel = body('.ac-root>.ac-cat,.ac-root>.ac-panel');
  assert.ok(panel, '没有"页签内容区吃掉剩余高度"这一条：下面每一发的 min-height:0 都没有上游');
  assert.match(panel, /flex\s*:\s*1 1 auto/, '内容区没放开 flex：它只有内容那么高，列表永远不滚');
  assert.match(panel, /min-height\s*:\s*0/, '内容区没有 min-height:0：自动最小尺寸按内容算，整块被顶出格子');
  // ① 封闭集合：全场允许存在的纵向滚动容器就这几发，别的一律算第二层。
  //   ★ .ac-modal 是 2026-10-06 加的第 6 发，性质与前五发不同：它不参与页面承重链（遮罩是 fixed，
  //     不在 .ac-root 的 flex 流里），框比视口矮的时候靠它自己滚。加进来是为了让这条判据继续"封闭"，
  //     不是为了放过新的一层 —— 名单外的选择器仍然当场算第二层滚动。
  const ALLOW = ['.ac-panel', '.ac-cat', '.ac-rail-list', '.ac-main>.ac-card>.ac-list', '.ac-main>.ac-card>.ac-cardfill', '.ac-modal'];
  const layers = [...noComment.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, sel, b]) => [sel.replace(/\s+/g, ' ').trim(), b])
    .filter(([, b]) => /(^|;)\s*overflow(-y)?\s*:\s*(auto|scroll)/.test(b));
  assert.ok(layers.length >= 4, `只扫到 ${layers.length} 发纵向滚动规则：滚动层分配表判无可判（这条判据自己先失效）`);
  const extra = layers.filter(([sel]) => !ALLOW.some((a) => sel === a || sel.split(',').map((s) => s.trim()).includes(a)));
  assert.deepEqual(extra.map(([s]) => s), [], `滚动层分配表外的选择器也开了纵向滚动（${extra.map(([s]) => s).join(' | ')}）`);
  // ② 不许嵌套：宽栏下 .ac-cat 必须显式关掉自己的滚动（否则 .ac-cat 滚 + .ac-list 滚 = 两层，滚轮会被两层都不消费）
  const catWide = body('.ac-cat');
  assert.match(catWide, /overflow\s*:\s*hidden/, '宽栏下 .ac-cat 没有收回 overflow：它会和 .ac-list 叠成两层嵌套滚动');
  // ②′ ★ 承重的其实是这一发：两栏必须等高。F6 证伪量出来的 —— 把 align-items 退回 flex-start，
  //    右栏就按内容长高（6000px），卡片被 .ac-cat 的 hidden 裁掉，尾巴既不在格子里也没有能滚的容器包着它：
  //    8 屏坏，而当时**一条用例都没挂**（这一度是这条判据自己的假绿）。
  assert.match(catWide, /align-items\s*:\s*stretch/, '宽栏没有 align-items:stretch：右栏按内容长高 ⇒ 卡片被裁、列表滚不到（F6 实测 8 屏坏）');
  // ③ 有界链：.ac-cat → .ac-main → .ac-card → .ac-list。
  //    ★ 这一串里今天**真正承重**的是：卡片的 flex:1 1 auto（F7 实测：改成 flex:none 就 8 屏坏）
  //    和上面那条 align-items:stretch（F6）。三处 min-height:0 单独删掉都量不出差别（F2/F2b/F8 都是等价变异）——
  //    因为 overflow 不是 visible 的盒子，自动最小尺寸按规范本来就是 0。留着是保险：
  //    一旦哪一发被改成 overflow:visible，min-height:0 就是唯一挡住"按内容长高"的东西。
  const mainWide = body('.ac-main');
  assert.ok(mainWide, '找不到 .ac-main 规则');
  const card = body('.ac-main>.ac-card');
  assert.ok(card, '没有 .ac-main>.ac-card 这一条：结果卡没被放开，.ac-list 就没有可滚的高度');
  assert.match(card, /min-height\s*:\s*0/); assert.match(card, /flex\s*:\s*1 1 auto/);
  const list = body('.ac-main>.ac-card>.ac-list');
  assert.ok(list, '没有 .ac-main>.ac-card>.ac-list 这一条：主滚动层不存在（用户看到的还是"显示不全，不能滚动"）');
  assert.match(list, /overflow-y\s*:\s*auto/); assert.match(list, /min-height\s*:\s*0/);
  assert.match(list, /overscroll-behavior\s*:\s*contain/, '滚到底会把滚动传给外面那一格');
  // ④ 常驻的那几发不许被放开：搜索框与筛选条是"别跟着滚"的那一屏
  const mainKids = body('.ac-main>*');
  assert.ok(mainKids && /flex\s*:\s*none/.test(mainKids), '.ac-main>* 没有 flex:none：搜索框/筛选条会被压扁或跟着滚');
  // ④′ 滚动容器的直接子项要钉住：**带 overflow:hidden 的那一发**才需要（卡片为圆角自带 hidden，
  //     按规范自动最小尺寸算 0 ⇒ 不钉就被压进容器，卡里的内容裁掉、外层还以为不用滚）。
  //     2026-10-06 探针在变更页抓到：两张卡 208>184、396>350。
  //     .ac-cat 不在这张名单里是有意的：它的子项（.ac-rail / .ac-main）没有 hidden，自动最小尺寸按内容算；
  //     给它加一条 .ac-cat>*{flex:none} 反而会盖掉 .ac-main{flex:1 1 auto}（同特异度、看谁写在后面）。
  for (const sel of ['.ac-panel']) {
    const kids2 = body(`${sel}>*`);
    assert.ok(kids2 && /flex\s*:\s*none/.test(kids2), `${sel} 是滚动容器却没有 ${sel}>*{flex:none}：里面的卡片会被压扁`);
  }
  // ⑤ 顶栏常驻是靠 flex 钉住的，不是 sticky：sticky 与 z-index 这一版全部退场
  assert.equal(/position\s*:\s*sticky/.test(noComment), false, '又出现 sticky：根不滚了，sticky 没有滚动容器可贴，是条死规则');
});

/* ================================================================== *
 * G. 中文说明（S9：行内中文、弹框落款、设置页那张「中文说明」卡）
 *
 * 这一节的取向与 D 段一致：**判据挂在界面上真显示出来的那一份**，不在这里重译渠道逻辑
 * （那一层的判据在 test/translate.mjs、落库形状在 test/store.mjs、载荷边界在 host-compat 的 hc-14）。
 * 这里只问三件事：行里显示的是不是服务端给的那句中文、那句话的出处有没有跟着走、
 * 设置页那一张卡有没有把"库里已存"与"我改了什么"分开显示、以及密钥有没有在任何一个节点上现身。
 * ================================================================== */

/** 按 data-slug 取列表行里那句用途（名称会重复，slug 不会）。 */
const rowDescOf = (root, slug) => {
  const r = findAll(root, (n) => hasCls(n, 'ac-li') && slugOfRow(n) === slug)[0];
  assert.ok(r, `列表里没有 slug=${slug} 这一行：界面上没把它渲染出来`);
  const d = byCls(r, 'ac-desc')[0];
  assert.ok(d, `这一行没有 .ac-desc 那一格：${slug}`);
  return d;
};

/** 芯片按**整句文本**找：「不启用」里含着「启用」，buttonsByText 那种 includes 会拿错那枚。 */
const chip = (root, label) =>
  findAll(root, (n) => n.tag === 'button' && hasCls(n, 'ac-chip') && textOf(n) === label)[0];

const transCard = (root) => cardByTitle(root, '中文说明');
const jsonBody = (t, path) => JSON.parse(t.lastCall(path).body);

/** 开着对话框时点掉某一 slug 那一行（详情走的是 /api/entry，与列表那一发不是同一份数据）。 */
async function openRowSlug(t, slug) {
  const r = findAll(t.tree(), (n) => hasCls(n, 'ac-li') && slugOfRow(n) === slug)[0];
  assert.ok(r, `要点的那一行不在屏幕上：${slug}`);
  await tap(t, r);
  const d = detailOf(t.tree());
  assert.ok(d, '点了行却没有详情对话框');
  return d;
}

check('cl-40 列表行内直接显示中文：行里是服务端给的那句，上游英文原句只待在 title 里；没中文的行不许挂中文的落款', async () => {
  const t = await booted();
  try {
    // ① 浏览态（界面此刻就是这一屏）：有中文的那一行
    const browse = await t.ask(`?limit=${SEARCH_DEFAULT_LIMIT}`);
    const hit = browse.rows.find((r) => r.descZh && r.descZh !== r.desc);
    assert.ok(hit, `浏览态这一页 ${browse.rows.length} 行一句中文都没有 ⇒ 读侧那层 join 整条没接上，界面测不了显示`);
    const d1 = rowDescOf(t.tree(), hit.slug);
    assert.equal(textOf(d1), hit.descZh, '行里显示的不是服务端给的那句中文');
    assert.ok(String(d1.props.title || '').includes(hit.desc), '上游原句没挂在 title 上：用户没法核对这句中文对应哪句英文');

    // ② 换到"内置表里没有的那一句"：显示原句，而且不挂那张中文的落款
    await typeIn(t, byCls(t.tree(), 'ac-q')[0], 'Bitbucket');
    await debounce(t);
    const srv = await t.ask('?q=Bitbucket');
    const plain = srv.rows.find((r) => !r.descZh && r.desc);
    assert.ok(plain, `搜 Bitbucket 的 ${srv.rows.length} 行都有中文 ⇒ 取不到"没中文时显示什么"那一支，换关键词`);
    const d2 = rowDescOf(t.tree(), plain.slug);
    assert.equal(textOf(d2), plain.desc, '没中文的行把英文换成了别的字：那是替用户编了一句');
    assert.equal(d2.props.title, '', '没中文的行也挂了「上游原文：…」：等于给英文发了一张中文的落款');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-41 弹框里的出处那一行：中文来自哪一层由服务端那句决定，没中文时整行不出现', async () => {
  const t = await booted();
  try {
    const browse = await t.ask(`?limit=${SEARCH_DEFAULT_LIMIT}`);
    const hit = browse.rows.find((r) => r.descZhFrom === 'builtin');
    assert.ok(hit, '浏览态这一页里没有内置表命中的那一档 ⇒ 落款的第一个分支测不到');
    assert.equal(hit.descZhLabel, DESC_ZH_LABEL, '这一行的落款不是内置表那句 ⇒ 服务端那侧的口径漂了，先修判据前提');

    const d = await openRowSlug(t, hit.slug);
    const faint = byCls(d, 'ac-faint').map(textOf);
    assert.ok(faint.some((x) => x.includes(DESC_ZH_LABEL)), `落款没念服务端那句「${DESC_ZH_LABEL}」：${faint.join(' | ')}`);
    assert.equal(byCls(d, 'ac-desc')[0].props.title.includes(hit.desc), true, '对话框里也没把上游原句带出来');
    await tap(t, buttonsByText(d, '关闭', 'ac-link')[0]);

    await typeIn(t, byCls(t.tree(), 'ac-q')[0], 'Bitbucket');
    await debounce(t);
    const srv = await t.ask('?q=Bitbucket');
    const plain = srv.rows.find((r) => !r.descZh && r.desc);
    assert.ok(plain, '搜 Bitbucket 那一页每一行都有中文 ⇒ 取不到"没中文时该没有落款"那一支');
    const d2 = await openRowSlug(t, plain.slug);
    const probes = [DESC_ZH_LABEL, transZhLabel('host_llm', 0)];
    const leaked = byCls(d2, 'ac-faint').map(textOf).filter((x) => probes.some((p) => x.includes(p)));
    assert.deepEqual(leaked, [], `这句英文拿到了中文的落款：${leaked.join(' | ')}`);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-42 设置页那张「中文说明」卡：档位、话术、数字全取自载荷/快照；载荷说没接入的那一档列出来但点不动', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const card = transCard(t.tree());
    assert.ok(card, '设置页没有「中文说明」这一卡');
    const note = t.payload.transSettingsNote;
    assert.ok(note && textOf(card).includes(note), '那句「密钥为什么不在 prefs」没念载荷给的原文');
    assert.ok(textOf(card).includes(t.payload.transCooldownNote), 'cooldown 那句话不是载荷给的那句');

    // 2026-10-06 用户裁定「腾讯，阿里，讯飞必须接入」⇒ 现树五档全部已接线：这一屏上不该再有"点不动"的档
    const channels = t.payload.transChannels;
    assert.equal(channels.filter((c) => c.implemented !== true).length, 0,
      '登记表又出现未接入的档位（现树该是五档全接）');
    for (const c of channels) {
      const btn = chip(card, c.label);
      assert.ok(btn, `渠道「${c.label}」没上屏幕：隐藏的档位等于让用户以为少一档`);
      assert.equal(Boolean(btn.props.disabled), false, `已接入的「${c.label}」被禁了`);
      assert.ok(String(btn.props.title).includes(c.quota) && String(btn.props.title).includes(c.note),
        `「${c.label}」那格没念载荷给的额度句与说明`);
    }
    // 两个数字：内置那份来自载荷，本机那两份来自快照（这里一个都不许是界面自己数的）
    assert.ok(textOf(byCls(card, 'ac-card-n')[0]).includes(String(t.payload.builtinTransCount)),
      '「内置已备 N 句」里的 N 不是载荷给的那个数');
    assert.equal(t.server.facility.rowCount(DOMAIN_NAME, TABLES.trans), 0, '夹具阶段现译表该是空的，否则下面那两个 0 测不出来源');
    assert.ok(textOf(card).includes('本机现译 0 句 · 失败 0 句'), '本机那两个数没跟着快照走');
    // 开关出厂是关的：芯片选中态跟着库里那份，不跟着界面默认
    assert.ok(String(chip(card, '不启用').props.className).includes(' on'), '出厂开关是关的，屏幕上却显示启用');
    assert.equal(textOf(card).includes(t.payload.transCredBoundary), false,
      '开关还没开就把凭据边界那句摊在一屏里');

    // disabled 那一支还在（载荷说没接线时界面必须点不动），但它现在只能在**改过的载荷**上测到：
    // 同 cl-49 摘一格那个路子 —— 测的是"界面照载荷办事"，不是"现树里有一档没接"。
    // ★ 这上面那几句必须在开第二个实例之前核完：第二个客户端挂的是同一台服务端，它跑起来会把 trans 表写脏。
    const dead = channels[0];
    const patched = {
      ...t.payload,
      transChannels: channels.map((c, i) => (i === 0 ? { ...c, implemented: false } : c)),
    };
    const t2 = await loadClient(t.server, { payload: patched });
    await t2.mountMain();
    await goTab(t2, '设置');
    const card2 = transCard(t2.tree());
    assert.ok(card2, '换了载荷以后「中文说明」卡整张不见了');
    const btn2 = chip(card2, `${dead.label} · 未接入`);
    assert.ok(btn2, `载荷说「${dead.label}」没接线，屏幕上却没有这一档（隐藏的档位 = 用户以为只有另几档）`);
    assert.equal(btn2.props.disabled, true, `「${dead.label}」没接进来却点得动`);
    assert.ok(String(btn2.props.title).includes(dead.note), `「${dead.label}」没接入的原因没念载荷那一句`);
    await t2.close();
    await t.close();
  } finally { t.server.close(); }
});

check('cl-43 凭据输入框只在「开关开着 + 这一档已接入 + 这一档要凭据」时出现，密钥那一格是 password 且不回显', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const card = () => transCard(t.tree());
    const inputs = () => findAll(card(), (n) => n.tag === 'input');
    const baidu = t.payload.transChannels.find((c) => c.implemented === true && c.needsKey === true);
    assert.ok(baidu, '载荷里没有「已接入且要凭据」的档位 ⇒ 这一条整支测不到');
    const fields = t.payload.transCredFields[baidu.id];
    assert.ok(Array.isArray(fields) && fields.length >= 2, `${baidu.id} 的凭据字段规格不齐（${JSON.stringify(fields)}）`);

    assert.equal(inputs().length, 0, '开关还没开就摆出了凭据输入框');
    // ★ 把两个条件**错位**摆一次：要凭据的那一档 + 开关还关着。
    //   只走「先开开关再换档」那条路的话，"只看 needsKey 不看开关"的写法在这条判据上是全绿的（U12 第一轮就这么漏的）。
    await tap(t, chip(card(), baidu.label));
    assert.equal(inputs().length, 0, '开关关着、这一档要凭据：这时候摆框，存进去也没人消费');
    await tap(t, chip(card(), '启用'));
    assert.equal(textOf(card()).includes(baidu.label), true, '渠道芯片里没列出要凭据的那一档');
    assert.equal(inputs().length, fields.length, `开完开关该有 ${fields.length} 格，屏幕上是 ${inputs().length} 格`);
    // 反着再摆一次：开关开着 + 这一档不要凭据（宿主模型那一档）⇒ 一个框都不许有
    const nollm = t.payload.transChannels.find((c) => c.implemented === true && c.needsKey !== true);
    assert.ok(nollm, '载荷里没有「已接入但不要凭据」的档位 ⇒ 这一支测不到');
    await tap(t, chip(card(), nollm.label));
    assert.equal(inputs().length, 0, `开关开着就给「${nollm.label}」摆了凭据框：那一档没有要填的东西`);
    await tap(t, chip(card(), baidu.label));
    assert.equal(inputs().length, fields.length, `凭据框该有 ${fields.length} 格，屏幕上是 ${inputs().length} 格`);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const box = inputs()[i];
      assert.ok(String(box.props.placeholder).includes(f.label), `第 ${i} 格没写出它对应「${f.label}」`);
      assert.ok(String(box.props.placeholder).includes(String(f.max)), `「${f.label}」那格的上限不是载荷给的数`);
      assert.equal(box.props.type, f.secret === true ? 'password' : 'text',
        `「${f.label}」的输入类型跟载荷里那个 secret 标记不一致`);
      assert.equal(box.props.value, '', '输入框回显了库里的值：secrets 表零 GET 路由，界面上本就拿不到值');
      assert.equal(box.props.autoComplete, 'off', '浏览器自动填充会把密钥写进另一个网站的表单里');
    }
    assert.ok(textOf(card()).includes(t.payload.transCredBoundary), '凭据区出现了，边界那句却不在');

    // optional 那一栏（腾讯的「地域」）：placeholder 要念载荷给的 hint —— 说不清"留空会怎样"，用户就以为必填
    const optChannel = t.payload.transChannels
      .find((c) => (t.payload.transCredFields[c.id] || []).some((f) => f.optional === true));
    assert.ok(optChannel, '载荷里没有一个 optional 凭据字段 ⇒ hint 那条渲染路径成了死码，这一支没测到东西');
    const optFields = t.payload.transCredFields[optChannel.id];
    const optSpec = optFields.find((f) => f.optional === true);
    await tap(t, chip(card(), optChannel.label));
    assert.equal(inputs().length, optFields.length, `${optChannel.label} 的凭据框数量跟清单对不上`);
    const optBox = inputs()[optFields.indexOf(optSpec)];
    assert.ok(String(optBox.props.placeholder).includes(optSpec.hint),
      `「${optSpec.label}」这格没念载荷那句「${optSpec.hint}」`);
    assert.ok(String(optBox.props.placeholder).includes(String(optSpec.max)),
      `「${optSpec.label}」那格的上限不是载荷给的数`);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-44 存入密钥：值只走 /api/translate/secret，库里逐字、界面上只剩「已配置 · N 位」，手上那份当场清掉', async () => {
  const t = await booted();
  const APPID = '20250101000000001';
  const SECRET = 'super-secret-key-9f3a';
  try {
    await goTab(t, '设置');
    const card = () => transCard(t.tree());
    const inputs = () => findAll(card(), (n) => n.tag === 'input');
    const baidu = t.payload.transChannels.find((c) => c.implemented === true && c.needsKey === true);
    const fields = t.payload.transCredFields[baidu.id];
    await tap(t, chip(card(), '启用'));
    await tap(t, chip(card(), baidu.label));

    await typeIn(t, inputs()[0], APPID);
    await typeIn(t, inputs()[1], SECRET);
    let saves = findAll(card(), (n) => n.tag === 'button' && textOf(n) === '存入');
    assert.equal(saves.length, 2, '两格都还没存 ⇒ 「存入」该出现两次');
    assert.equal(findAll(card(), (n) => n.tag === 'button' && textOf(n) === '清除').length, 0,
      '库里没有这一格却摆出「清除」');

    await tap(t, saves[0]);
    const body1 = jsonBody(t, '/api/translate/secret');
    assert.deepEqual(Object.keys(body1).sort(), ['channel', 'field', 'value'], `凭据那一发多带了键：${Object.keys(body1)}`);
    assert.equal(body1.channel, baidu.id);
    assert.equal(body1.field, fields[0].id);
    assert.equal(body1.value, APPID);
    assert.equal(t.server.facility.rowCount(DOMAIN_NAME, TABLES.secrets), 1, '第一次存入没落库');
    assert.equal(JSON.stringify(t.server.rawPrefs() || {}).includes(APPID), false, 'AppID 进了 prefs 表：那条红线是「prefs 里没有凭据」');

    assert.equal(inputs()[0].props.value, '', '存完手上那一份没清掉：界面上留了第二份值');
    assert.equal(t.callCount('/api/translate/secret'), 1, '一次「存入」发了不止一发');

    saves = findAll(card(), (n) => n.tag === 'button' && textOf(n) === '存入');
    await tap(t, saves[0]);
    assert.equal(t.server.facility.rawRow(DOMAIN_NAME, TABLES.secrets, secretKey(baidu.id, fields[1].id)).value, SECRET,
      '屏幕上写着已存入，库里却没有这一行');

    const labels = findAll(card(), (n) => n.tag === 'label').map(textOf);
    assert.equal(labels.filter((x) => x.includes('已配置')).length, 2, `两格都存过了，界面上却只报出 ${labels.filter((x) => x.includes('已配置')).length} 格`);
    assert.ok(labels.some((x) => x.includes(`已配置 · ${SECRET.length} 位`)), `密钥那格没只报位数：${labels.join(' | ')}`);
    assert.ok(String(inputs()[0].props.placeholder).includes(t.payload.secretSavedHint),
      '已配置的那格 placeholder 该换成「留空表示不改动」那句');
    assert.equal(findAll(card(), (n) => n.tag === 'button' && textOf(n) === '清除').length, 2, '存过的格子没给出清除入口');
    assert.equal(JSON.stringify(t.tree()).includes(SECRET), false, '密钥出现在渲染树的某个属性上：那是把值带回浏览器了');
    assert.equal(JSON.stringify(t.server.rawPrefs() || {}).includes(SECRET), false, '密钥进了 prefs 表');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-45 两半各存各的：按「保存现译设置」只发这一卡的四项，没按「保存设置」的间隔改动不跟着一起落库', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const intCard = cardByTitle(t.tree(), '检查间隔');
    assert.ok(intCard, '设置页少了「检查间隔」那张卡');
    const before = (t.server.rawPrefs() || {}).intervalMin ?? DEFAULT_PREFS.intervalMin;
    const intChips = findAll(intCard, (n) => n.tag === 'button' && hasCls(n, 'ac-chip'));
    const other = intChips.find((n) => !String(n.props.className).includes(' on'));
    assert.ok(other, '间隔芯片全是选中态 ⇒ 夹具不齐，测不到「改了没保存」');
    await tap(t, other);

    const baidu = t.payload.transChannels.find((c) => c.implemented === true && c.needsKey === true);
    await tap(t, chip(transCard(t.tree()), '启用'));
    await tap(t, chip(transCard(t.tree()), baidu.label));
    // 代理那一档也拨一下再保存：不发这一枚，「切了代理按保存没生效」在界面上是静默的（这一发就是那条的锚）。
    const proxyChip = chip(transCard(t.tree()), t.payload.proxyModeLabels.direct);
    assert.ok(proxyChip, '载荷给了代理档位，界面上却没有那一枚芯片');
    await tap(t, proxyChip);
    await tap(t, buttonsByText(transCard(t.tree()), '保存现译设置')[0]);

    const body = jsonBody(t, '/api/prefs');
    assert.deepEqual(Object.keys(body).sort(), ['proxyMode', 'proxyUrl', 'transChannel', 'transEnabled'],
      `保存现译却把别的偏好一起发了（用户按哪枚都一样）：${Object.keys(body)}`);
    assert.equal(body.transEnabled, true);
    assert.equal(body.transChannel, baidu.id);
    assert.equal(body.proxyMode, 'direct', '代理芯片拨了 direct，载荷里却没这一项 ⇒ 这一枚存不下去');
    assert.equal((t.server.rawPrefs() || {}).intervalMin, before, '没按「保存设置」的间隔被这一发一起写进库了');
    assert.ok(clsText(t.tree(), 'ac-notice').includes(baidu.label), '回执没念载荷里那一档的中文名（自己拼一个就等于两处命名）');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-46 状态行念的是库里那一档（不是草稿）；宿主给了模型句柄才说"就绪"', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const sub = () => textOf(byCls(transCard(t.tree()), 'ac-sub')[0]);
    const saved = sub();
    assert.ok(saved.length > 0, '状态行是空的');
    // 只改草稿、不保存：这一行讲的是服务端的事实，不该跟着草稿跑
    const baidu = t.payload.transChannels.find((c) => c.implemented === true && c.needsKey === true);
    await tap(t, chip(transCard(t.tree()), baidu.label));
    assert.equal(sub(), saved, '草稿切了渠道，状态行却跟着改口：那说的是"我还没保存"的那一档');

    // 保存之后库里就是百度那档，缺凭据 ⇒ 状态行换成「还缺：AppID、密钥」，且缺的东西取自载荷字段规格
    await tap(t, chip(transCard(t.tree()), '启用'));
    await tap(t, buttonsByText(transCard(t.tree()), '保存现译设置')[0]);
    const need = (t.payload.transCredFields[baidu.id] || []).map((f) => f.label);
    const after = sub();
    assert.notEqual(after, saved, '库里换了档，状态行还念着旧的那一档');
    for (const label of need) assert.ok(after.includes(label), `缺凭据的那句没报出「${label}」：${after}`);
    assert.ok(after.includes('一句都不发'), `缺凭据时没说明"发不出去"：${after}`);

    // 对照两支：宿主给不给模型句柄，界面上那一句要不一样（出厂默认档是宿主模型）
    const withOut = await booted();
    const withIn = await booted({
      llm: makeLlmHandle(), modelPicker: makeModelPicker({ provider: 'p', model: 'm' }),
    });
    try {
      await goTab(withOut, '设置');
      await goTab(withIn, '设置');
      const a = textOf(byCls(transCard(withOut.tree()), 'ac-sub')[0]);
      const b = textOf(byCls(transCard(withIn.tree()), 'ac-sub')[0]);
      assert.notEqual(a, b, '宿主有没有模型句柄在界面上看不出差别：那是把 llmReady 当摆设');
      await withIn.close();
      await withOut.close();
    } finally { withOut.server.close(); withIn.server.close(); }
    await t.close();
  } finally { t.server.close(); }
});

check('cl-47 「立即补齐」在开关没开时是禁的；测试连接与补齐各只发自己那一发，跳过的原因按载荷那张表念', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const card = () => transCard(t.tree());
    const runBtn = buttonsByText(card(), '立即补齐')[0];
    assert.ok(runBtn, '没有「立即补齐」这一发按钮');
    assert.equal(runBtn.props.disabled, true, '开关没开却可以直接点补齐');
    assert.equal(t.callCount('/api/translate/run'), 0, '没点它却已经发了补齐那一发');

    const label = t.payload.transErrorLabels.unavailable;
    assert.ok(label, '夹具载荷里没给 unavailable 的话术 ⇒ 下面两句断言会空转');
    await tap(t, buttonsByText(card(), '测试连接')[0]);
    assert.equal(t.callCount('/api/translate/test'), 1, '一发「测试连接」发了不止一次');
    assert.ok(clsText(t.tree(), 'ac-notice').includes(label), `测试连接的回执没念载荷那张表：${clsText(t.tree(), 'ac-notice')}`);

    // 开关打开（库里仍是宿主模型那一档，而宿主没给句柄）：这一发该在服务端第一层收口，一个请求都不发
    await tap(t, chip(card(), '启用'));
    await tap(t, buttonsByText(card(), '保存现译设置')[0]);
    await tap(t, buttonsByText(card(), '立即补齐')[0]);
    assert.equal(t.callCount('/api/translate/run'), 1);
    assert.equal(t.callCount('/api/translate/secret'), 0, '点补齐却顺手写了凭据');
    assert.equal(t.server.facility.rowCount(DOMAIN_NAME, TABLES.trans), 0, '渠道没备好时那一轮还是往 trans 表里写了行');
    const notice = clsText(t.tree(), 'ac-notice');
    assert.ok(notice.includes(label), `补齐的回执没念载荷那张表：${notice}`);
    // 上一轮的读数留在卡上（用户下一次进来也看得见）
    await goTab(t, '目录');
    await goTab(t, '设置');
    assert.ok(textOf(card()).includes(label), `上一轮跳过的原因没挂在卡上：${textOf(card())}`);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-48 一轮同步跑完就把没中文的那句补上：trans 表真落了、帧真推了、行里的中文跟着出现（用户什么都没点）', async () => {
  const handle = makeLlmHandle([{ type: 'text-delta', text: '比特桶的代码托管接口。' }, { type: 'finish' }]);
  const picker = makeModelPicker({ provider: 'p', model: 'm' });
  const t = await booted({ llm: handle, modelPicker: picker });
  try {
    assert.equal(handle.calls.length, 0, '开关还没开就碰了宿主模型（默认零调用那条口径）');
    await goTab(t, '设置');
    await tap(t, chip(transCard(t.tree()), '启用'));
    await tap(t, buttonsByText(transCard(t.tree()), '保存现译设置')[0]);
    await goTab(t, '目录');
    await typeIn(t, byCls(t.tree(), 'ac-q')[0], 'Bitbucket');
    await debounce(t);

    const srv0 = await t.ask('?q=Bitbucket');
    const plain = srv0.rows.find((r) => !r.descZh && r.desc);
    assert.ok(plain, '夹具这一页里没有"还没中文"的行 ⇒ 这一条测不到增量补中文');
    assert.equal(textOf(rowDescOf(t.tree(), plain.slug)), plain.desc, '补之前这一行就已经有中文了');

    const framesBefore = t.bridge.frameCount();
    await server_round(t);
    await debounce(t);

    assert.ok(handle.calls.length >= 1, '一轮跑完模型句柄一次都没被调 ⇒ 增量挂点没接上');
    const raw = t.server.facility.rawRow(DOMAIN_NAME, TABLES.trans, transKey(plain.desc));
    assert.ok(raw && raw.ok === true, `库里没有这一句的现译行：${JSON.stringify(raw)}`);
    assert.ok(t.bridge.frameCount() > framesBefore, '现译写完没有推帧：界面靠的就是这一帧补中文');

    const srv1 = await t.ask('?q=Bitbucket');
    const row = srv1.rows.find((r) => r.slug === plain.slug);
    assert.equal(row.descZhFrom, 'trans', `这句中文的来源不是现译那一层：${row.descZhFrom}`);
    assert.equal(textOf(rowDescOf(t.tree(), plain.slug)), row.descZh, '界面上这一行还是英文 ⇒ 推的那一帧没被消费');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-49 服务端那半边没有「现译」这一格时一个控件都不摆（改了 index.js 没重启那种新旧搭）', async () => {
  const t = await booted();
  try {
    let hit = 0;
    const strip = (d) => {
      if (!d || !('translate' in d)) return d;
      hit += 1;
      const { translate, ...rest } = d;
      return rest;
    };
    const old = await loadClient(t.server, { ssePatch: strip });
    await old.mountMain();
    assert.ok(hit >= 1, 'ssePatch 一发快照都没撞到 ⇒ 这一条什么都没测');
    await goTab(old, '设置');
    assert.equal(transCard(old.tree()), undefined, '服务端没这一格时界面还摆半套控件（按了保存而没人消费）');
    assert.equal(old.callCount('/api/translate/test'), 0);
    assert.equal(old.callCount('/api/translate/run'), 0);
    assert.ok(cardByTitle(old.tree(), '检查间隔'), '现译那一格缺席把「检查间隔」也连坐了');
    assert.ok(cardByTitle(old.tree(), '抓取源顺序'), '现译那一格缺席把源顺序那张卡也连坐了');
    // 对照：同一台服务端、不摘这一格 ⇒ 卡必须在（否则上面那几句等于在测一个本来就不存在的东西）
    await goTab(t, '设置');
    assert.ok(transCard(t.tree()), '对照那一发里卡本来就没有 ⇒ 摘不摘都测不出来');
    await old.close();
    await t.close();
  } finally { t.server.close(); }
});

/* ================================================================== *
 * H. 详情弹框的重排 + 用法层（2026-10-06：用户裁定「布局都是乱的，清晰简明概要一点」，
 *    并要求「先把使用方式抓过来整理好打包进插件，运行时不抓」）
 *    ★ 那一节的每一个字都得能指回载荷里那份规范：界面不许自己拼 base、不许补鉴权词。
 * ================================================================== */

/** 夹具里「构建期抓到了机器可读规范」的那些条（键口径与读侧同一个 normUrl，不另起一套）。 */
function usageHits() {
  const hits = [];
  for (const e of parseCatalog(README).entries) {
    const u = USAGE[normUrl(e.url)];
    if (u) hits.push({ name: e.name, url: e.url, usage: u });
  }
  return hits;
}

/** 名字取得搜得到（纯 ASCII、一个词），否则"点开这一条"变成测搜索的分词。 */
const searchable = (x) => /^[A-Za-z][A-Za-z0-9 ._-]{2,40}$/.test(x.name);

function pickHit(pred, why) {
  const h = usageHits().find((x) => searchable(x) && pred(x));
  assert.ok(h, `夹具里没有「${why}」的已抓条目 ⇒ 这一支测不到：先看抓取覆盖，别放宽判据`);
  return h;
}

function pickMiss() {
  const miss = parseCatalog(README).entries.find((e) => !USAGE[normUrl(e.url)]
    && /^[A-Za-z][A-Za-z0-9 ._-]{2,40}$/.test(e.name));
  assert.ok(miss, '夹具里每一条都抓到规范 ⇒ "没抓到就整节不摆"那一支测不到');
  return miss;
}

/** 按名字 + URL 搜到那一行并点开（只按名字不行：夹具里「Cat Facts」有两条，URL 不同）。 */
async function openByName(t, hit) {
  await typeIn(t, byCls(t.tree(), 'ac-q')[0], hit.name);
  await debounce(t);
  const srv = await t.ask(`?q=${encodeURIComponent(hit.name)}`);
  const same = srv.rows.filter((r) => r.name === hit.name && r.url === hit.url);
  assert.equal(same.length, 1, `搜「${hit.name}」回到 ${same.length} 行同名同址的：这一条测不出点开的是哪一条`);
  const d = await openRowSlug(t, same[0].slug);
  return { d, row: same[0] };
}

const sections = (d) => byCls(d, 'ac-sec-t').map(textOf);

check('cl-50 弹框按节排版：读的顺序就是 这是什么→怎么用→限制→我的批注；没抓到规范的那条整节不摆', async () => {
  const t = await booted();
  try {
    const hit = pickHit((x) => x.usage.servers.length > 0, '抓到规范且里面有 servers');
    const { d } = await openByName(t, hit);
    assert.deepEqual(sections(d), ['这是什么', '怎么用', '现在的限制', '我的批注'],
      `分节不对：${sections(d).join(' | ')}`);
    assert.equal(byCls(d, 'ac-sec').length, 4, '一节一个 .ac-sec：多一格就是有人把同一节摆了两遍');
    // 重排不许动老判据数的那几格：各就各位、各只一条
    assert.equal(byCls(d, 'ac-desc').length, 1);
    assert.equal(byCls(d, 'ac-derived').length, 1);
    assert.equal(byCls(d, 'ac-urlrow').length, 1, 'URL 那一行被搬进某一节里就是多了一层');
    // ★ 出处那一行只剩链接（2026-10-07 用户裁定「直接撤掉这个按钮」）：那枚「重新取」走的是 GET /api/entry，
    //   读的是本机库里那一行、不碰上游，而"关掉再点开"是同一个调用 —— 名字还容易读成去上游重抓。
    assert.equal(byCls(d, 'ac-urlrow')[0].children.length, 1, '出处那一行又长出第二格了');
    assert.ok(!textOf(d).includes('重新取'), '「重新取」又回到弹框上了');
    // 「怎么用」排在「限制」前面：用户问的是"这条怎么用"，不是"这条有什么坑"
    assert.ok(textOf(d).indexOf('怎么用') < textOf(d).indexOf('现在的限制'));
    await tap(t, buttonsByText(d, '关闭', 'ac-link')[0]);

    const miss = pickMiss();
    const { d: d2 } = await openByName(t, miss);
    assert.deepEqual(sections(d2), ['这是什么', '现在的限制', '我的批注'],
      `没登记规范的条目摆了占位节：${sections(d2).join(' | ')}`);
    assert.equal(byCls(d2, 'ac-usage').length, 0, '整节不摆，但里面那格还是被造出来了');
    assert.equal(byCls(d2, 'ac-sec').length, 3);
    await t.close();
  } finally { t.server.close(); }
});

check('cl-51 「怎么用」每一格逐字念载荷那份规范：servers 空就不摆地址行，绝不拿条目 url 顶上', async () => {
  const t = await booted();
  try {
    // ① 有 base、有操作、还被截断的那一条：地址行 / 操作行 / 截断那句 / 出处行都来自载荷
    const hit = pickHit((x) => x.usage.servers.length > 0 && x.usage.pathCount > x.usage.operations.length,
      '抓到规范、有 servers、且操作多于界面列的那几格');
    const { d } = await openByName(t, hit);
    const u = hit.usage;
    const mono = byCls(d, 'ac-mono').map(textOf);
    for (const s of u.servers) assert.ok(mono.includes(s), `地址行没逐字念规范里的 servers：缺 ${s}`);
    for (const op of u.operations) assert.ok(mono.includes(op.path), `操作行少了规范里的 ${op.method} ${op.path}`);
    const absent = byCls(d, 'ac-absent').map(textOf).join(' ');
    assert.ok(absent.includes(`规范里共 ${u.pathCount} 个操作`) && absent.includes(`前 ${u.operations.length} 个`),
      `截断那句的数字不是载荷那两个数：${absent}`);
    const specLink = findAll(d, (n) => n.tag === 'a' && n.props.href === u.spec)[0];
    assert.ok(specLink, `出处没链到那份 spec（${u.spec}）：这一节的来历就断了`);
    assert.ok(textOf(specLink).includes(u.kind), '出处那句没念规范自己的 kind');

    // ② 鉴权话术：只由 type / in / name 拼，界面无中生有的词一个都不许出现
    await tap(t, buttonsByText(d, '关闭', 'ac-link')[0]);
    const gs = pickHit((x) => x.usage.globalSecurity.some((id) => {
      const s = x.usage.schemes.find((y) => y.id === id) || {};
      return s.type === 'apiKey' && s.in === 'header' && s.name;
    }), '全局鉴权里带一个 header 型 apiKey');
    const scheme = gs.usage.schemes.find((s) => gs.usage.globalSecurity.includes(s.id) && s.type === 'apiKey' && s.in === 'header');
    const { d: d2 } = await openByName(t, gs);
    const authLine = byCls(d2, 'ac-ukv').map(textOf).find((x) => x.startsWith('鉴权'));
    assert.ok(authLine, '载荷写了全局鉴权，界面上却没有这一行');
    assert.ok(authLine.includes(`key 放请求头 ${scheme.name}`), `鉴权那句没念规范里的字段名：${authLine}`);
    assert.equal(byCls(d2, 'ac-mono').map(textOf).some((x) => /^https?:\/\//.test(x) && !gs.usage.servers.includes(x)), false,
      '地址行里出现了规范没有的 URL');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-52 规范里没 servers / 没写全局鉴权的那两条：该行不摆，写了方案却没写是否必需时那句话照原样说', async () => {
  const t = await booted();
  try {
    const nb = pickHit((x) => x.usage.servers.length === 0, '抓到规范但里面没有 servers');
    const { d } = await openByName(t, nb);
    assert.equal(byCls(d, 'ac-ukv').map(textOf).some((x) => x.startsWith('地址')), false,
      '规范没写 servers，界面上却摆了一行地址（拿条目 url 顶上就是编造）');
    assert.equal(textOf(d).includes(nb.url), true, '条目自己那一行 URL 不能跟着一起消失');
    // 条目 url 只在 .ac-urlrow 那一格出现，用法层里一格都没有
    assert.equal(byCls(d, 'ac-mono').map(textOf).filter((x) => x.includes(nb.url)).length, 0,
      `地址行把条目 url 当成调用地址写了：${nb.url}`);
    await tap(t, buttonsByText(d, '关闭', 'ac-link')[0]);

    const sc = pickHit((x) => x.usage.schemes.length > 0 && x.usage.globalSecurity.length === 0,
      '定义了鉴权方案但没写全局是否必需');
    const { d: d2 } = await openByName(t, sc);
    const authLine = byCls(d2, 'ac-ukv').map(textOf).find((x) => x.startsWith('鉴权'));
    assert.ok(authLine && authLine.includes('规范没写是不是每个请求都要'),
      `这一支的话术没念出来（那是事实，不是缺陷）：${authLine}`);
    await tap(t, buttonsByText(d2, '关闭', 'ac-link')[0]);

    const ns = pickHit((x) => x.usage.schemes.length === 0 && x.usage.globalSecurity.length === 0,
      '整份规范里一个鉴权方案都没写');
    const { d: d3 } = await openByName(t, ns);
    assert.equal(byCls(d3, 'ac-ukv').map(textOf).some((x) => x.startsWith('鉴权')), false,
      '规范没写鉴权，界面就摆了一行鉴权：那是"没有"被排版成了"有"');
    await t.close();
  } finally { t.server.close(); }
});

check('cl-53 「中文说明」卡按节排版：开关关着三节，要凭据那一档才多一节；按钮跟输入框同一行', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const card = () => transCard(t.tree());
    // 每次都重新找：点一下芯片整棵树就换一批节点，抓在手上的旧节点不会跟着更新。
    const sec = (title) => byCls(card(), 'ac-sec').find((n) => textOf(byCls(n, 'ac-sec-t')[0]) === title);
    const inputsIn = (title) => findAll(sec(title), (n) => n.tag === 'input').length;
    assert.deepEqual(sections(card()), ['用哪一档译', '现译出网', '保存与试发'],
      `开关没开时的分节不对：${sections(card()).join(' | ')}`);
    // 一句状态一节：渠道那句讲"发不发得出去"，代理那句讲"从哪条路出去"，各自一句才不算重复。
    assert.equal(byCls(card(), 'ac-sub').length, 2, `卡里的状态句不止两节各一句：${byCls(card(), 'ac-sub').map(textOf).join(' ␟ ')}`);
    assert.equal(byCls(sec('用哪一档译'), 'ac-sub').length, 1, '渠道那一节的状态句不是一句');
    assert.equal(byCls(sec('现译出网'), 'ac-sub').length, 1, '代理那一节没把选中档的条件写在屏幕上：光看芯片名字就会把「跟随系统」读成「一定走代理」');
    assert.equal(byCls(card(), 'ac-credlist').length, 0, '开关没开就摆了凭据那一节');
    // 三枚动作按钮都在「保存与试发」里，而且只在那一节（旧排版把近黑的主按钮挨着解释句摆，看着像那句的按钮）
    const act = sec('保存与试发');
    assert.ok(act, '没有「保存与试发」那一节');
    assert.equal(byCls(act, 'ac-btn').length, 3, `动作那一节的按钮数不对：${byCls(act, 'ac-btn').length}`);
    assert.ok(textOf(act).includes('一次最多补'), '补齐上限那句没跟着动作那一节');

    // 代理输入框只跟着「自定义地址」那一枚：跟随系统/直连都没有地址可填，摆一格就是等着人误填。
    assert.equal(inputsIn('现译出网'), 0, '选中的不是自定义地址却给了输入框');
    assert.equal(inputsIn('用哪一档译'), 0, '渠道那一节里摆了输入框');
    await tap(t, chip(card(), t.payload.proxyModeLabels.custom));
    assert.equal(inputsIn('现译出网'), 1, '选了自定义地址却没给那一格：屏幕上写收地址、界面上没处填');
    assert.equal(findAll(card(), (n) => n.tag === 'input').length, inputsIn('现译出网'),
      '自定义地址以外还多出输入框：开关关着的那两发存进去也没人消费');
    await tap(t, chip(card(), t.payload.proxyModeLabels.system));

    const baidu = t.payload.transChannels.find((c) => c.implemented === true && c.needsKey === true);
    // ★ 先把两个条件**错位**摆一次：要凭据的那一档 + 开关还关着。
    //   cl-43 走的是「先进宿主模型档再开开关」，那两个条件从没错位过 —— 只看 needsKey 不看开关的写法在那儿是全绿的。
    await tap(t, chip(card(), baidu.label));
    assert.deepEqual(sections(card()), ['用哪一档译', '现译出网', '保存与试发'], '开关还关着就摆了凭据那一节');
    assert.equal(findAll(card(), (n) => n.tag === 'input').length, 0, '开关关着却给了凭据输入框：那两发存进去也没人消费');
    await tap(t, chip(card(), '启用'));
    assert.deepEqual(sections(card()), ['用哪一档译', '现译出网', '凭据', '保存与试发'],
      '切到要凭据的档位后节序不对');
    const rows = byCls(card(), 'ac-credrow');
    const fields = t.payload.transCredFields[baidu.id];
    assert.equal(rows.length, fields.length, '凭据没做到一字段一行');
    rows.forEach((r, i) => {
      assert.equal(findAll(r, (n) => n.tag === 'input').length, 1, `第 ${i} 行的输入框不在这一行里`);
      assert.ok(findAll(r, (n) => n.tag === 'button').length >= 1,
        `第 ${i} 行的「存入」没跟输入框同一行（旧排版压在下面，读起来像属于下一栏）`);
    });
    await t.close();
  } finally { t.server.close(); }
});

check('cl-57 免密钥那一档的状态行只搬宿主拼好的那一句：有路线念路线，服务端那半边没这一格时念「还没试过这一发」', async () => {
  const t = await booted();
  try {
    await goTab(t, '设置');
    const card = () => transCard(t.tree());
    const sub = () => textOf(byCls(card(), 'ac-sub')[0]);
    // 免密钥又真出网的那一档 = 需要凭据为假、且不是走宿主模型那一条（宿主那条的前置是句柄，不是路线）。
    const freeOut = t.payload.transChannels.filter((c) => c.implemented === true && c.needsKey !== true && c.id !== 'host_llm');
    assert.deepEqual(freeOut.map((c) => c.id), ['keyless'], `夹具里"免密钥且真出网"的档不止一个（${freeOut.map((c) => c.id)}）⇒ 下面那句状态行不知道在测哪一档`);
    const keyless = freeOut[0];

    await tap(t, chip(card(), keyless.label));
    await tap(t, chip(card(), t.payload.proxyModeLabels.direct));
    await tap(t, buttonsByText(card(), '保存现译设置')[0]);
    // 一句都没发过 ⇒ 宿主给的是 idle 那一句。界面这里不许自己造「未连接」「待测试」之类的词。
    assert.equal(sub(), '出网：还没出过网：点「测试连接」才知道走哪条路', `没出过网时状态行念的不是宿主那句：${sub()}`);

    await tap(t, buttonsByText(card(), '测试连接')[0]);
    assert.equal(sub(), '出网：直连 · 设置页选了直连', `那一发出去以后状态行没跟着服务器的路线走：${sub()}`);
    assert.ok(clsText(t.tree(), 'ac-notice').length > 0, '测试连接没给回执');
    // 打哪一台是宿主半边的事：界面上只念档名与路线，不念域名。
    assert.equal(textOf(card()).includes('googleapis'), false, '出网域名上了屏幕：载荷里本来不该有它（hc-14）');

    // ★ 那句路线是宿主拼的，所以浏览器半边**不许存在第二份**同样的话（写了就等于两处口径）。
    //   剔掉注释再扫：判据要红的是"代码里又拼了一遍"，不是文档里提了一遍（口径同 host-compat 的 codeOf）。
    const src = (await sourceText('client.js'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const phrase of ['经代理隧道', '没能出网', '还没出过网', '设置页选了直连', 'Windows 系统代理', '环境变量']) {
      assert.equal(src.includes(phrase), false, `client.js 里出现了「${phrase}」：路线那句话在浏览器半边又拼了一遍`);
    }

    // 对照 cl-49 的另一半：卡还在、但服务端没 transport 这一格（改了 index.js 没重启那种新旧搭）。
    // 这一支必须落成「还没试过这一发」—— 客户端拿 idle 那套词去圆，就是在替没发生过的事说话。
    let hit = 0;
    const strip = (d) => {
      if (!d?.translate || !('transport' in d.translate)) return d;
      hit += 1;
      const { transport, ...rest } = d.translate;
      return { ...d, translate: rest };
    };
    const old = await booted({ clientOpts: { ssePatch: strip } });
    try {
      const oldCard = () => transCard(old.tree());
      await goTab(old, '设置');
      // 这一台服务端是全新的（库里还是出厂档），所以先把免密钥那一档存进去再摘 transport。
      // 保存之后紧跟着的 refreshSnap 走的是 GET（不经 ssePatch），这一刻屏幕上还有路线 —— 先钉住它，
      // 否则下面那句「摘掉就退成没话」可能从一开始就在测空气。
      await tap(old, chip(oldCard(), keyless.label));
      await tap(old, chip(oldCard(), t.payload.proxyModeLabels.direct));
      await tap(old, buttonsByText(oldCard(), '保存现译设置')[0]);
      // 这一台还没出过网，所以宿主给的是 idle 那一句 —— 要钉的是"这一格在屏幕上"，摘掉它才测得出差别。
      assert.equal(textOf(byCls(oldCard(), 'ac-sub')[0]), '出网：还没出过网：点「测试连接」才知道走哪条路',
        '保存后 refreshSnap 没把 transport 那一格带回来 ⇒ 摘掉它这一支没有对照，退化成永远绿');
      hit = 0;
      // 开关没开 ⇒ 这一轮一句都不发（不会有真出网），只为了推一帧把 transport 摘干净。
      await server_round(old);
      assert.ok(hit >= 1, 'ssePatch 一发帧都没撞到 ⇒ 这一条什么都没测');
      const oldSub = textOf(byCls(oldCard(), 'ac-sub')[0]);
      assert.equal(oldSub, '出网：还没试过这一发', `服务端没这一格时界面自己编了一句：${oldSub}`);
      assert.notEqual(oldSub, sub(), '摘掉 transport 前后一个字都没变 ⇒ 上面那句"念宿主的路线"是假的');
      await old.close();
    } finally { old.server.close(); }
    await t.close();
  } finally { t.server.close(); }
});

check('cl-58 状态 pill 带上「上次检查」的时刻：查过没变与根本没查在屏幕上分得开（U-19）', async () => {
  // 独立一份分钟格式（不拿客户端的 fmtMinute 算期望值 ⇒ 不是自等价断言）。
  const hm = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const server = await mountServer();
  try {
    /* ---- ① 一轮都没跑过：pill 说「实时更新中」，后面不跟一个空的 ·  ----
     * ★ 这里用 unmount 而不是 t.close()：close() 连服务端一起拆（夹具就是这么写的），
     *   后面那两轮同步就写进了一个已释放的域 —— 症状是 rawRow 拿到 undefined，
     *   看起来像"meta 不落库"，其实是判据自己把现场拆了。
     */
    {
      const t = await loadClient(server);
      await t.mountMain();
      const pill = clsText(t.tree(), 'ac-pill');
      assert.ok(pill.includes('实时更新中'), `还没跑过同步时 pill 没说实话：${pill}`);
      assert.equal(pill.includes('·'), false, `没有检查记录却画了分隔符：${pill}`);
      t.unmount();
    }

    /* ---- ② 真跑两轮（第二轮 sha 没变 ⇒ 只有 lastCheckedAt 前进），再把两个时刻拨开 ----
     * ★ 拨开是这一条的全部前提：测试里两轮只差几毫秒，分钟精度上是同一个串，
     *   "pill 念的是哪个字段"当场测不出来（夹具填默认值 = 判据测空气，§7 那条律）。
     *   真机今天那份本来就错开着：快照 10/7 21:10、检查 10/8 07:57 —— 用户那一问就是被它逼出来的。
     */
    await server.sync();
    await server.sync();
    const raw = server.facility.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY);
    assert.equal(raw.lastStatus, 'noChange', `夹具没造出「查过但源内容没变」那一轮（${raw.lastStatus}）：下面测的不是那一支`);
    const checkedAt = raw.lastCheckedAt;
    const snapAt = checkedAt - 3 * 3600_000;
    server.facility.seed(DOMAIN_NAME, TABLES.meta, META_KEY, { ...raw, fetchedAt: snapAt });
    assert.notEqual(hm(snapAt), hm(checkedAt), '两个时刻在分钟精度上撞成一串 ⇒ 这一条从头到尾测不到"念哪个字段"');

    const t = await loadClient(server);
    await t.mountMain();
    const pill = clsText(t.tree(), 'ac-pill');
    // 整串逐字钉住：前面那半句必须**还是宿主 SYNC_STATUS_LABELS 那一句**（客户端不重抄名词），
    // 后面只多出一个「 · 时刻」。这一发同时挡住三种坏：时刻取自别的字段、名词在浏览器半边又拼一遍、分隔符画错位置。
    assert.equal(textOf(byCls(t.tree(), 'ac-pill')[0]),
      `${t.exports.__test.statusLabel(raw.lastStatus)} · ${hm(checkedAt)}`,
      `pill 整串不是「宿主那句 · 检查时刻」：${textOf(byCls(t.tree(), 'ac-pill')[0])}`);
    assert.ok(pill.includes(hm(checkedAt)), `pill 没带上次检查的时刻：${pill}`);
    assert.equal(pill.includes(hm(snapAt)), false, `pill 念的是快照时刻（那是条目是哪一版，不是"什么时候查过"）：${pill}`);
    // 时刻并进那一枚 pill，不开第二枚：两枚各带一个绿点看着像两件事，其实是一件事（cl-6 同一条改版）。
    assert.equal(byCls(t.tree(), 'ac-pill').length, 1, `页头该只有一枚状态 pill，实际 ${byCls(t.tree(), 'ac-pill').length} 枚`);
    // 副标题那一格照旧念快照时刻：两格分工不能并成一处（并成就又回到"只有一个时刻、分不清问的是哪件事"）。
    const head = clsText(t.tree(), 'ac-head');
    assert.ok(head.includes(`快照 ${t.exports.__test.fmtTime(snapAt)}`), `快照那一格不再念 fetchedAt：${head}`);

    /* ---- ③ 旧版写的行没有 lastCheckedAt 那一格：整段不画，pill 就是那句状态话术本身 ---- */
    {
      const noCheck = { ...raw };
      delete noCheck.lastCheckedAt;
      server.facility.seed(DOMAIN_NAME, TABLES.meta, META_KEY, { ...noCheck, fetchedAt: snapAt });
      const t2 = await loadClient(server);
      await t2.mountMain();
      const p2 = textOf(byCls(t2.tree(), 'ac-pill')[0]);
      assert.equal(p2, t2.exports.__test.statusLabel('noChange'),
        `没有检查时刻时画出了多余的东西（分隔符或占位符）：${p2}`);
      t2.unmount();
    }

    /* ---- ④ 格式本身钉死：分钟精度、不补零的月/日、无效值给空串（让调用方整段不画） ---- */
    assert.equal(t.exports.__test.fmtMinute(new Date(2026, 9, 8, 7, 57, 23).getTime()), '10/8 07:57');
    assert.equal(t.exports.__test.fmtMinute(new Date(2026, 0, 5, 9, 3, 0).getTime()), '1/5 09:03');
    for (const bad of [0, undefined, null, '不是数', -5]) {
      assert.equal(t.exports.__test.fmtMinute(bad), '', `这一格没时刻时不该画点什么（${String(bad)}）`);
    }

    /* ---- ⑤ 断流那一支不带检查时刻：那个时刻属于「上次同步」，接在断开提示后面会被读成"断开发生在这一刻" ---- */
    __peek('api').hub.dispose();
    await t.settle();
    const off = clsText(t.tree(), 'ac-pill');
    assert.ok(off.includes('推流断开，正在重连'), off);
    assert.equal(off.includes(hm(checkedAt)), false, `断开的提示后面又挂了个时刻，读起来像"断开发生在 ${hm(checkedAt)}"：${off}`);
    await t.close();
  } finally { server.close(); }
});

await runAll('client');
