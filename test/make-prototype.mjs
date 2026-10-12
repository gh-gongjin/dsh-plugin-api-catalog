/**
 * test/make-prototype.mjs —— 出图纸：`prototype/index.html`。
 *
 * 为什么不是手搓一份静态 HTML：图纸的意义是"截图走查时看到的就是插件会画的东西"。
 * 手搓的那份改了 client.js 就没人记得同步，S5 走查会在替一个已经不存在的界面说话。
 * 这里的内容是 test/_client-harness.mjs（和 test/client.test.mjs 同一个夹具、同一条挂载路径）
 * 把 client.js 渲染出来的节点树原样序列化：样式块逐字取自 client.js 的 CSS 模板串，数据是夹具 README 的真条目。
 *
 * 用法：`node test/make-prototype.mjs`（改完 client.js 再跑一次；不要在 index.html 里手改）。
 *
 * ⚠️ 图纸记录的是**渲染结果**，不含事件处理：页签切换、展开、输入在图上是各状态各画一张，
 *    点不动。行为判据在 client.test.mjs 那边，不靠这张图说话。
 */
import fs from 'node:fs';
import {
  booted, loadClient, mountServer, goTab, server_round, tap, typeIn, pick, debounce,
  byCls, findAll, textOf, tbodyRows, purposeBox, tagInput, buttonsByText, detailOf, cardByTitle, slugOfRow, README,
  CN_README, CN_CATEGORIES, answeredIdOf, labelOf,
} from './_client-harness.mjs';
import { parseCatalog, normUrl } from '../lib/parse.js';
import { USAGE } from '../lib/usage.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** 图纸上的每个状态都得自己站得住：画歪了要当场炸，不许出一张"看着像"的图。 */
const must = (cond, msg) => { if (!cond) throw new Error(`图纸不成立：${msg}`); };
const PROP_ATTR = { htmlFor: 'for', colSpan: 'colspan', rowSpan: 'rowspan', className: 'class', tabIndex: 'tabindex', maxLength: 'maxlength', readOnly: 'readonly' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function serialize(n, depth) {
  const pad = '  '.repeat(depth);
  if (n.tag === '#text') return `${pad}${esc(n.text)}`;
  const attrs = [];
  for (const [k, v] of Object.entries(n.props)) {
    if (v === undefined || v === null || v === false || typeof v === 'function') continue;
    if (k === 'key' || k === 'children') continue;
    if (k === 'value' && (n.tag === 'input' || n.tag === 'textarea')) continue;
    if (k === 'defaultValue') continue;
    if (k === 'style') {
      attrs.push(`style="${esc(Object.entries(v).map(([p, q]) => `${p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${q}`).join(';'))}"`);
      continue;
    }
    const a = PROP_ATTR[k] || k.replace(/^data-?/i, (m) => m.toLowerCase()).replace(/([A-Z])/g, '-$1').toLowerCase();
    attrs.push(v === true ? a : `${a}="${esc(v)}"`);
  }
  const val = n.props.value;
  if (n.tag === 'input' && val !== undefined) attrs.push(`value="${esc(val)}"`);
  const open = `<${n.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  // textarea 的初值只能是标签内正文：必须一行写完 —— 缩进和换行都会变成用户看到的值（图纸上曾多出 28 个空格）。
  if (n.tag === 'textarea') return `${pad}${open}${esc(val ?? '')}</${n.tag}>`;
  const kids = n.children.map((c) => serialize(c, depth + 1)).filter(Boolean);
  if (VOID.has(n.tag)) return `${pad}${open}`;
  if (!kids.length) return `${pad}${open}</${n.tag}>`;
  return `${pad}${open}\n${kids.join('\n')}\n${pad}</${n.tag}>`;
}

const section = (node) => serialize(node, 2).trimStart();

/* ------------------------------------------------------------------ *
 * 状态脚本：一个宿主跑到底，让台账/笔记/流水自然累积（这样四张图说的是同一份库）
 * ------------------------------------------------------------------ */

function clientSource() {
  return fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
}

/** CSS 模板串逐字搬过来（图纸与插件同源；test/client.test.mjs 的 cl-37 钉着插件那一侧的类名对齐）。 */
function cssBlock() {
  const src = clientSource();
  const at = src.indexOf('const CSS = `');
  const end = src.indexOf('`;', at);
  if (at < 0 || end < 0) throw new Error('client.js 的 CSS 模板串锚点没找到');
  return src.slice(at + 'const CSS = `'.length, end).trim();
}

const shots = [];
const cap = (title, note, tree) => shots.push({ title, note, html: section(tree) });

/* 1) 首屏空库：一个条目都没有时说什么 */
{
  const server = await mountServer();
  const t = await loadClient(server);
  await t.mountMain();
  cap('还没跑过第一轮', '库里零条目：副标题说「库里还没有条目」，空态把下一步指出来（这不是「搜索无结果」）', t.tree());
  await t.close();
  server.close();
}

/* 2~7) 有库的状态 */
{
  const t = await booted();
  const nameOf = (r) => textOf(byCls(r, 'ac-nm')[0]);
  const rows = tbodyRows(t.tree());
  const firstName = nameOf(rows[0]);

  /* ① 给第一行写一条正常批注（带中文逗号分隔的标签） */
  await tap(t, rows[0]);
  const keptUrl = byCls(detailOf(t.tree()), 'ac-url')[0].props.href;
  await typeIn(t, purposeBox(t.tree()), '做过两版抓取脚本，字段稳定，免 key；限流没写在页面上。');
  await typeIn(t, tagInput(t.tree()), '备用，已验证');
  await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
  await debounce(t);

  /* ② 第二行也写一条 —— 这一行稍后被上游删掉 ⇒ 笔记页同时有一个正常批注和一个 orphan */
  await tap(t, tbodyRows(t.tree())[1]);
  const doomedName = nameOf(tbodyRows(t.tree())[1]);
  const doomedUrl = byCls(detailOf(t.tree()), 'ac-url')[0].props.href;
  await typeIn(t, purposeBox(t.tree()), '上游把这一行删了，批注还留着（个人层不跟着上游删）。');
  await tap(t, buttonsByText(detailOf(t.tree()), '保存批注', 'ac-btn-primary')[0]);
  await debounce(t);

  /* ③ 上游动两处：删掉 ② 那一行 + 改 ① 那一行的字段列 ⇒ 流水里要有三类 kind（明细两类 + 本轮摘要一类） */
  {
    const lines = t.server.state.body.split('\n');
    const at = lines.findIndex((l) => l.includes(keptUrl));
    must(at >= 0, `夹具里找不到「${firstName}」那一行`);
    // 上游这一列有时带反引号、有时是裸文本（这一份夹具里 Axolotl 那行就是裸的）：先改反引号那一列，改不动再改裸的那一列
    const editers = [
      (s) => s.replace(/`([^`]*)`/, (m, g) => (g === 'apiKey' ? '`No`' : '`apiKey`')),
      (s) => s.replace(/\|\s*(No|Yes|OAuth|apiKey)\s*\|/, (m, g) => (g === 'apiKey' ? '| No |' : '| apiKey |')),
    ];
    let edited = lines[at];
    for (const f of editers) {
      const out = f(edited);
      if (out !== edited) { edited = out; break; }
    }
    must(edited !== lines[at], `「${firstName}」那一行没有可改的字段列`);
    lines[at] = edited;
    t.server.state.body = lines.filter((l) => !l.includes(doomedUrl)).join('\n');
  }

  await goTab(t, '变更');
  await server_round(t);
  await debounce(t);   // 后台那一轮会让目录重查一次（防抖 250 ms 是假定时器，得点名放）
  const tl = findAll(t.tree(), (n) => n.tag === 'li');
  const kinds = [...new Set(tl.map((n) => n.props['data-kind']))];
  must(kinds.length >= 2, `流水只有 ${kinds} 一类，图上看不出 kinds 的话术各不一样`);
  // ★ U-17：图纸自己也要钉这个前提 —— 出图走的是真装配、会走的钟，摘要行排不到第一就是真机上的样子。
  must(tl[0].props['data-kind'] === 'round', `图纸这一轮第一行不是本轮摘要：${kinds}`);
  // ★ 2026-10-06 用户裁定：这一页只摆变更记录列表（那张「解析台账」卡从界面上撤了）。
  //   图纸这一发跟着钉住：多于一张卡、或台账又回到屏幕上，都是图纸与实现不同源。
  must(byCls(t.tree(), 'ac-card').length === 1, `变更页摆了 ${byCls(t.tree(), 'ac-card').length} 张卡，那一页只许列表那一张`);
  must(!textOf(t.tree()).includes('解析台账'), '「解析台账」又回到界面上了');
  cap('变更 · 变更记录',
    `上游删了「${doomedName}」、改了「${firstName}」的字段列 ⇒ 记录里是 ${kinds.join(' + ')} 共 ${kinds.length} 类，第一行是整轮的摘要；这一页只有种类芯片和列表`, t.tree());

  await goTab(t, '我的笔记');
  const noteRows = tbodyRows(t.tree());
  must(noteRows.length === 2 && noteRows.some((r) => textOf(r).includes('上游已删')),
    `笔记页要同时有一条正常批注和一条 orphan，实际 ${noteRows.length} 行`);
  cap('我的笔记', '一条正常批注 + 一条「上游已删」（orphan 不跟着上游删，裁定 ③）；视图芯片四个，各自问服务端', t.tree());

  /* 常用API（2026-10-07 两道裁定：先「只做壳」，再「这些废话去掉行不行」⇒ 只剩读数）：图纸上要能看出这一页既没有名次也没有列表 */
  await goTab(t, '常用API');
  must(byCls(t.tree(), 'ac-li').length === 0, '这一页画出了条目行：还没有排序依据');
  must(byCls(t.tree(), 'ac-card').length === 1, '这一页又长出第二张卡：解释「为什么没有名次」的那一张已判撤');
  must(findAll(byCls(t.tree(), 'ac-panel')[0], (n) => n.tag === 'button').length === 0,
    '这一页画出了按钮：那两档条目本来就在目录页「快捷」那一行里');
  cap('常用API（壳）',
    '只剩读数：卡头念全库的条数与分类数，下面两档预设各一行（名字 + 条数 + 条件三段同行）。'
    + '为什么这一页不排名次、界面上为什么不解释 —— 撤掉的那三句话与代价记在 docs §9.1q，屏上没有。', t.tree());

  await goTab(t, '设置');
  cap('设置', '节拍与抓取源改的是草稿，落库靠那一发 POST /prefs；「中文说明」那一卡另有一份草稿与另一枚保存按钮（两半各存各的）', t.tree());

  /* ④ 「中文说明」卡：把开关打开、切到要凭据的那一档（只动草稿，一发都不写库） */
  {
    const card = () => cardByTitle(t.tree(), '中文说明');
    must(card(), '设置页没画出「中文说明」那一卡');
    const chipOf = (label) => findAll(card(), (n) => n.tag === 'button' && textOf(n) === label)[0];
    must(chipOf('启用'), '开关那两枚芯片里找不到「启用」');
    await tap(t, chipOf('启用'));
    const needKey = t.payload.transChannels.find((c) => c.implemented === true && c.needsKey === true);
    must(needKey, '载荷里没有「已接入且要凭据」的档位');
    await tap(t, chipOf(needKey.label));
    must(findAll(card(), (n) => n.tag === 'input').length === t.payload.transCredFields[needKey.id].length,
      '切到要凭据的那一档后输入框数量与字段规格对不上');
    cap('设置 · 中文说明（草稿态）',
      '开关一开并选到要凭据的那一档才露出输入框：值永不回显（库里那份浏览器拿不到），界面上只有「已配置 · N 位」或上限提示；'
      + '未接入的渠道列着但点不动，原因写在悬停里。状态行念的是库里那一档，不是这份草稿。', t.tree());
  }

  /* ⑤ 目录：留一行点开着 —— 详情对话框、行内中文、派生句、批注编辑器都要在图上 */
  await goTab(t, '目录');
  const target = tbodyRows(t.tree()).find((r) => nameOf(r) === firstName);
  must(target, `回到目录没找到「${firstName}」那一行`);
  await tap(t, target);
  must(purposeBox(t.tree()) && purposeBox(t.tree()).props.value.includes('做过两版抓取脚本'),
    '展开的那一行没把已存的批注带回来');
  const dcell = byCls(detailOf(t.tree()), 'ac-desc')[0];
  must(/[\u4e00-\u9fff]/.test(textOf(dcell)), '对话框里那句用途没有汉字 ⇒ 中文那一层没接到弹框上');
  must(String(dcell.props.title || '').includes('上游原文'), 'title 里没带上游原句：用户核对不了这句中文对应哪句英文');
  must(!byCls(detailOf(t.tree()), 'ac-sec-t').map(textOf).includes('怎么用'),
    '⑤ 这一条按设计**没有**用法层（这张图记录的就是"整节不摆"那一支）⇒ 换条目要另画一张，别放宽这一发');
  cap('目录 · 点开一行', '详情在对话框里（2026-10-06 改判，原来是就地长在行下面）：中文用途（悬停/ title 里是上游原句）、出处落款、派生句、批注编辑器同一格，遮罩盖住页面、框内自己滚', t.tree());

  /* ⑥ 整页：关掉详情，画一张干净的表 */
  await tap(t, buttonsByText(detailOf(t.tree()), '关闭', 'ac-link')[0]);
  await t.settle();
  must(!detailOf(t.tree()), '「关闭」没把详情对话框收掉');
  cap('目录 · 整页', `页头副标题是快照那份：${textOf(byCls(t.tree(), 'ac-sub')[0])}`
    + `（② 那一行被上游删了，所以比夹具基线少一条。这一张是**降级源**那一份的形状：夹具喂的是英文正文，`
    + 'CN 两档在假 fetch 里就不通 ⇒ 页头念的源名跟着真跑到的那一档走）', t.tree());

  /* ⑦ 抓到规范的那一条：弹框里多出「怎么用」那一节（地址 / 鉴权 / 操作 / 出处），图上要有 */
  {
    const searchable = (x) => /^[A-Za-z][A-Za-z0-9._-]{2,30}$/.test(x.name);
    const hit = parseCatalog(README).entries
      .map((e) => ({ name: e.name, url: e.url, usage: USAGE[normUrl(e.url)] }))
      .find((x) => x.usage && searchable(x) && x.usage.servers.length > 0 && x.usage.operations.length >= 2);
    must(hit, '夹具里没有「名字搜得到 + 有 base 地址 + ≥2 个操作」的已抓条目 ⇒「怎么用」画不全：先看抓取覆盖，别放宽这一发');
    await typeIn(t, byCls(t.tree(), 'ac-q')[0], hit.name);
    await debounce(t);
    const srv = await t.ask(`?q=${encodeURIComponent(hit.name)}`);
    const same = srv.rows.filter((r) => r.name === hit.name && r.url === hit.url);
    must(same.length === 1, `搜「${hit.name}」回到 ${same.length} 行同名同址的：这张图说不清点开的是哪一条`);
    const row = tbodyRows(t.tree()).find((r) => slugOfRow(r) === same[0].slug);
    must(row, `列表里没有 slug=${same[0].slug} 那一行`);
    await tap(t, row);
    const d = detailOf(t.tree());
    must(d, '点了那一行却没有详情对话框');
    const sec = byCls(d, 'ac-sec-t').map(textOf);
    must(sec.join('|') === '这是什么|怎么用|现在的限制|我的批注', `分节不对：${sec.join(' | ')}`);
    const mono = byCls(d, 'ac-mono').map(textOf);
    must(hit.usage.servers.every((s) => mono.includes(s)), '「地址」那一格没把 servers 逐条摆出来');
    must(byCls(d, 'ac-op').length === hit.usage.operations.length, '操作那一节的行数与表里的条数对不上');
    cap('目录 · 用法层（抓到规范的那一条）',
      `「怎么用」那一节全部念内置表里那一份（${hit.usage.kind} · 抓取日 ${hit.usage.at}）：base ${hit.usage.servers.length} 条、`
      + `列出的操作 ${hit.usage.operations.length} 个（规范里共 ${hit.usage.pathCount} 个 ⇒ 截断那句的两个数字也念载荷）、出处带规范地址。`
      + '没抓到规范的那条（上一张）整节不摆 —— 两种形态各一张，别看漏了占多数的那一种。', t.tree());
    await tap(t, buttonsByText(d, '关闭', 'ac-link')[0]);
    await t.settle();
    must(!detailOf(t.tree()), '⑦ 那张画完没把对话框关掉');
  }

  await t.close();
  t.server.close();
}

/* 8) 现用源（CN）那一档的整页与弹框：分类名与用途本来就是中文 ⇒ 没有「上游原文」可挂，也不许编一句 */
{
  const t = await booted({ body: CN_README });
  const rail = byCls(t.tree(), 'ac-rail-i');
  must(rail.length === CN_CATEGORIES + 1, `CN 载荷的分类栏是 ${rail.length - 1} 类，夹具读数是 ${CN_CATEGORIES} 类`);
  must(labelOf(answeredIdOf(CN_README)).includes('public-apis-cn'), '页头念的源名不是现用源那一档');
  must(rail.every((n) => !String(n.props.title || '').includes('上游原文')), 'CN 分类栏上还挂着「上游原文」');
  cap('目录 · 现用源（CN）',
    `页头副标题：${textOf(byCls(t.tree(), 'ac-sub')[0])}。这一档上分类名与用途**本来就是上游写的中文** ⇒`
    + '没有「上游原文」的悬停、也没有预译落款（判据 cl-11c）；上面那张「目录 · 整页」是降级源（英文）那一份的形状，两张都得在。',
    t.tree());

  const rows = tbodyRows(t.tree());
  const at = rows.findIndex((r) => /[\u4e00-\u9fff]/.test(textOf(byCls(r, 'ac-desc')[0])));
  must(at >= 0, 'CN 载荷第一页一行自带中文的用途都没有 ⇒ 这张图说的不是现用源那一份');
  await tap(t, rows[at]);
  const d = detailOf(t.tree());
  must(d, '点了自带中文的那一行却没开详情对话框');
  const faints = byCls(d, 'ac-faint').map(textOf);
  must(!faints.some((x) => x.includes('中文说明来自')), '源里自己写的中文被挂了「中文说明来自」= 冒充我们给的翻译');
  cap('目录 · 现用源：点开一行',
    '弹框里那句中文用途**不带**出处落款（那句只在内置表或现译真补了中文时才出现）；分节与降级源那张一致。', t.tree());
  await t.close();
  t.server.close();
}

const HTML = `<!DOCTYPE html>
<!-- 由 test/make-prototype.mjs 生成，勿手改：`+ '改完 `client.js` 跑 `node test/make-prototype.mjs` 重出。' + `
     数据来自 test/fixtures/public-apis-README.md（真上游 README），不是编的。 -->
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>免费 API 目录 · dsh 插件图纸</title>
<style>
/* 页面外壳：照抄宿主的骨架，不是"随便给个框"。
   ★ 2026-10-06：这一层以前是 auto 高的虚线框 ⇒ 插件根的 height:100% 在图纸上**没有参照**，
     于是"内容被格子裁掉、且没有一层能滚"这类 bug 在图纸上永远照不出来（用户截图报的就是这个）。
     现在按运行中的 app.asar 抽到的三条实测搭：格子定高 + display:flex;flex-direction:column;overflow:hidden
     （.BynINW_centerCol），槽位那层 div[data-slot=main] 是 display:contents（ANCHOR_STYLE），
     所以插件根是格子的直接 flex item。格子高度用 --cell-h 给，探针按视口逐档覆盖。 */
*{box-sizing:border-box}
body{margin:0;background:#f4f4f6;color:#1a1a1a;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.proto{max-width:1360px;margin:0 auto;padding:24px 20px 60px;display:flex;flex-direction:column;gap:26px}
.proto-h{font-size:15px;font-weight:600}
.proto-sub{font-size:12px;color:#6b6b70;line-height:1.6}
.shot{border:1px dashed #c9c9d1;border-radius:14px;padding:0 10px 10px;background:#fff}
.shot>.cap{font-size:12px;color:#6b6b70;padding:8px 10px 0;line-height:1.6}
.shot>.cap b{color:#1a1a1a}
.hostcell{--cell-h:800px;height:var(--cell-h);box-sizing:border-box;display:flex;flex-direction:column;min-width:0;
  overflow:hidden;border:1px solid #dcdce2;border-radius:10px;background:#fff}
.slotmain{display:contents}
/* ===== 以下整块逐字来自 client.js 的 CSS 模板串（同一份真相） ===== */
${cssBlock()}
</style>
</head>
<body>
<div class="proto">
  <div>
    <div class="proto-h">免费 API 目录 · 界面图纸</div>
    <div class="proto-sub">五个页签（目录 / 常用API / 变更 / 我的笔记 / 设置）、批注就地编辑、浮层只有详情对话框一处（点一行才出现）。
      每一块下面那段 HTML 是 client.js 在沙箱宿主里渲染出来的节点树原样序列化 —— 点不动，只是状态记录。</div>
  </div>
${shots.map((s) => `  <section class="shot">
    <div class="cap"><b>${esc(s.title)}</b> · ${esc(s.note)}</div>
    <div class="hostcell"><div class="slotmain">
${s.html}
    </div></div>
  </section>`).join('\n')}
</div>
</body>
</html>
`;

const out = new URL('../prototype/index.html', import.meta.url);
fs.mkdirSync(new URL('../prototype', import.meta.url), { recursive: true });
fs.writeFileSync(out, HTML);
console.log(`prototype/index.html 已出：${shots.length} 个状态，${HTML.split('\n').length} 行`);
