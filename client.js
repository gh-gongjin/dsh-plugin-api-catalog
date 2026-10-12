// ============================================================
// dsh-plugin-api-catalog — Browser Client Half（浏览器半边）
// ============================================================
// 1) sidebar.panellist 注册图标按钮  2) main keyed slot 注册整页 UI。
// 数据通路：SSE 主（首帧 snapshot，update 帧 = 与 GET /api/snapshot 同形的整份快照）、
//   筛选与搜索走 GET /api/search、手动同步走 POST /api/sync。**不用 EventSource**（继承 sysops 口径）。
//
// 一份真相：本文件不定义任何枚举、判定口径或文案 —— authLabels / httpsLabels / corsLabels /
//   presets / checkIntervals / intervalLabels / sources / changeKindLabels / syncStatusLabels /
//   各上限值全部来自宿主 index-inject 载荷；派生句（derivePurpose 那三句）来自服务端结果行。
//   载荷没到 = apply 一个入口都不注册（没有路由的面板点开全是 404，比看不到入口更糟），所以界面里不养一份自己的文案。
//
// 浮层只有一处，且必须由点击换来（2026-10-06 改判）：点一行 → 详情对话框（.ac-modal-mask + .ac-modal）。
//   错误与回执仍然就地落条（.ac-notice）：没有 toast、没有自动弹出的东西、没有第二处层叠。
//
// 页签：目录 / 常用API / 变更 / 我的笔记 / 设置。页签白名单只有一份（TAB_DEFS）：
//   渲染按钮用它，goTab 校验也用它 —— 别再在第二处写一遍 id 列表。
//   「常用API」这一页只有几格读数（2026-10-07 两道裁定：①「先只做壳，频率数据的来源待指定」② 看真机截图「这些废话去掉行不行」）：
//   社区使用频率两处都拿不到（上游 README 只有 API/用途/鉴权/HTTPS/CORS 五列，CN 源那几档连 CORS 列都没有；本插件运行时一个请求都不发），
//   所以这一页不排名次、页签上也不挂条数 —— 挂上去就是把"筛出来的子集"说成"大家常用的"。
//   ★ 第二道裁定把"为什么没有名次"那三句解释也从屏上撤了：界面上不解释自己，代价与出处记在 CommonTab 的注释与 §9.1q。
//
// ⛔ CSS 模板串里注释与选择器都不许出现反引号（会当场截断字符串）。
// ⛔ 不用 container-type + @container（modelwatch 真机炸过：宿主主区是 flex，containment 之后算出 0 宽）。
// ⛔ 不写 100vh，也⛔ 不指望宿主那一格会滚：宿主主列 `.BynINW_centerCol` 是 `display:flex;overflow:hidden`
//   （2026-10-06 从正在跑的 app.asar 里抽的原文，见下面 `.ac-root` 那段三条实测）。
// ★ 滚动层口径 v3（2026-10-06 第二次真机驳回）：**根不滚**。根 `height:100%` + `overflow:hidden`，
//   页头 / 页签 / 同步回执 / 搜索框 / 筛选条 / 分类栏全部常驻，滚的只有内容：
//   目录页签宽栏 = 结果列表 .ac-list，其余页签 = .ac-panel 整块，窄栏（<960px）= .ac-cat 整块。
//   细则与"为什么是这四发"见 cl-39；改任何一条前先读它。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-api-catalog',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const GLOBAL_KEY = '__API_CATALOG__';
    const cfg = () => globalThis[GLOBAL_KEY] || {};
    const PANEL_ID = cfg().panelId || 'api-catalog';
    const PANEL_ORDER = () => Number(cfg().panelOrder) || 17;
    const API_BASE = () => cfg().api || '/api-catalog/api';

    // ------------------------------------------------------------
    // 1) 样式：宿主 token 优先，原型值兜底
    // ------------------------------------------------------------
    // ★ 根必须自带 box-sizing:border-box：宿主 web 端 CSS 没有通配 box-sizing，
    //   根是 content-box 时width:100% + 左右padding ⇒ 外框比面板宽 ⇒ 右半边被顶出可视区。
    // ★ 2026-10-05 版式改版：结果区从六列表格改成列表行（左栏加宽、facet 收成一条、页头收敛两行）。
    //   列表行的好处是**不用横向滚动**：用途能折行读全、窄面板（~430px）也不裁列。
    const STYLE_ID = 'dsh-plugin-api-catalog:style';
    const CSS = `
.ac-root{--ac-fg:var(--dsw-alias-label-primary,#1a1a1a);--ac-muted:var(--dsw-alias-label-secondary,#6b6b70);
  --ac-faint:var(--dsw-alias-label-tertiary,#a0a0a6);
  --ac-card:var(--dsw-alias-bg-base,#ffffff);--ac-soft:var(--dsw-alias-bg-layer-2,#fafafb);
  --ac-hover:var(--dsw-alias-bg-layer-3,#f0f0f1);
  --ac-line:var(--dsw-alias-border-l1,#ebebed);--ac-line2:var(--dsw-alias-border-l2,#e0e0e3);
  --ac-ok:#1f883d;--ac-err:#c0392b;--ac-warn:#9a6700;--ac-info:var(--dsw-alias-state-business-primary,#3d6fe0);
  box-sizing:border-box;color:var(--ac-fg);background:transparent;padding:16px 20px 28px;
  width:100%;max-width:1320px;margin:0 auto;
  /* ★★★ 2026-10-06 根**接住格子的高度，但自己不滚**。两条口径是同一轮里前后脚定下来的：
     ① 根必须有高度。此前一整版把它当成"宿主主列会滚"，于是根只写宽不写高，长到内容那么高
        ⇒ 超出格子底边的部分被 overflow:hidden 直接裁掉，且**没有任何一层能滚**
        （用户截图：结果列表在「HTTP Cat」那行断掉，下面 24 条滚不到）。宿主骨架的三条实测（从**正在跑的**
        app.asar 里抽，不是猜的）：
          a. .BynINW_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden} —— 格子定高、自己不滚；
          b. 格子的父级 .BynINW_frame 是 grid + grid-template-rows:minmax(0,1fr)，Windows 那支还带
             padding-top:var(--dsh-windows-titlebar-height) ⇒ 按视口高度取根高必然多出一条标题栏（照旧禁，见文件头与 cl-36）；
          c. 槽位那层 div[data-slot=main] 是 style={display:"contents"}（ANCHOR_STYLE），
             宿主注释原话"keeps the wrapper out of layout (grid/flex parents see the slot's own children)"
             ⇒ 根**就是** centerCol 的直接 flex item，height:100% 有参照、能算出定高。
     ② 但根不滚。同一轮的真机截图驳回了"根整块滚"：根一滚，搜索框和筛选条就跟着结果一起滚走了
        （用户原话"这个框不要滚动，只滚动下面这个框"）。所以根只做一件事：**把格子的高度接住**，
        然后交给内容区去滚 —— 滚动层见文件头 v3 那张分配表，判据在 cl-39。
     overflow:hidden 不是"裁了就完事"：它同时让根的自动最小尺寸归 0（规范：成了可能的滚动容器），
     于是根不会被自己的内容顶出格子。配方与外观插件 .ap-root 同源（它抄的是官方入口页那一条）。 */
  height:100%;overflow:hidden;
  display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5}
.ac-root *{box-sizing:border-box}
/* ★ 直接子项一律 flex:none：根成了 column flex 后，没钉死的子项会被"压缩以适配容器"，
   而这里要的恰恰是"顶栏按内容长、内容区吃掉剩下那一截"。modelwatch 真机抓到过这一族的反面：页签条被压成 1px 的 border-bottom。 */
.ac-root>*{flex:none}
/* 页签内容区 = 根剩下的那一整截。min-height:0 是这条链的第一环：没有它，flex item 的自动最小尺寸
   按内容算 ⇒ 下面 .ac-list 的 overflow 永远不生效，滚轮落在一个被顶出格子的容器上（= 回到 ① 之前那个 bug）。 */
.ac-root>.ac-cat,.ac-root>.ac-panel{flex:1 1 auto;min-height:0}
.ac-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
.ac-sub{color:var(--ac-muted);font-size:12px}
.ac-faint{color:var(--ac-faint);font-size:11px}
.ac-card{background:var(--ac-card);border:1px solid var(--ac-line);border-radius:12px;overflow:hidden;min-width:0}
.ac-card-h{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--ac-soft);border-bottom:1px solid var(--ac-line);flex-wrap:wrap}
.ac-card-t{font-weight:600;font-size:13px;white-space:nowrap}
.ac-card-n{margin-left:auto;color:var(--ac-muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ac-card-b{padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.ac-note{margin:0;padding:8px 14px 10px;border-top:1px solid var(--ac-line);color:var(--ac-faint);font-size:11px;overflow-wrap:anywhere}
.ac-panel{display:flex;flex-direction:column;gap:12px;min-width:0;
  overflow-y:auto;overscroll-behavior:contain}
/* ★ .ac-panel 成了滚动容器，它的直接子项就必须一律 flex:none：卡片自带 overflow:hidden（圆角裁切用），
   按规范它的自动最小尺寸算 0 ⇒ 不钉住就会被"压进容器"，卡里的流水/表单被裁掉而面板以为不用滚。
   探针 2026-10-06 抓到过这一发（变更页两张卡 208>184、396>350），和 modelwatch 那条 1px 页签条同一族。 */
.ac-panel>*{flex:none}
.ac-notice{padding:7px 10px;border-radius:8px;border:1px solid var(--ac-line);border-left:3px solid var(--ac-warn);
  background:var(--ac-soft);color:var(--ac-muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.ac-notice-err{border-left-color:var(--ac-err)}
.ac-notice-ok{border-left-color:var(--ac-ok)}
/* 顶栏（页头 + 页签）常驻：目录页签一屏就是几百行，滚起来就得一直够得到切签的地方。
   ★ 2026-10-06 v3：这里**不再用 sticky**。上一版整块由根来滚，sticky 是让顶栏贴住滚动视口；
   现在根不滚、滚的是下面的内容区 ⇒ 顶栏被 flex 布局本身钉在格子上界，任何东西都不会从它底下穿过去，
   于是 sticky 与 z-index 都成了死规则（"文本在、效果死"正是这一族最坏的形状）。判据：cl-36 反过来钉"CSS 里不许有 z-index"。 */
.ac-topbar{background:var(--ac-card);flex:none;
  display:flex;flex-direction:column;gap:10px;min-width:0;padding-bottom:2px}
/* ★ flex:none 不是可有可无：根是 column flex，页签条一旦成为滚动容器，自动最小尺寸按规范算 0，
   整条会被压成 1px 的 border-bottom（modelwatch 真机截图抓到）。 */
.ac-tabs{display:flex;gap:2px;border-bottom:1px solid var(--ac-line);overflow-x:auto;flex:none}
.ac-tab{position:relative;display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;
  font-family:inherit;font-size:13px;color:var(--ac-muted);padding:8px 12px;cursor:pointer;
  border-radius:8px 8px 0 0;white-space:nowrap}
.ac-tab:hover{color:var(--ac-fg);background:var(--ac-soft)}
.ac-tab.on{color:var(--ac-fg);font-weight:600}
.ac-tab.on:after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:2px;
  background:var(--ac-fg);border-radius:2px}
.ac-tab-n{font-size:11px;color:var(--ac-faint);font-variant-numeric:tabular-nums}
.ac-tab.on .ac-tab-n{color:var(--ac-muted)}
.ac-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
  border:1px solid var(--ac-line);background:var(--ac-soft);font-size:12px;color:var(--ac-muted);white-space:nowrap}
.ac-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:var(--ac-faint)}
.ac-dot-ok{background:var(--ac-ok)}
.ac-dot-err{background:var(--ac-err)}
.ac-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;cursor:pointer;
  font-family:inherit;font-size:12px;border:1px solid var(--ac-line2);background:var(--ac-card);color:var(--ac-fg)}
.ac-btn:hover{background:var(--ac-hover)}
.ac-btn[disabled]{opacity:.55;cursor:default}
.ac-btn-primary{background:var(--ac-fg);color:var(--ac-card);border-color:var(--ac-fg);font-weight:600}
.ac-link{border:none;background:transparent;color:var(--ac-info);font-family:inherit;font-size:12px;
  cursor:pointer;padding:0;white-space:nowrap;text-align:left}
.ac-link:hover{text-decoration:underline}
/* ---------- 页头：标题与状态分两行，不再挤成一条 ---------- */
.ac-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
.ac-head-l{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 320px}
.ac-head-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
/* 标题行：标题 + 状态 pill 同行（它们回答的是"现在什么状态"），副标题独占第二行 */
.ac-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.ac-title{font-size:16px;font-weight:600;letter-spacing:.2px;white-space:nowrap}
.ac-capsline{display:flex;flex-wrap:wrap;gap:6px}
.ac-capsline .ac-pill{font-size:11px;padding:2px 8px}
/* ---------- 目录页签：左分类栏 + 右结果 ---------- */
/* ★ 2026-10-06 v3：窄栏（<960px）两栏塌成一列，"搜索/筛选常驻 + 列表单独滚"在一列里放不下
   （列表上面已经堆了整条分类栏）⇒ 这一档由 .ac-cat 整块滚。宽栏下这条 overflow 被下面
   min-width:960px 段里的 hidden 关掉，滚的换成结果列表 .ac-list。两档各只有一发，永不嵌套。 */
.ac-cat{display:flex;flex-direction:column;gap:12px;min-width:0;overflow-y:auto;overscroll-behavior:contain}
/* 断点从 1080 降到 960：窄面板（~430~500px 评审窗口）下两栏会把右栏压到读不了字。 */
@media (min-width:960px){.ac-cat{flex-direction:row;align-items:stretch;overflow:hidden}
  /* ★ align-items 从 flex-start 改成 stretch：这一档左栏要跟格子一样高，栏内才量得出"还剩多少"。
     第三代踩过 stretch（那时 .ac-cat 的高度是内容顶出来的 5911px ⇒ stretch 等于没界）；
     现在 .ac-cat 的高度由根 + min-height:0 钉成格子的剩余高度，stretch 才有意义。 */
  .ac-rail{flex:0 0 256px;min-height:0}.ac-main{flex:1 1 auto;min-width:0;min-height:0}}
/* ★ 208→232→256：截图里「认证与…」「云存储与…」「文档与生…」全被切掉。
   232 是在**单列**下量的；改网格后每格只有 128px 宽，256 是"两格 + 间隙 + 内边距"的下限。 */
.ac-rail{display:flex;flex-direction:column;gap:6px;min-width:0;width:100%}
.ac-rail-h{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ac-muted);flex:0 0 auto}
/* ★★★ 2026-10-05 分类栏：**两列网格**（前四代全是"纵向一列"的变体，量出来都不成立）。

   为什么不是纵向一列 + 各种滚动：51 类 × 26px = **1403px**，而一屏（视口 900 − 顶栏 93）
   只有 807px。**装不下就是装不下**，四种绕法各量一遍：
   | 绕法 | 量出来 | 为什么不行 |
   | --- | --- | --- |
   | 一max-height:520px + 内层滚 | 只露 520px，**883px 被藏** | 截图上完全看不出有东西被藏 ⇒ 用户说"这个框无法滚动" |
   | 二 撤内层滚 + position:sticky | 贴住顶栏，**一屏只有 25/52 个分类** | sticky 只让它跟着滚，剩下 27 类仍然点不到 |
   | 三 align-items:stretch 让左栏等高 | 左栏 5911px ⇒ 内层**永不出**滚动条 | 内容又够不到（回归） |
   | 四 sticky + stretch 合用 | sticky **完全失效**，top 从 262 一路到 -5169 | ★ sticky 要求元素比滚动容器**矮**；5911px 的盒子无处可吸 |
   ⇒ 第四代那句"sticky 与等高物理互斥"是这四代真正的结论，不是写法问题。
   ⇒ 而"用户要在这一屏里点完 51 个分类"这个需求本身，**靠纵向一列怎么排都做不到**。

   换思路：**两列网格**。51 项 ÷ 2 = 26 行 × 26px = **676px < 807px** ⇒ 一屏装得下、零滚动、零 sticky、
   左栏下方也不再有那一大块空白（用户说的第二个问题一并解决）。
   （2026-10-07 换 CN 源后是 54 项 ÷ 2 = 27 行 × 26px = 702px < 807px，同一道算术，结论没变。）
   网格只换排布，不改筛选语义：每格仍是一个 .ac-rail-i，点它仍只筛这一类。
   ★ 窄面板（<960px）不铺网格：那本来就是两栏塌成一列、横向空间就是整幅，
     铺两列会把中文标签压到截断（"反垃圾软件" 4 个字 + 计数 = 至少 90px 一格）。
   ★ 2026-10-06 v3：sticky 撤了。上一版整块由根来滚，sticky 解决的是"滚到结果区深处时分类还在手边"；
     现在根不滚、分类栏常驻，而栏内那一发 overflow-y:auto 只在**格子矮到装不下 52 项**时才出滚动条
     （当前真机窗口装得下 ⇒ 看不见这条规则）。它和 .ac-list 是兄弟，不是嵌套。 */
/* ⚠ 顺序是判据的一部分：下面这条 display:flex 是**基线**（单栏/窄面板用），
   两栏的网格规则必须排在它**之后** —— 同特异度时后者胜。
   第一版把网格写在前面、被这条静默覆盖，量出来列表仍1299px（一列的高度），白改一轮。 */
.ac-rail-list{display:flex;flex-direction:column;gap:1px}
@media (min-width:960px){
  .ac-rail-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px 4px;
    flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  /* 「全部分类」跨满整行：它是"取消筛选"不是第 52 个分类，挤在第一格会留一个空格。
     ★ 用 grid-column:1/-1 而不是给它 flex:100% —— 这是 grid 容器，不是 flex。 */
  .ac-rail-list .ac-rail-all{grid-column:1/-1}
}
/* ★ 分类行：中文标签独占一行、英文原文降级到 title 悬停 ——
   悬停拿得到 ≠ 冒充上游写了中文，也不占常驻宽度。 */
.ac-rail-i{display:flex;align-items:baseline;gap:6px;padding:4px 8px;border-radius:7px;cursor:pointer;
  border:none;background:transparent;font-family:inherit;font-size:12px;color:var(--ac-fg);text-align:left;min-width:0}
.ac-rail-i:hover{background:var(--ac-hover)}
.ac-rail-i.on{background:var(--ac-fg);color:var(--ac-card);font-weight:600}
/* ★ 这一条的类名曾经写成 .ac-n，而代码那边打的是 'n ac-num' —— 两条规则对不上，
   分类栏的计数一直没吃到 margin-left:auto（也就是没真正右靠）。2026-10-05 顺手对齐成同一个 .ac-rail-n。
   教训与「col 类名与单元内 span 撞名」是同一族：CSS 与代码各写各的，浏览器两边都不报错，只是那条规则静默失效。 */
.ac-rail-i .ac-rail-n{margin-left:auto;font-variant-numeric:tabular-nums;font-size:11px;color:var(--ac-faint);flex:0 0 auto}
.ac-rail-i.on .ac-rail-n{color:var(--ac-card)}
.ac-rail-i span.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}
.ac-main{display:flex;flex-direction:column;gap:10px;min-width:0;flex:1 1 auto}
/* ★ 2026-10-06 v3 主滚动层就在这一档的 .ac-list 上（用户驳回"根整块滚"的那句：搜索框与筛选条不许跟着结果滚走）。
   这条链上今天**量出来承重**的是两发：两栏等高（上面那条 align-items:stretch）与卡片的 flex:1 1 auto。
   F6/F7 两次证伪各还原一次现场：退回 flex-start 或把卡片写成 flex:none ⇒ 右栏按内容长高（6000px 那一档），
   卡片被 .ac-cat 的 overflow:hidden 裁掉，最后一行既不在格子里、也没有任何能滚的容器包着它（8 屏坏）。
   三处 min-height:0 单独删掉都量不出差别（F2/F2b/F8 = 等价变异：overflow 不是 visible 的盒子，
   自动最小尺寸按规范本来就是 0）；留着是保险，别当它们是这条链的承重墙去省。
   .ac-main>* 先一律 flex:none、再单独放开结果卡：这就是"搜索/筛选常驻、只有列表滚"的全部机制。
   .ac-cardfill 是空态那一格：详情展开在"这个条件下没有条目"下面时它可能比格子还高，不放开就是裁掉。 */
@media (min-width:960px){
  .ac-main>*{flex:none}
  .ac-main>.ac-card{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
  .ac-main>.ac-card>.ac-card-h,.ac-main>.ac-card>.ac-note{flex:none}
  .ac-main>.ac-card>.ac-list,.ac-main>.ac-card>.ac-cardfill{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
}
/* 工具行：搜索框 + 已选条件 + 清空，一行放得下就一行 */
.ac-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
.ac-q{flex:1 1 240px;min-width:160px;padding:6px 10px;border-radius:8px;border:1px solid var(--ac-line2);
  background:var(--ac-card);color:var(--ac-fg);font-family:inherit;font-size:13px}
.ac-q:focus{outline:2px solid var(--ac-info);outline-offset:1px}
/* ---------- 筛选：预设与facet 收成一条，不再是两条噪音带 ---------- */
.ac-filters{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;min-width:0}
.ac-fg{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0}
.ac-fg-lbl{flex:0 0 auto;color:var(--ac-faint);font-size:11px}
.ac-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;cursor:pointer;
  border:1px solid var(--ac-line2);background:var(--ac-card);color:var(--ac-muted);
  font-family:inherit;font-size:11px;white-space:nowrap}
.ac-chip:hover{background:var(--ac-hover)}
.ac-chip.on{background:var(--ac-fg);color:var(--ac-card);border-color:var(--ac-fg);font-weight:600}
/* 「更多 N」与上一枚芯片之间必须有一道竖分隔：
   截图量出来它们之间是 0px，于是「需 OAuth 150 更多 2」被读成一组 ——
   用户会以为「更多 2」是 OAuth 那一档的计数后缀，而不是"展开剩下两档"。 */
.ac-more{border:none;background:transparent;color:var(--ac-info);font-family:inherit;font-size:11px;
  cursor:pointer;padding:2px 4px 2px 9px;white-space:nowrap;margin-left:5px;
  border-left:1px solid var(--ac-line2)}
.ac-more:hover{text-decoration:underline}
/* ---------- 结果列表行：替代六列表格 ---------- */
.ac-list{display:flex;flex-direction:column}
.ac-li{display:flex;align-items:flex-start;gap:10px;padding:8px 14px;border-bottom:1px solid var(--ac-line);
  cursor:pointer;min-width:0}
.ac-li:hover{background:var(--ac-hover)}
.ac-li.on{background:var(--ac-hover)}
.ac-li-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.ac-li-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.ac-nm{font-weight:500;overflow-wrap:anywhere;min-width:0}
.ac-cat-tag{flex:0 0 auto;padding:0 6px;border-radius:999px;border:1px solid var(--ac-line2);
  background:var(--ac-soft);color:var(--ac-faint);font-size:10px;white-space:nowrap}
/* ★ 用途可折行读全（表格那一列是被截断的）：一行条目的信息量本来就靠这句撑着。 */
.ac-desc{color:var(--ac-muted);font-size:12px;white-space:normal;overflow-wrap:anywhere}
.ac-flags{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
/* 三态短标签：Yes/No/unknown 三个英文词在截图里是一地彩色噪点，改成「有/无/未知」这种
   两三字的中文，噪声降下来了，完整话术仍在 title 里（同一个字在窄格里也不挤）。 */
.ac-flag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;white-space:nowrap;
  border:1px solid var(--ac-line2);background:var(--ac-soft);color:var(--ac-muted)}
.ac-flag-yes{color:var(--ac-ok);border-color:currentColor}
.ac-flag-no{color:var(--ac-err);border-color:currentColor}
.ac-flag-unk{color:var(--ac-faint)}
.ac-star{border:none;background:transparent;cursor:pointer;font-size:14px;
  color:var(--ac-faint);padding:0 2px;font-family:inherit;flex:0 0 auto;line-height:1.2}
.ac-star.on{color:var(--ac-warn)}
.ac-empty{margin:0;padding:14px;color:var(--ac-muted);font-size:12px}
/* 加载更多：落点在结果卡自己的卡底，不用浮层也不用自动消失的提示条 */
.ac-morebar{display:flex;align-items:center;gap:10px;padding:9px 14px;flex-wrap:wrap;min-width:0}
.ac-skel{height:34px;border-bottom:1px solid var(--ac-line);
  background:linear-gradient(90deg,var(--ac-soft) 25%,var(--ac-hover) 37%,var(--ac-soft) 63%);
  background-size:400% 100%;animation:ac-shim 1.3s ease infinite}
@keyframes ac-shim{0%{background-position:100% 50%}100%{background-position:0 50%}}
/* 详情对话框：点了某一行才出现（2026-10-06 改判：原来是就地展开在跟着那一行下面）。
   ★ 全场只有这一处 position:fixed 与 z-index：弹框不在文档流里，v3 那套 flex 承重链与它无关。
   ★ 不给它加 sticky 顶栏 —— 那一发在 v3 已被判掉（常驻由 flex 给出），弹框自己内部滚。
   关闭有三条路：点遮罩、按 Esc、头部的「关闭」；外壳只负责 padding 与"比视口矮一点"。 */
.ac-modal-mask{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(15,17,21,.34);background:color-mix(in srgb,var(--ac-fg) 26%,transparent)}
.ac-modal{box-sizing:border-box;width:100%;max-width:520px;max-height:86vh;min-width:0;padding:14px 16px;
  overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;
  background:var(--ac-card);border:1px solid var(--ac-line2);border-radius:12px;
  box-shadow:0 12px 32px rgba(15,17,21,.18)}
/* 内容层 .ac-detail-in：只负责排版，外壳的对白在上一段。 */
.ac-detail-in{display:flex;flex-direction:column;gap:10px;min-width:0}
.ac-detail-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
.ac-detail-h .nm{font-size:14px;font-weight:600}
.ac-urlrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ac-url{font-size:12px;color:var(--ac-info);overflow-wrap:anywhere;max-width:100%}
.ac-derived{display:flex;flex-wrap:wrap;gap:6px}
.ac-derived i{font-style:normal;padding:2px 8px;border-radius:7px;border:1px solid var(--ac-line2);
  background:var(--ac-card);color:var(--ac-muted);font-size:11px}
/* 详情框的两个批注字段：一个一行。2026-10-06 真机那张量出来：并排这两格是全场唯一撑满内宽的一行，
   阅读那几行只吃到内宽的 10~57% —— 框宽是被编辑器撑出来的，右边那一大片空着就是这么来的。 */
.ac-fields{display:flex;flex-direction:column;gap:9px;min-width:0}
.ac-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.ac-field label{font-size:11px;color:var(--ac-muted)}
.ac-field input,.ac-field textarea{padding:5px 8px;border-radius:7px;border:1px solid var(--ac-line2);
  background:var(--ac-card);color:var(--ac-fg);font-family:inherit;font-size:12px;min-width:0}
/* 宽度由 .ac-field 那一列的 flex 决定（根是 column flex：这里再写 flex-basis 就成了**高度**，
   三行的输入框会被拉成 320px 高 —— 无头量 rect 量出来的）。 */
.ac-field textarea{resize:vertical;line-height:1.45}
.ac-counter{font-size:11px;color:var(--ac-faint);font-variant-numeric:tabular-nums}
.ac-counter.over{color:var(--ac-err)}
/* 详情对话框的分区排版（2026-10-06 用户裁定「布局都是乱的，清晰简明概要一点」）：
   一节一个小标题，读的顺序就是「这是什么 → 怎么用 → 现在的限制 → 我的批注」。
   ★ 主次只靠字重与颜色档位，不靠色相 —— 状态色（ok/err/warn/info）留给状态，
     一屏里出现第四种颜色就说明有人在拿颜色当排版用。
   ★ 节题走 muted 不走 faint（2026-10-06 真机那张：faint 的节题比正文浅两级，看着像灰掉的说明文字，
     而它恰恰是这一页唯一的导航锚点）。正文仍然比节题重一档：正文 fg 13px，节题 muted 11px/600。
   ★ 分区是 flex column 的一格，不许在这里写 height / max-height：框内滚动归外壳那一格（名单见 cl-39）。 */
.ac-sec{display:flex;flex-direction:column;gap:7px;min-width:0;padding-top:11px;border-top:1px solid var(--ac-line)}
.ac-sec.first{border-top:none;padding-top:0}
.ac-sec-t{font-size:11px;font-weight:600;color:var(--ac-muted);letter-spacing:.04em}
/* 详情框里的那一句是主角，比列表行里的同名的格重一档（列表 12px muted，这里 13px fg）。
   类名仍然叫 .ac-desc —— cl-19/cl-41 两条判据量的就是这一格「全场只许一条」。 */
.ac-sec .ac-desc{font-size:13px;line-height:1.5;color:var(--ac-fg)}
.ac-usage{display:flex;flex-direction:column;gap:7px;min-width:0}
/* 用法层的一行一格。★ 类名故意不叫 ac-kv：那名字当年是变更流水那张 grid，同一条 CSS 里
   两个同名选择器就是后写的把前写的 display 静默吃掉（无头量 rect 看不出区别，教训见 §9.1m）。
   那张卡 2026-10-06 从界面撤了，ac-kv 的规则一起删干净，名字留着不再复用。 */
.ac-ukv{display:flex;gap:8px;align-items:baseline;min-width:0;font-size:12px;line-height:1.45}
.ac-ukv>.k{flex:0 0 44px;color:var(--ac-faint);font-size:11px}
.ac-ukv>.v{min-width:0;overflow-wrap:anywhere}
.ac-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.ac-ops{display:flex;flex-direction:column;gap:6px;min-width:0}
.ac-op{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px;min-width:0}
.ac-op>.m{flex:none;font-size:10.5px;font-weight:600;padding:2px 6px;border-radius:6px;
  border:1px solid var(--ac-line2);background:var(--ac-soft);color:var(--ac-muted)}
.ac-op>.s{color:var(--ac-muted);font-size:11px;min-width:0;overflow-wrap:anywhere}
/* 用法层的小字两处都用它：截断那句的两个数字、出处那句的抓取日 —— 全部来自载荷（cl-51 钉着）。 */
.ac-absent{color:var(--ac-faint);font-size:11px}
/* 设置页「中文说明」卡的凭据区（2026-10-06 重排）：一个字段一行。
   旧的两格并排有两处对不齐：带「（已配置 · N 位 · 3 天前）」的 label 折行时两格输入框底边错开；
   「存入 / 清除」写在输入框下面，读起来像属于下一栏。
   现在 label 独占一行（状态那句仍留在 label 里 —— cl-44 从 label 上数「已配置」），按钮跟输入框同一行。
   ★ 同一轮详情框里那两个批注字段也改成一行一个，那条理由在上面 .ac-fields 那段（不共用规则：这里两格并排是"一字段一行"里的一行）。 */
.ac-credlist{display:flex;flex-direction:column;gap:9px;min-width:0}
.ac-credrow{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;min-width:0}
.ac-credrow>.ac-field{flex:1 1 240px}
.ac-credrow>.ac-row{flex:0 1 auto}
.ac-tl{list-style:none;margin:0;padding:2px 14px;display:flex;flex-direction:column}
.ac-tl li{display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-bottom:1px solid var(--ac-line);min-width:0}
.ac-tl li:last-child{border-bottom:none}
.ac-tl li:before{content:'';flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:var(--ac-faint);align-self:center;margin-right:-2px}
.ac-tl li[data-kind="added"]:before{background:var(--ac-ok)}
.ac-tl li[data-kind="removed"]:before,.ac-tl li[data-kind="source_error"]:before{background:var(--ac-err)}
.ac-tl li[data-kind="changed"]:before,.ac-tl li[data-kind="moved"]:before{background:var(--ac-warn)}
.ac-kicker{flex:0 0 auto;min-width:74px;text-align:center;padding:1px 8px;border-radius:999px;
  border:1px solid var(--ac-line2);background:var(--ac-card);color:var(--ac-muted);font-size:11px}
.ac-tl-body{min-width:0;flex:1 1 auto;overflow-wrap:anywhere;line-height:1.45}
.ac-ago{flex:0 0 auto;color:var(--ac-faint);font-size:11px;white-space:nowrap;align-self:flex-start;padding-top:1px}
/* 我的笔记 */
.ac-tag{display:inline-block;margin:0 4px 0 0;padding:0 6px;border-radius:999px;border:1px solid var(--ac-line2);
  background:var(--ac-card);color:var(--ac-muted);font-size:10px;white-space:nowrap}
.ac-orphan{color:var(--ac-warn);font-size:11px}
.ac-export{width:100%;min-height:120px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;
  padding:8px;border-radius:8px;border:1px solid var(--ac-line2);background:var(--ac-card);color:var(--ac-fg)}
/* 设置 */
.ac-set{display:flex;flex-direction:column;gap:10px}
.ac-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
.ac-src{display:flex;flex-direction:column;gap:6px}
.ac-src-i{display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--ac-line);
  border-radius:9px;background:var(--ac-card);min-width:0}
.ac-src-i .idx{flex:0 0 20px;text-align:center;font-variant-numeric:tabular-nums;color:var(--ac-faint);font-size:11px}
.ac-src-i .lb{font-weight:500;white-space:nowrap}
.ac-src-i .nt{color:var(--ac-faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ac-src-i .mv{margin-left:auto;display:flex;gap:4px;flex:0 0 auto}
.ac-mini{border:1px solid var(--ac-line2);background:var(--ac-card);color:var(--ac-muted);cursor:pointer;
  border-radius:6px;font-size:11px;padding:1px 7px;font-family:inherit}
.ac-mini:hover{background:var(--ac-hover);color:var(--ac-fg)}
.ac-mini[disabled]{opacity:.4;cursor:default}
`;

    /** 返回值是撤销器（宿主 effect 的口径）：已注入过就返回空撤销器，不重复往 head 塞同一份 CSS。 */
    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => el.remove();
    }

    // ------------------------------------------------------------
    // 2) 小工具：只有格式，没有判定
    // ------------------------------------------------------------
    const nowMs = () => Date.now();

    function fmtAgo(at, ref) {
      const t = Number(at);
      if (!Number.isFinite(t) || t <= 0) return '从未';
      const d = Math.max(0, (Number(ref) || nowMs()) - t);
      const m = Math.round(d / 60000);
      if (m < 1) return '刚刚';
      if (m < 60) return `${m} 分钟前`;
      const h2 = Math.floor(m / 60);
      if (h2 < 24) return `${h2} 小时 ${m % 60} 分前`;
      return `${Math.floor(h2 / 24)} 天前`;
    }

    function fmtTime(at) {
      const t = Number(at);
      if (!Number.isFinite(t) || t <= 0) return '—';
      try { return new Date(t).toLocaleString(); } catch { return String(t); }
    }

    /**
     * 精确到分钟的时刻（页头那颗状态 pill 用）。
     * ★ 不用 toLocaleString：那一句带着秒和 locale 给的上午/下午，塞进 pill 就是一长条；
     *   分钟是这一格的全部信息量 —— 用户要分的是"今天查过没变"和"根本没查"，不是第几秒。
     * · 无效值回**空串**而不是 '—'：调用方据此整段不画，pill 上不会挂出一个「 · —」。
     *   （旧版写的 meta 行本来就可能没有 lastCheckedAt 那一格。）
     */
    function fmtMinute(at) {
      const t = Number(at);
      if (!Number.isFinite(t) || t <= 0) return '';
      const d = new Date(t);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function fmtCount(n) {
      const v = Number(n);
      return Number.isFinite(v) ? String(v) : '—';
    }

    const flagClass = (v) => (v === 'Yes' ? 'ac-flag-yes' : v === 'No' ? 'ac-flag-no' : 'ac-flag-unk');
    /** 第三种状态有自己的文案（把 unknown 说成 No 是谎报，说成 Yes 更糟）。 */
    const flagLabel = (kind, v) => {
      const map = kind === 'https' ? cfg().httpsLabels : cfg().corsLabels;
      return (map || {})[String(v).toLowerCase() === 'unknown' ? 'unknown' : v] || String(v || '—');
    };
    const authLabel = (v) => (cfg().authLabels || {})[v === 'unknown' ? 'unknown' : v] || String(v || '—');
    /** 三组 facet 各自的完整话术（鉴权走 authLabels，另两组走各自的 yes/no/unknown 标签）。 */
    const facetLabelOf = (field, v) => (field === 'auth' ? authLabel(v) : flagLabel(field, v));
    /**
     * 列表行上那三枚状态标签的**短词**。截图里 Auth/HTTPS/CORS 三列写的是
     * No / Yes / unknown 三个英文词，在一屏 100 行里变成一地彩色噪点；
     * 短词让噪声降下来，完整话术仍在 title 里（点/悬停拿得到，且截图也核得到）。
     * 这不是新造枚举：它只是把载荷里那三句长话术压成两个字，长话术本身仍以载荷为准。
     */
    const flagShort = (kind, v) => {
      if (v === 'Yes') return kind === 'cors' ? '可直连' : '支持';
      if (v === 'No') return kind === 'cors' ? '需代理' : '不支持';
      return '未知';
    };
    /** 鉴权那一列的短词。与 flagShort 同一条口径：短词上屏，长话术挂 title。 */
    const authShort = (v) => ({
      No: '免鉴权', apiKey: '需 key', OAuth: '需 OAuth',
      'X-Mashape-Key': 'Mashape', 'User-Agent': '需 UA', unknown: '未知',
    }[v] || String(v || '未知'));
    const kindLabel = (k) => (cfg().changeKindLabels || {})[k] || String(k || '—');
    const statusLabel = (s) => (cfg().syncStatusLabels || {})[s] || '还没有跑过同步';

    /**
     * 用途那一行的取法：**有中文就上中文，没中文就原样上英文**（原文挂 title，随时看得见）。
     * ★ 这一层没有半句翻译逻辑：读的是服务端 zhForDesc 补好的 descZh / descZhFrom（判据在 lib/query.js）。
     *   界面自己判"要不要显示英文"就会出现两种坏：把英文当中文挂上中文标签，或把两句并排念一遍。
     */
    const descText = (item) => (item?.descZh ? item.descZh : item?.desc || '');
    const descTitle = (item) => (item?.descZh ? `上游原文：${item.desc}` : '');
    /** 这句中文是谁给的：整句落款由服务端拼好（lib/query.js 的 descZhLabel），界面只念不拼。 */
    const descZhSource = (item) => (item?.descZh ? item.descZhLabel || '' : '');
    /** 现译失败的回执话术：一律查载荷里那张表，界面不去 parse 服务端那句中文原因。 */
    const transErrLabel = (key) => (cfg().transErrorLabels || {})[key] || String(key || '没说原因');

    /** 载荷没到 = apply 里一个入口都不注册（见文件末尾）：没有路由的面板点开全是 404，比看不到入口更糟。 */

    // ------------------------------------------------------------
    // 3) 取数
    // ------------------------------------------------------------
    async function api(path, opts = {}) {
      const res = await fetch(`${API_BASE()}${path}`, opts);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok !== true) {
        const msg = body?.error?.message || `HTTP ${res.status}`;
        throw Object.assign(new Error(msg), { code: body?.error?.code });
      }
      return body.data;
    }

    const post = (path, obj) => api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj ?? {}),
    });

    /** 搜索参数 → query string：facet 用重复键（与逗号同义，两边都认是服务端那侧的口径）。 */
    function searchQs(p) {
      const q = new URLSearchParams();
      if (p.q) q.set('q', p.q);
      if (p.category) q.set('category', p.category);
      for (const field of ['auth', 'https', 'cors']) {
        const list = p[field] || [];
        for (const v of list) q.append(field, v);
      }
      if (p.limit) q.set('limit', String(p.limit));
      // ★ offset 只在**有值且不为 0** 时才发：首屏那一发必须干干净净（带上 offset=0 看着多余，
      //   而 cl-35b 正是靠「首屏那发没有 offset」来证明它不是从第 100 条开始的）。
      if (p.offset) q.set('offset', String(p.offset));
      const s = q.toString();
      return s ? `?${s}` : '';
    }

    async function consumeSse(res, onEvent) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message';
          const dataLines = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          try { onEvent(ev, JSON.parse(dataLines.join('\n'))); } catch { /* 坏帧丢弃：下一帧会是全量快照 */ }
        }
      }
    }

    function useStream(setSnap, setConn) {
      const stopRef = useRef(false);
      useEffect(() => {
        stopRef.current = false;
        let retry = null;
        (async function loop() {
          while (!stopRef.current) {
            // 服务端在 200 头已发出之后只能塞一帧 error（再写 503 就是 headers already sent），
            // 那句话比「推流断开」有用，所以记下它、断开时当原因显示。
            let brokenNote = '';
            try {
              const res = await fetch(`${API_BASE()}/stream`);
              if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
              setConn({ ok: true, note: '' });
              await consumeSse(res, (ev, data) => {
                // update 帧就是 GET /api/snapshot 的同形载荷：整体替换，不许在这里补字段。
                if (ev === 'snapshot' || ev === 'update') setSnap(data);
                else if (ev === 'error') brokenNote = data?.message || `推流报错（${data?.code ?? '没给原因'}）`;
              });
              if (!stopRef.current) setConn({ ok: false, note: brokenNote || '推流断开，正在重连' });
            } catch (e) {
              if (!stopRef.current) setConn({ ok: false, note: brokenNote || `推流不可用：${e?.message ?? e}（没有实时更新，改动要点「刷新」）` });
            }
            if (stopRef.current) break;
            await new Promise((r) => { retry = setTimeout(r, 5000); });
          }
        })();
        return () => { stopRef.current = true; if (retry) clearTimeout(retry); };
      }, []);
    }

    /** 刷新整份快照（写库之后要用：数字与行都得是服务端那一份）。 */
    const refreshSnap = async (setSnap) => {
      try { setSnap(await api('/snapshot')); } catch { /* 保留屏幕上那份，失败原因由调用方报 */ }
    };

    // ------------------------------------------------------------
    // 4) 页签：白名单只有这一份，渲染与校验都用它
    // ------------------------------------------------------------
    const TAB_DEFS = [
      { id: 'catalog', label: '目录' },
      // 2026-10-07 用户要「把社区常用的 API 按使用频率整合在一页」；同一轮裁定「先只做壳，频率来源待指定」。
      // 位置排在目录之后：它是目录的一种看法，不与「变更 / 我的笔记 / 设置」那三页并列同类。
      { id: 'common', label: '常用API' },
      { id: 'changes', label: '变更' },
      { id: 'notes', label: '我的笔记' },
      { id: 'settings', label: '设置' },
    ];
    const TAB_IDS = TAB_DEFS.map((t) => t.id);
    const DEFAULT_TAB = TAB_IDS[0];

    /** 认不出来的页签 id 一律回落到当前那一页：白名单只有 TAB_DEFS 一份，别在第二处再列一遍 id。 */
    function goTab(id, current) {
      return TAB_IDS.includes(id) ? id : current;
    }

    /**
     * 页签上的小计数。★ `common` 不在这里挂数（2026-10-07）：这一页还没有排序依据，
     * 挂 450 还是挂 2019 都不回答「哪些是常用的」，挂上去只是把目录页的一个筛选子集冒充成社区频率。
     * 有来源了就挂来源数得出的那个数，别先挂个占位。
     */
    function tabCounts(snap) {
      const notesTotal = snap?.notes?.total ?? 0;
      return { catalog: snap?.result?.total ?? 0, notes: notesTotal };
    }

    function TabBar({ tab, onTab, snap }) {
      const counts = tabCounts(snap);
      return h('nav', { className: 'ac-tabs' }, TAB_DEFS.map((t) =>
        h('button', {
          key: t.id,
          className: `ac-tab${tab === t.id ? ' on' : ''}`,
          onClick: () => onTab(t.id),
        }, t.label, counts[t.id] ? h('span', { className: 'ac-tab-n ac-num' }, String(counts[t.id])) : null)));
    }

    // ------------------------------------------------------------
    // 5) 页头
    // ------------------------------------------------------------
    /**
     * 页头：标题行（标题 + 状态 pill）+ 副标题行（条数/快照）。右侧只有「立即同步」一个主操作。
     *
     * ★ 2026-10-05 删掉了原来那枚「刷新」：它与「立即同步」在用户眼里是同一件事（都是"把屏幕更新一下"），
     *   而真机推流（SSE）本来就一直在推 —— 快照落后的情况只剩「推流断了」一种，
     *   那一支由下面的「重新连接」接住（可点性从 conn.ok 派生，不藏按钮）。
     *   两个入口说一件事，用户就得猜该点哪个；点错了还得看回执才知道有没有生效。
     */
    function Header({ snap, conn, syncing, onSync, onReconnect }) {
      const meta = snap?.meta || {};
      const caps = snap?.capabilities || cfg().capabilities || {};
      const status = meta.lastStatus;
      const isFail = status === 'failure';
      // 源名从载荷那张表按 sourceId 取（换源那天起有中文源与降级源两拨名字，写死一个就必念错）。
      // 还没同步过 ⇒ 不编名字，那半句留给下面「库里还没有条目」那条实话。
      const srcName = ((cfg().sources || []).find((x) => x.id === meta.sourceId) || {}).label || '';
      // 上次检查的时刻（含"查了但没变"那一轮）：pill 那句话靠它才分得出"查过"与"没查"。
      const checkAt = fmtMinute(meta.lastCheckedAt);
      // 能力位降级：只在真的缺位时占一行，平时不画（三个灰 pill 常驻是纯噪音）。
      const capsBad = [
        caps.timer === false ? '定时器缺位，已退到进程内定时' : '',
        caps.storageDomain === false ? '存储不可用，笔记不落库' : '',
      ].filter(Boolean);
      return h('div', { className: 'ac-head' },
        h('div', { className: 'ac-head-l' },
          h('div', { className: 'ac-title-row' },
            h('span', { className: 'ac-title' }, cfg().label || '免费 API 目录'),
            // 连接状态与上次检查合成一枚 pill：两个 pill 各带一个绿点，视觉上像两件事，其实是一件事。
            // ★ 2026-10-08（U-19）：这句话术后面跟上「上次检查」的时刻。那句状态话术（宿主的 SYNC_STATUS_LABELS）
            //   说的是"查过、源内容没变"，可屏幕上没有时刻时它和"三天没查过"长得一模一样 ——
            //   用户看着副标题里那个昨天的快照时刻问「12 小时一次为什么还是昨天」，就是被这个缺口逼出来的。
            //   时刻并进这一枚、不开第二枚，也不新加载荷字段（meta.lastCheckedAt 本来就在快照里）；
            //   断流那一支不挂时刻：那个时刻属于「上次检查」，接在"推流断开"后面会被读成断开发生在这一刻。
            h('span', { className: 'ac-pill' },
              h('i', { className: `ac-dot${conn.ok ? ' ac-dot-ok' : ' ac-dot-err'}` }),
              conn.ok
                ? (status
                  ? `${statusLabel(status)}${checkAt ? ` · ${checkAt}` : ''}`
                  : '实时更新中')
                : (conn.note || '未在实时更新')),
            isFail && meta.lastError
              ? h('span', { className: 'ac-faint' }, `（${meta.lastError}）`) : null,
            // 断流时才出现的补救入口：可点性从状态派生，常驻一个灰掉的按钮只是摆设。
            conn.ok ? null : h('button', { className: 'ac-link', onClick: onReconnect }, '重新连接')),
          h('div', { className: 'ac-sub' },
            `${srcName ? `${srcName} · ` : ''}${fmtCount(snap?.index?.total)} 条 / ${fmtCount(snap?.index?.categories)} 类`,
            meta.sha ? h('span', { className: 'ac-faint' }, ` · 快照 ${fmtTime(meta.fetchedAt || meta.lastCheckedAt)}`) : null,
            snap && !snap.index.total ? h('span', { className: 'ac-sub' }, ' · 库里还没有条目，点右侧「立即同步」跑第一轮') : null),
          capsBad.length
            ? h('div', { className: 'ac-capsline' }, capsBad.map((c) => h('span', { className: 'ac-pill', key: c }, c)))
            : null),
        h('div', { className: 'ac-head-r' },
          h('button', {
            className: 'ac-btn ac-btn-primary', disabled: syncing, onClick: onSync,
          }, syncing ? '同步中…' : '立即同步')));
    }

    /** 一句实话落在页头下方：不弹层、不自动消失，用户看得见自己刚干了什么。 */
    function Notice({ msg, kind }) {
      if (!msg) return null;
      return h('div', { className: `ac-notice${kind === 'err' ? ' ac-notice-err' : kind === 'ok' ? ' ac-notice-ok' : ''}` }, msg);
    }

    // ------------------------------------------------------------
    // 6) 目录页签
    // ------------------------------------------------------------
    /**
     * 分类中文名的唯一来源是载荷里的 `facets.category[].label`（`lib/categories.js` 那份映射只活在服务端）。
     * 这里不许再抄一份表：抄了就有两处真话，上游改分类时只有服务端那份会跟着变。
     * 没有映射（上游新开的分类 / 载荷还没到）⇒ 回落成原文，不猜译。
     */
    function catMap(snap) {
      const m = new Map();
      for (const c of snap?.facets?.category || []) if (c.label) m.set(c.name, c.label);
      return m;
    }
    const catZh = (cats, name) => (name && cats?.get?.(name)) || '';

    /**
     * 分类栏。★ 2026-10-05：原来「中文标签 + 英文原文 + 计数」挤在同一行，
     *   208px 宽下真机截出来是「认证与…」「云存储与…」「文档与生…」—— 三样里被切掉的偏偏是
     *   **中文标签**（唯一对用户有信息量的那个），英文原文反而占着位置。
     *   改法：中文标签独占一行（flex:1，计数右靠），英文原文只留在 title 里。
     *   判据：英文原文**仍然可得**（悬停），所以没有丢掉"中文是我们加的、不是上游写的"这个事实，
     *   但不再拿它去挤用户真正要读的那一行。
     */
    function CategoryRail({ snap, category, onPick }) {
      // 展开态的初值跟着窗口宽度走：窄面板（~430px）里 51 类铺开会把结果区顶到两屏之外
      // （无头 430px 截图抓到的）。两栏时铺开是对的 —— 那一栏本来就是并排的。
      // 只取初值：用户点过之后就不再被窗口变化推翻（改版时别把这个做成受控的）。
      // ★ 读不到宽度时一律按"展开"处理：`innerWidth || 1280` 这个兜底不能写成 `?? 0`
      //   ——0 会让「窄屏默认收起」这条规则在拿不到尺寸的环境里恒真，把两栏布局的分类栏也收起来。
      const [open, setOpen] = useState(() => (Number(globalThis.innerWidth) || 1280) >= 960);
      const cats = snap?.facets?.category || [];
      const total = snap?.index?.total ?? 0;
      return h('aside', { className: 'ac-rail' },
        h('div', { className: 'ac-rail-h' },
          h('b', null, '分类'),
          h('span', { className: 'ac-faint ac-num' }, `${cats.length} 类 · ${fmtCount(total)} 条`),
          h('button', { className: 'ac-link', style: { marginLeft: 'auto' }, onClick: () => setOpen(!open) }, open ? '收起' : '展开')),
        open
          ? h('div', { className: 'ac-rail-list' },
              /* 「全部分类」跨满整行：它是"取消筛选"而不是一个分类，
                 挤在网格第一格里会在它右侧留一个空格（1440 截图上很明显）。
                 网格里 52 项 ⇒ 跨行之后是1 + 51，51 是奇数，最后一格仍会空 ——
                 所以下面给列表补一条"补齐"用的透明格（CSS 画，不进节点树）。 */
              h('button', {
                className: `ac-rail-i ac-rail-all${!category ? ' on' : ''}`,
                onClick: () => onPick(''),
                title: '取消分类筛选，看全部条目',
              },
                h('span', { className: 'nm' }, '全部分类'), h('span', { className: 'ac-rail-n' }, fmtCount(total))),
              cats.map((c) => h('button', {
                key: c.name,
                className: `ac-rail-i${category === c.name ? ' on' : ''}`,
                onClick: () => onPick(category === c.name ? '' : c.name),
                // title 始终带上游原文：中文是我们给的标签，截图与悬停里都要能核到它对应哪个原文类。
                title: c.label ? `${c.label}（上游原文 ${c.name}）` : c.name,
              },
                h('span', { className: 'nm' }, c.label || c.name),
                h('span', { className: 'ac-rail-n' }, fmtCount(c.count)))))
          : null);
    }

    /**
     * 筛选区：预设 + 三组 facet 收在**一条**里（原来占两行，且每组都从最大计数排到最小，
     * 那条带子一眼扫过去全是数字，读不出"我想筛什么"）。
     *
     * 三条改法：
     *  ① 值显示中文短词（No→免鉴权、apiKey→需 key…），但**请求参数仍发上游原值** ——
     *     显示层改口径，筛出去的主键不能跟着改。
     *  ② 每组默认只列计数前 3 的值，末尾一枚「更多」就地展开。已选中的值**无论计数多小都必须可见**
     *     ——否则用户点完「User-Agent」那枚芯片，它就从视野里消失了，看着像没点上。
     *  ③ 组标签用等宽小字（鉴权/HTTPS/CORS），不再靠一个灰色胶囊撑出视觉分组。
     */
    const FACET_SHORT = {
      auth: { No: '免鉴权', apiKey: '需 key', OAuth: '需 OAuth', 'X-Mashape-Key': 'Mashape Key', 'User-Agent': '需 UA' },
      https: { Yes: '有', No: '无', unknown: '未知' },
      cors: { Yes: '可直连', No: '需代理', unknown: '未知' },
    };
    const facetShort = (field, v) => (FACET_SHORT[field] || {})[v] || String(v);

    const FACET_DEFS = [
      { field: 'auth', label: '鉴权' },
      { field: 'https', label: 'HTTPS' },
      { field: 'cors', label: 'CORS' },
    ];

    function FacetFilter({ snap, sel, onToggle, more, onMore, presets, presetCounts, onPreset, onClear, dirty }) {
      return h('div', { className: 'ac-filters' },
        // 预设并进这一条（原来它独占一行、还带一句「一键预设：」标签，只有两枚芯片）
        h('span', { className: 'ac-fg', key: 'preset' },
          h('span', { className: 'ac-fg-lbl' }, '快捷'),
          presets.map((p) => h('button', {
            key: p.id, className: 'ac-chip', onClick: () => onPreset(p), title: p.hint || '',
          }, `${p.label} ${fmtCount(presetCounts[p.id])}`))),
        FACET_DEFS.map((d) => {
          const counts = snap?.facets?.[d.field] || {};
          const all = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([v]) => v);
          if (!all.length) return null;
          const picked = sel[d.field] || [];
          // 前 3 枚 + 全部已选值（去重后按计数顺序排）：保证"选了什么"永远看得见
          const head = all.slice(0, 3);
          const rest = all.filter((v) => !head.includes(v));
          const shown = more[d.field] ? all : [...new Set([...head, ...picked.filter((v) => all.includes(v))])];
          return h('span', { className: 'ac-fg', key: d.field },
            h('span', { className: 'ac-fg-lbl' }, d.label),
            shown.map((v) => h('button', {
              key: v, className: `ac-chip${picked.includes(v) ? ' on' : ''}`, onClick: () => onToggle(d.field, v),
              // ★ 这句不说"上游原值"（U-16）：`unknown` 是本插件合成的取值，源里写的是 Unknown/未知/–/含义不明的「是」。
              title: `${facetLabelOf(d.field, v)}（库里记的取值 ${v}）`,
            }, `${facetShort(d.field, v)} ${fmtCount(counts[v])}`)),
            rest.length
              ? h('button', {
                  className: 'ac-more', onClick: () => onMore(d.field),
                }, more[d.field] ? '收起' : `更多 ${rest.length}`)
              : null);
        }),
        dirty ? h('button', { className: 'ac-link', onClick: onClear }, '清空筛选') : null);
    }

    /**
     * 结果列表行。★ 2026-10-05 从六列表格改来。
     *
     * 为什么不是表格：截图里那张表在宿主主区（~880px 可视宽）里把用途列压到需要横向滚动才能读全，
     * 而用途恰恰是这一页唯一有信息量的句子。列表行的正文能自然折行，窄面板也不裁列。
     * 三枚状态标签从「Yes/No/unknown 三个英文词」改成短词，噪声降下来了，长话术在 title 里。
     *
     * ★ 详情不再跟着这一行（2026-10-06 改判）：它是对话框，挂在根上，见 DetailModal。
     *   所以这一层也不再收 detailNode —— 列表只管列表。
     */
    function ResultList({ rows, cats, expandedSlug, onRow, loadingMore, onLoadMore, hasMore, shown, total }) {
      const kids = [];
      for (const r of rows) {
        kids.push(
            h('div', {
              key: r.slug,
              // data-slug：行的业务键落在 DOM 上。理由有两条 ——
              // ① 断言要按 slug 判「两页有没有接错位」，而**名称不唯一**（实测 2019 条里
              //   Animals 分类下有两个不同的 "Cat Facts"），按名称去重会报 4 条假重复；
              // ② 真机排障时在审查工具里一眼能认出这是哪一条。
              'data-slug': r.slug,
              className: `ac-li${expandedSlug === r.slug ? ' on' : ''}`,
              onClick: () => onRow(r),
            },
            h('div', { className: 'ac-li-main' },
              h('div', { className: 'ac-li-top' },
                h('span', { className: 'ac-nm' }, r.name),
                h('span', { className: 'ac-cat-tag', title: catZh(cats, r.category) ? `上游原文 ${r.category}` : '' },
                  catZh(cats, r.category) || r.category)),
              h('div', { className: 'ac-desc', title: descTitle(r) },
                descText(r) || '（上游没给这一条写用途）')),
            h('div', { className: 'ac-flags' },
              h('span', { className: 'ac-flag', title: authLabel(r.auth) }, authShort(r.auth)),
              h('span', { className: `ac-flag ${flagClass(r.https)}`, title: flagLabel('https', r.https) },
                flagShort('https', r.https)),
              h('span', { className: `ac-flag ${flagClass(r.cors)}`, title: flagLabel('cors', r.cors) },
                flagShort('cors', r.cors)),
              h('button', {
                className: `ac-star${r.note?.starred ? ' on' : ''}`,
                title: r.note?.starred ? '已置顶' : '置顶（我的笔记里排最前）',
                onClick: (ev) => { ev.stopPropagation(); onRow(r); },
              }, r.note?.starred ? '★' : '☆'))),
        );
      }
      return h('div', { className: 'ac-list' }, kids,
        // 加载更多：落点在结果卡自己的卡底（不是浮层）。已看条数与总数都念出来，
        // 「继续加载」没有对应数字的话用户不知道点了会多出多少。
        hasMore || loadingMore
          ? h('div', { className: 'ac-morebar' },
              loadingMore
                ? [1, 2, 3].map((i) => h('div', { className: 'ac-skel', key: `sk${i}` }))
                : h('button', { className: 'ac-btn', onClick: onLoadMore },
                    `继续加载（已显示 ${fmtCount(shown)} / ${fmtCount(total)}）`))
          : (total ? h('div', { className: 'ac-morebar' },
              h('span', { className: 'ac-faint' }, `全部 ${fmtCount(total)} 条已显示`)) : null));
    }
    /**
     * 用法层：构建期一次性抓来的那份规范里抽出的几格（`lib/usage.js`，详情载荷才带）。
     * ★ 取不到就整块不摆，不写「没有可用规范」占位：全表 2009 条里只有 177 条抓到了机器可读规范，
     *   占位等于给 91% 的弹框多一行废话；这一格有没有，界面上自己就看得出来。
     * ★ 每一格都只从载荷读：base 只念规范里的 servers（14 条没有就不摆这一行），
     *   不许拿条目的 url 假装成调用地址 —— 那是把"我猜的"排版成"厂商写的"。
     */
    function UsageSection({ u }) {
      if (!u) return null;
      const ops = u.operations || [];
      const sec = u.globalSecurity || [];
      const schemes = u.schemes || [];
      const byId = {};
      for (const s of schemes) byId[s.id] = s;
      // 一句鉴权话术：只由 type / in / name 三个字段拼，字段没写就说没写，不补成「Bearer」这种规范里没说的词。
      const schemeText = (id) => {
        const s = byId[id] || {};
        if (s.type === 'apiKey') {
          const where = s.in === 'header' ? '请求头' : s.in === 'query' ? '查询参数' : null;
          return where && s.name ? `key 放${where} ${s.name}` : `apiKey（${s.name || id}，规范没写放在哪）`;
        }
        if (s.type) return `${s.type} 方案 ${s.name || id}`;
        return id;
      };
      return h('div', { className: 'ac-sec' },
        h('div', { className: 'ac-sec-t' }, '怎么用'),
        h('div', { className: 'ac-usage' },
          (u.servers || []).map((s, i) => h('div', { key: `bs${i}`, className: 'ac-ukv' },
            h('span', { className: 'k' }, i ? '' : '地址'),
            h('span', { className: 'v ac-mono' }, s))),
          sec.length
            ? h('div', { className: 'ac-ukv' },
                h('span', { className: 'k' }, '鉴权'),
                h('span', { className: 'v' }, sec.map(schemeText).join('；')))
            : schemes.length
              ? h('div', { className: 'ac-ukv' },
                  h('span', { className: 'k' }, '鉴权'),
                  h('span', { className: 'v' }, `${schemes.map((s) => schemeText(s.id)).join('；')}（规范没写是不是每个请求都要）`))
              : null,
          h('div', { className: 'ac-ukv' },
            h('span', { className: 'k' }, '操作'),
            h('div', { className: 'ac-ops v' }, ops.map((op, i) => h('div', { key: `op${i}`, className: 'ac-op' },
              h('span', { className: 'm' }, op.method),
              h('span', { className: 'ac-mono' }, op.path),
              op.summary ? h('span', { className: 's' }, op.summary) : null)))),
          u.pathCount > ops.length
            ? h('div', { className: 'ac-absent' }, `规范里共 ${u.pathCount} 个操作，这里列的是抓下来的前 ${ops.length} 个`) : null,
          h('div', { className: 'ac-ukv' },
            h('span', { className: 'k' }, '出处'),
            h('span', { className: 'v' },
              h('a', { className: 'ac-url', href: u.spec, target: '_blank', rel: 'noreferrer noopener' },
                `${u.kind}${u.specVersion ? ` · ${u.specVersion}` : ''}`),
              h('span', { className: 'ac-absent' }, ` 机器可读规范 · ${u.at} 抓的`)))));
    }

    /**
     * 行详情：在对话框里就地编辑、就地保存。
     * ★ 草稿只在换条目或重载时重置：正在打的字不能被 update 帧冲掉（modelwatch 那两条输入框同一条教训）。
     * ★ 上限只从载荷取：载荷没给就**不显示计数器**，不写一个自己猜的数（界面报「/ 2000」而服务端按别的数拒，就是冒充）。
     * ★ 本组件只出内容层 .ac-detail-in：外壳（遮罩、尺寸、内部滚）由 DetailModal 给。
     *   它不再关心自己身后那一行 —— 对话框挂在根上，条目被筛掉也不会让它消失或跳位。
     * ★ 2026-10-06 重排（用户："布局都是乱的，清晰简明概要一点"）：从"一叠平铺的格"改成四节，
     *   读的顺序就是「这是什么 → 怎么用 → 现在的限制 → 我的批注」。类名一个没换（ac-desc / ac-derived /
     *   ac-faint 各一格的判据仍然成立），只是每一格被归到它那一节里。
     * ★ 同日 S14（用户再看真机："这个布局这么丑，为什么没有调整过来"）：上一轮只分了节、没量宽。
     *   量出来阅读那几行只吃内宽的 10~57%，唯一撑满的是并排的两个输入框 ⇒ 框宽是编辑器撑出来的。
     *   这一轮把框收到 520、两个字段一行一个、节题提一档、那句批注时间挪到行尾。节的数量与类名没动。
     */
    function RowDetail({ detail, cats, draft, loading, err, saving, noteNote, onDraft, onSave, onDelete, onClose }) {
      const e = detail?.entry;
      if (loading && !e) return h('div', { className: 'ac-detail-in' }, h('div', { className: 'ac-sub' }, '正在取这一条…'));
      if (!e) return err ? h('div', { className: 'ac-detail-in' }, h(Notice, { msg: err, kind: 'err' })) : null;
      const note = e.note || {};
      const d = draft || {};
      const maxLen = Number(cfg().notePurposeMaxLen);
      const over = Number.isFinite(maxLen) && (d.purpose ?? note.purpose ?? '').length > maxLen;
      const tagCount = Number(cfg().tagMaxCount), tagLen = Number(cfg().tagMaxLen);
      return h('div', { className: 'ac-detail-in' },
        h('div', { className: 'ac-detail-h' },
          h('span', { className: 'nm' }, e.name),
          h('span', { className: 'ac-sub', title: catZh(cats, e.category) ? `上游原文 ${e.category}` : '' },
            catZh(cats, e.category) || e.category),
          note.orphan ? h('span', { className: 'ac-orphan' }, '上游已删，批注仍在') : null,
          h('button', { className: 'ac-link', style: { marginLeft: 'auto' }, onClick: onClose, title: '关闭（Esc 或点框外也一样）' }, '关闭')),
        // 出处那一行只剩链接：旁边那枚「重新取」2026-10-07 撤了（用户裁定「直接撤掉这个按钮」）。
        // 它走的是 GET /api/entry —— 读的是**本机库里那一行**，不碰上游；而关掉再点开是同一个调用，
        // 名字还容易读成"去上游重抓这条 API"。要重读 = 关掉再点开。
        h('div', { className: 'ac-urlrow' },
          h('a', { className: 'ac-url', href: e.url, target: '_blank', rel: 'noreferrer noopener' }, e.url)),
        h('div', { className: 'ac-sec first' },
          h('div', { className: 'ac-sec-t' }, '这是什么'),
          h('div', { className: 'ac-desc', title: descTitle(e) }, descText(e) || '（上游没给这一条写用途）'),
          // 落款只在真有中文时出现：给英文原文挂一句「内置离线预译」就是冒充（desc-zh 那条 translated 判据的同一条口径）。
          descZhSource(e) ? h('div', { className: 'ac-faint' }, `中文说明来自：${descZhSource(e)}`) : null),
        h(UsageSection, { u: e.usage }),
        h('div', { className: 'ac-sec' },
          h('div', { className: 'ac-sec-t' }, '现在的限制'),
          h('div', { className: 'ac-derived' }, (e.derived || []).map((x, i) => h('i', { key: `${e.slug}-d${i}` }, x)))),
        h('div', { className: 'ac-sec' },
          h('div', { className: 'ac-sec-t' }, '我的批注'),
          h('div', { className: 'ac-fields' },
            h('div', { className: 'ac-field' },
              h('label', null, '用途说明'),
              h('textarea', {
                rows: 3,
                value: d.purpose ?? note.purpose ?? '',
                placeholder: '自己才看得懂的那句：接过什么、返回什么长啥样、key 在哪个页面拿',
                onChange: (ev) => onDraft({ purpose: ev.target.value }),
              }),
              Number.isFinite(maxLen)
                ? h('span', { className: `ac-counter${over ? ' over' : ''}` },
                    `${(d.purpose ?? note.purpose ?? '').length} / ${maxLen} 字${over ? '（超了，保存会被拒）' : ''}`)
                : null),
            h('div', { className: 'ac-field' },
              h('label', null, Number.isFinite(tagCount) && Number.isFinite(tagLen)
                ? `标签（逗号分隔，最多 ${tagCount} 个、每个 ${tagLen} 字）` : '标签（逗号分隔）'),
              h('input', {
                value: d.tags ?? tagsToText(note.tags),
                placeholder: '可用,已接,备用',
                onChange: (ev) => onDraft({ tags: ev.target.value }),
              }))),
          h('div', { className: 'ac-row' },
            h('button', {
              className: `ac-mini${(d.starred ?? note.starred) ? ' on' : ''}`,
              onClick: () => onDraft({ starred: !(d.starred ?? note.starred) }),
            }, (d.starred ?? note.starred) ? '★ 已置顶' : '☆ 置顶'),
            h('button', {
              className: `ac-mini${(d.hidden ?? note.hidden) ? ' on' : ''}`,
              onClick: () => onDraft({ hidden: !(d.hidden ?? note.hidden) }),
              title: '藏的是「默认别烦我」，带关键词搜索仍会出',
            }, (d.hidden ?? note.hidden) ? '已在默认结果里隐藏' : '默认结果里隐藏'),
            h('button', { className: 'ac-btn ac-btn-primary', disabled: saving, onClick: () => onSave(e, d) }, saving ? '保存中…' : '保存批注'),
            Object.keys(note).length ? h('button', { className: 'ac-btn', onClick: () => onDelete(e.slug) }, '删除批注') : null,
            // 那句时间推到行尾：真机那一屏它紧贴着黑色主按钮，读起来像按钮的第二行字。
            h('span', { className: 'ac-faint', style: { marginLeft: 'auto' } },
              note.updatedAt ? `上次改于 ${fmtTime(note.updatedAt)}` : '还没有批注')),
          h(Notice, { msg: noteNote, kind: noteNote && noteNote.indexOf('失败') >= 0 ? 'err' : 'ok' })));
    }

    /**
     * Esc 关掉当前弹框。★ 单独拎成模块级函数（不藏在 useEffect 里）：用例直接调它就能验键盘口径，
     *   不必驱动 effect —— 与「交出去的回调必须被真调一次」同一条教训。
     */
    function escClose(e, onClose) {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) onClose();
    }

    /**
     * 详情对话框：唯一一处用户点出来的浮层（自动弹出的提示条仍然全场禁止，见 cl-36）。
     * 三条关闭路径：遮罩空白处、Esc、头部「关闭」。不做 sticky 顶栏，框内自己滚。
     */
    function DetailModal({ label, onClose, children }) {
      useEffect(() => {
        const onKey = (e) => escClose(e, onClose);
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      return h('div', {
        className: 'ac-modal-mask',
        // 只有点在遮罩自己身上才算"点框外"：冒泡上来的内部点击（选中一段文字起手的 mouseup 也算）不许关框。
        onClick: (e) => { if (e && e.target !== e.currentTarget) return; onClose(); },
      }, h('div', {
        className: 'ac-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': label,
        tabIndex: -1, autoFocus: true,
      }, children));
    }

    /** ★ 2026-10-06：这一层不再管详情的编辑载荷（那些进了挂在根上的 DetailModal），只剩「哪一行开着」。 */
    function CatalogTab({ snap, filters, onFilter, more, onMore, result, loading, loadingMore, err, listErr, openSlug,
      onRow, onLoadMore }) {
      const rows = result?.rows || [];
      const cats = catMap(snap);
      const dirty = !!(filters.auth.length || filters.https.length || filters.cors.length || filters.category || filters.q);
      return h('div', { className: 'ac-cat' },
        h(CategoryRail, { snap, category: filters.category, onPick: (v) => onFilter({ category: v }) }),
        h('div', { className: 'ac-main' },
          h('div', { className: 'ac-tools' },
            h('input', {
              className: 'ac-q',
              type: 'search',
              value: filters.q,
              placeholder: '搜名称 / 用途 / 主机名',
              title: '多个词是「且」的关系；中文按子串匹配（不是分词）',
              onChange: (ev) => onFilter({ q: ev.target.value }),
            })),
          h(FacetFilter, {
            snap, sel: filters, onToggle: (field, value) => onFilter({ field, value }),
            more, onMore, presets: cfg().presets || [], presetCounts: snap?.presets || {},
            onPreset: (p) => onFilter({ preset: p }), onClear: () => onFilter({ clear: true }), dirty,
          }),
          loading ? h('div', { className: 'ac-sub' }, '正在查…') : null,
          err ? h(Notice, { msg: err, kind: 'err' }) : null,
          // 「下一页没接上」落在结果卡里：点「继续加载」失败后必须还看得见自己点了什么、为什么没成。
          // 不弹层、不自动消失（与根上那条同步回执同一个口径）。
          listErr ? h(Notice, { msg: listErr, kind: 'err' }) : null,
          h('div', { className: 'ac-card' },
            h('div', { className: 'ac-card-h' },
              h('span', { className: 'ac-card-t' }, '结果'),
              h('span', { className: 'ac-card-n ac-num' },
                result ? `${fmtCount(result.total)} 条命中` : '—',
                // 有下一页时不说「只列前 N 条」——那句话在旧版是死路（没有继续加载的入口）。
                // 现在入口在卡底，卡头只报命中数。
                result && result.total ? ` · 已显示 ${fmtCount(rows.length)}` : '')),
            rows.length || loadingMore
              // 详情不占列表的位置（在根上的对话框里）：这一层就只管行，选中态由 openSlug 标。
              ? h(ResultList, {
                  rows, cats, expandedSlug: openSlug, onRow,
                  loadingMore, onLoadMore, hasMore: !!result?.hasMore,
                  shown: rows.length, total: result?.total || 0,
                })
              : h('div', { className: 'ac-cardfill' },
                  // 三种空态要说得不一样：把「读不出」说成「没有条目」或「条件太严」都是谎报。
                  h('div', { className: 'ac-empty' },
                    !snap ? '快照还没到：推流与读接口都没答上，原因看页头那条状态。'
                      : !snap.index?.total ? '库里还没有条目：点页头「立即同步」跑第一轮。'
                        : '这个条件下没有条目：换一个词，或清空筛选看全表。')),
            h('p', { className: 'ac-note' }, cfg().parseNote || ''))));
    }

    // ------------------------------------------------------------
    // 6b) 常用API 页签（壳）
    // ------------------------------------------------------------
    /**
     * 常用API —— 只有几格读数，没有解释（2026-10-07 两道裁定：先「只做壳，频率来源待指定」，
     * 再看真机截图裁定「这些废话去掉行不行」⇒ 那张说"为什么没有名次"的卡连同三句长话一起撤）。
     *
     * 界面上不解释自己：名次那一格为什么空着，是**图纸与 §9.1p 该记的事**，不是屏上那几行字 ——
     * 撤掉的屏障句记在这儿，免得下一轮有人以为是漏写的：`974 / 459` 这两个数在屏上没有"这是筛出来的子集"那句话陪着，
     * 读起来就像"常用"。这是用户在看过对照之后选的口径（页签名字照旧不改）。
     *
     * 留下的每一格仍然全部来自服务端：条数与分类数出自 `GET /api/snapshot` 的 index，
     * 两档子集的名字出自载荷 presets，条件由载荷 facets 现拼（facetLabelOf 走 authLabels / httpsLabels / corsLabels）
     * ⇒ 换一份载荷这几格都跟着变，写死一个数字就是把某一天的实测值当永远的实话（判据 cl-55）。
     * 这一页也不新增入口：那两档条目本来就在「目录」页签「快捷」那一行里（与 2026-10-05「聚合条撤掉」同一条口径）。
     */
    function CommonTab({ snap }) {
      const presets = cfg().presets || [];
      /** 快照没到就是「数不出」，不是 0：0 是一个真读数，会把它说成"库里什么都没有"。 */
      const num = (v) => (snap ? fmtCount(v) : '—');
      const condOf = (p) => Object.entries(p?.facets || {}).map(([f, v]) => facetLabelOf(f, v)).join(' + ');
      const idx = snap?.index || {};
      return h('div', { className: 'ac-panel' },
        h('div', { className: 'ac-card' },
          h('div', { className: 'ac-card-h' },
            h('span', { className: 'ac-card-t' }, '全库'),
            h('span', { className: 'ac-card-n ac-num' },
              snap ? `${fmtCount(idx.total)} 条 · ${fmtCount(idx.categories)} 类` : '—')),
          h('div', { className: 'ac-card-b' },
            presets.length
              ? presets.map((p) => h('div', { key: p.id, className: 'ac-ukv' },
                  h('span', { className: 'ac-faint' }, p.label),
                  h('span', { className: 'ac-num' }, `${num(snap?.presets?.[p.id])} 条`),
                  h('span', { className: 'ac-sub' }, `· ${condOf(p)}`)))
              : h('div', { className: 'ac-empty' }, '载荷里没有预设档'))));
    }

    // ------------------------------------------------------------
    // 7) 变更页签
    // ------------------------------------------------------------
    /**
     * 变更页签。★ 2026-10-06 用户真机走查（截图圈了整块内容）：「这里就叫变更记录，不要叫什么差分流水，
     *   直接显示变更记录列表在这就可以，不要显示一堆废话在这里」⇒ 这一页只剩种类芯片 + 列表。
     *   被撤走的「解析台账」那张卡（十个键 + 三个能力位 + 「没有代理开关」「没有重建库按钮」两句实话）
     *   按同一轮裁定「界面上彻底不摆」：不挪去设置页、也不做成收起态，只在 `GET /api/snapshot` 里读得到。
     *   ★ 这一条**推翻** 2026-10-05 的「从设置页挪到变更页」（那次的理由是"只读诊断别混进可改设置"），
     *     两句实话原文照抄在 docs/design-spec.md §9.1n，界面从此不回答「为什么没有那个按钮」。
     *   失败原因没跟着丢：页头那枚状态在失败时会把 `meta.lastError` 挂在它后面（Header 那一发）。
     */
    function ChangesTab({ rows, cats, kind, err, onKind }) {
      const kinds = cfg().changeKindChips || [];
      return h('div', { className: 'ac-panel' },
        err ? h(Notice, { msg: err, kind: 'err' }) : null,
        h('div', { className: 'ac-card' },
          h('div', { className: 'ac-card-h' },
            h('span', { className: 'ac-card-t' }, '变更记录'),
            // 只报这一页有多少条。旧那句「（库里最多 200 行）」是废话：库本来就只留那么多，
            // 列表画的就是库里全部，那句话既不提醒截断，也没地方能翻到第 201 行。
            h('span', { className: 'ac-card-n ac-num' }, `${(rows || []).length} 条`)),
          h('div', { className: 'ac-row', style: { padding: '8px 14px 0' } },
            h('button', { className: `ac-chip${!kind ? ' on' : ''}`, onClick: () => onKind('') }, '全部'),
            kinds.map((k) => h('button', { key: k, className: `ac-chip${kind === k ? ' on' : ''}`, onClick: () => onKind(k) }, kindLabel(k)))),
          (rows || []).length
            ? h('ul', { className: 'ac-tl' }, rows.map((r) => h('li', { key: r.id, 'data-kind': r.kind },
                h('span', { className: 'ac-kicker' }, kindLabel(r.kind)),
                h('div', { className: 'ac-tl-body' },
                  r.name || r.slug || '',
                  r.category ? h('span', { className: 'ac-sub', title: catZh(cats, r.category) ? r.category : '' },
                    ` · ${catZh(cats, r.category) || r.category}`) : null,
                  r.detail ? h('div', { className: 'ac-sub' }, r.detail) : null),
                h('span', { className: 'ac-ago' }, fmtTime(r.at)))))
            : h('div', { className: 'ac-empty' }, '还没有变更记录：跑一轮同步，上游有增减才会往这里写。'),
          h('p', { className: 'ac-note' }, '只记本机看到的差别；上游删了条目时批注不跟着删，留在「我的笔记」里。')));
    }

    // ------------------------------------------------------------
    // 8) 我的笔记页签
    // ------------------------------------------------------------
    const NOTE_VIEWS = [
      { id: 'all', label: '全部' },
      { id: 'starred', label: '置顶' },
      { id: 'tags', label: '有标签' },
      { id: 'orphan', label: '上游已删' },
    ];

    /**
     * 我的笔记页。★ 2026-10-05 跟着目录页一起从表格改成列表行 ——
     *   原来那张三列表在窄面板下同样要横向滚动，而「我的用途说明」是这一页唯一的正文，
     *   恰恰是被挤到需要滚动才能读全的那一列。
     */
    function NotesTab({ rows, cats, view, onView, err, exporting, exportText, onExport, onOpen, canDownload }) {
      return h('div', { className: 'ac-panel' },
        err ? h(Notice, { msg: err, kind: 'err' }) : null,
        h('div', { className: 'ac-card' },
          h('div', { className: 'ac-card-h' },
            h('span', { className: 'ac-card-t' }, '我的笔记'),
            h('span', { className: 'ac-card-n ac-num' }, `${(rows || []).length} 条`)),
          h('div', { className: 'ac-row', style: { padding: '8px 14px 0' } },
            NOTE_VIEWS.map((v) => h('button', {
              key: v.id, className: `ac-chip${view === v.id ? ' on' : ''}`, onClick: () => onView(v.id),
            }, v.label)),
            h('button', { className: 'ac-btn', style: { marginLeft: 'auto' }, disabled: exporting, onClick: onExport },
              exporting ? '导出中…' : '导出 JSON')),
          (rows || []).length
            ? h('div', { className: 'ac-list' }, rows.map((n) => h('div', {
                key: n.slug, className: 'ac-li', onClick: () => onOpen(n),
              },
                h('div', { className: 'ac-li-main' },
                  h('div', { className: 'ac-li-top' },
                    h('span', { className: 'ac-nm' }, n.entry?.name || n.name || n.slug.split('::').slice(1).join('::')),
                    h('span', { className: 'ac-cat-tag', title: catZh(cats, n.category) ? `上游原文 ${n.category}` : '' },
                      catZh(cats, n.category) || n.category),
                    n.orphan ? h('span', { className: 'ac-orphan' }, '上游已删') : null),
                  h('div', { className: 'ac-desc' },
                    n.purpose || '（还没写用途说明）',
                    (n.tags || []).length
                      ? h('span', null, n.tags.map((t, i) => h('span', { key: `${n.slug}-t${i}`, className: 'ac-tag' }, t)))
                      : null)),
                h('div', { className: 'ac-flags' },
                  n.starred ? h('span', { className: 'ac-flag' }, '★ 置顶') : null,
                  h('span', { className: 'ac-faint' }, fmtAgo(n.updatedAt))))))
            : h('div', { className: 'ac-empty' }, '这个视图里没有笔记：去目录里展开一行，就地写两句。'),
          h('p', { className: 'ac-note' }, '笔记是你的：上游删条目只把它标成「上游已删」，不跟着删。')),
        exportText ? h('div', { className: 'ac-card' },
          h('div', { className: 'ac-card-h' },
            h('span', { className: 'ac-card-t' }, '导出内容'),
            canDownload ? h('span', { className: 'ac-card-n' }, '已下载为 api-catalog-notes.json') : null),
          h('div', { className: 'ac-card-b' },
            h('textarea', { className: 'ac-export', readOnly: true, value: exportText }),
            canDownload ? null : h('div', { className: 'ac-sub' }, '这个环境里下载不了：上面是全量笔记原文，选中复制走。')))
          : null);
    }

    // ------------------------------------------------------------
    // 9) 设置页签
    // ------------------------------------------------------------
    /**
     * 「中文说明」那一卡（S9）。
     *
     * 为什么整卡可以不存在：`t` 是快照里的现译状态块，宿主半边没起来时它是 null —— 这时**一个控件都不摆**。
     * 摆半套（开关在、状态读不出来）比不摆更坏：用户按了保存而没人消费，界面还会说"已保存"。
     * 口径同"没有 webServer 就一个入口都不推"。
     *
     * ★ 三条不许漂的规矩：
     *  · 凭据输入框**永不回填**：库里那一份浏览器半边拿不到（secrets 表零 GET 路由），
     *    留空 = 不改动，删只能按「清除」。placeholder 与边界话术都读载荷，不在这里写；
     *  · 载荷说"这一档没接线"（implemented:false）的渠道点不动，但照样列出来 —— 隐藏的档位等于让用户以为少一档；
     *    2026-10-06 用户裁定三家必须接入后，现树五档全是 true，所以这一支平时在屏幕上看不见（判据 cl-42 用改过的载荷测它）；
     *  · 开关与渠道走 POST /prefs（与「保存设置」同一张表），凭据与两次动作走 POST /api/translate/*。
     *    两半各存各的，所以这一卡自己有一份 draft、自己有一枚保存按钮：共用一份草稿会出现
     *    "改了间隔又按保存现译设置 ⇒ 间隔那句改动静默丢失"。
     */
    function TranslateCard({ t, draft, onDraft, saving, onSave, note, isErr,
      cred, onCred, onSecret, onClearSecret, onTest, onRun, testing, running }) {
      if (!t) return null;
      const channels = cfg().transChannels || [];
      const credFields = cfg().transCredFields || {};
      const proxyModes = cfg().proxyModes || [];
      const proxyLabels = cfg().proxyModeLabels || {};
      const proxyHints = cfg().proxyModeHints || {};
      const on = draft?.transEnabled === true;
      const chosen = String(draft?.transChannel || t.channel);
      // 草稿没铺出来之前念出厂档（同 transEnabled 那一支）：transport.via 是"这一发从哪条路出去的"，
      // 不是"设置选了哪一档"，拿它当默认值会把一次直连显示成"选了直连"。
      const proxyMode = String(draft?.proxyMode || cfg().defaults?.proxyMode || 'system');
      const cur = channels.find((c) => c.id === chosen) || {};
      const fields = credFields[chosen] || [];
      const secs = t.secrets || {};
      // 状态行念的是**库里已存的那一档**（t.*），不是草稿：draft 可能还没保存，而"发不发得出去"是服务端的事实。
      const savedMissing = t.implemented === true && t.needsKey === true
        ? (credFields[t.channel] || []).filter((f) => !secs[t.channel]?.[f.id]?.configured).map((f) => f.label) : [];
      const counts = t.counts || {};
      const pass = t.lastPass;
      return h('div', { className: 'ac-card' },
        h('div', { className: 'ac-card-h' },
          h('span', { className: 'ac-card-t' }, '中文说明'),
          h('span', { className: 'ac-card-n' },
            `内置已备 ${fmtCount(cfg().builtinTransCount)} 句 · 本机现译 ${fmtCount(counts.ok)} 句 · 失败 ${fmtCount(counts.failed)} 句`)),
        h('div', { className: 'ac-card-b ac-set' },
          h('div', { className: 'ac-faint' }, cfg().transSettingsNote || ''),
          h('div', { className: 'ac-sec first' },
            h('div', { className: 'ac-sec-t' }, '用哪一档译'),
            h('div', { className: 'ac-ukv' },
              h('span', { className: 'k' }, '现译'),
              h('div', { className: 'ac-row v' },
                [false, true].map((v) => h('button', {
                  key: String(v), className: `ac-chip${on === v ? ' on' : ''}`, onClick: () => onDraft({ transEnabled: v }),
                }, v ? '启用' : '不启用')))),
            h('div', { className: 'ac-ukv' },
              h('span', { className: 'k' }, '渠道'),
              h('div', { className: 'ac-row v' }, channels.map((c) => h('button', {
                key: c.id,
                className: `ac-chip${chosen === c.id ? ' on' : ''}`,
                disabled: c.implemented !== true,
                title: c.implemented === true ? `${c.quota}｜${c.note}` : `未接入：${c.note}`,
                onClick: () => onDraft({ transChannel: c.id }),
              }, `${c.label}${c.implemented === true ? '' : ' · 未接入'}`)))),
            // 状态行：把"这一发到底发得出去吗"的两条前置说清楚，而不是等用户点完才知道。
            // ★ 这里不出现 'host_llm' / 'keyless' 这类渠道 id：判"是不是宿主模型那一档"用的是载荷里的 llmReady
            //   （非该档时为 null），判"这一档要不要凭据"用的是 needsKey ⇒ 加一档不用改界面。
            h('div', { className: 'ac-sub' },
              t.implemented !== true
                ? `库里这一档（${t.label}）还没接进来：${t.note || '没给原因'}`
                : t.llmReady !== null
                  ? `宿主模型：${t.llmReady ? '就绪（这一档走宿主的模型，不出网到第三方）' : '宿主没给出模型服务（这一档发不出去）'}`
                  : t.needsKey !== true
                    // 免密钥又真出网的档（免费接口）：这一行是它唯一的前置 —— 走没走代理、从哪儿取到地址。
                    // 摆"凭据已填齐"是假话（那一档压根没有凭据可填），摆"就绪"更假（直连实测发不出去）。
                    ? `出网：${t.transport?.line || '还没试过这一发'}`
                    : savedMissing.length
                      ? `还缺：${savedMissing.join('、')}（缺着的时候一句都不发，原文照给）`
                      : '凭据已填齐')),
          // 出网代理（S16）。★ 这一行整卡都在，不按渠道分档显示：四家官方接口 + 免费接口出的是同一道闸，
          //   给"只有免费接口才看得见"会让用户以为换一档就不用管代理（换百度一样要过这台机器的网络）。
          h('div', { className: 'ac-sec' },
            h('div', { className: 'ac-sec-t' }, '现译出网'),
            h('div', { className: 'ac-ukv' },
              h('span', { className: 'k' }, '代理'),
              h('div', { className: 'ac-row v' }, proxyModes.map((m) => h('button', {
                key: m,
                className: `ac-chip${proxyMode === m ? ' on' : ''}`,
                title: proxyHints[m] || '',
                onClick: () => onDraft({ proxyMode: m }),
              }, proxyLabels[m] || m)))),
            // 选中那一档的条件写在屏幕上（不只挂悬停）：不念它，「跟随系统」就会被读成"一定走代理"。
            h('div', { className: 'ac-sub' }, `条件：${proxyHints[proxyMode] || '这一档没给说明'}`),
            proxyMode === 'custom'
              ? h('div', { className: 'ac-field' },
                  h('label', null, '代理地址'),
                  h('input', {
                    type: 'text',
                    value: draft?.proxyUrl ?? '',
                    placeholder: `形如 127.0.0.1:7897（最长 ${fmtCount(cfg().proxyUrlMax)} 字）`,
                    autoComplete: 'off', spellCheck: 'false',
                    onChange: (ev) => onDraft({ proxyUrl: ev.target.value }),
                  }))
              : null,
            h('div', { className: 'ac-faint' }, cfg().proxyUrlBoundary || ''),
            h('div', { className: 'ac-faint' }, '只管现译那几发。抓取那一路照旧直连（源候选逐档实测直连就通，不换传输层）。')),
          // 凭据区只在"这一档要凭据而且接进来了"时出现：给宿主模型那一档摆两个输入框就是纯粹的误导。
          (on && cur.implemented === true && cur.needsKey === true)
            ? h('div', { className: 'ac-sec' },
                h('div', { className: 'ac-sec-t' }, '凭据'),
                h('div', { className: 'ac-credlist' },
                  fields.map((f) => {
                    const key = `${chosen}.${f.id}`;
                    const shape = secs[chosen]?.[f.id] || {};
                    return h('div', { className: 'ac-credrow', key },
                      h('div', { className: 'ac-field' },
                        h('label', null, shape.configured ? `${f.label}（已配置 · ${shape.chars} 位 · ${fmtAgo(shape.at)}）` : f.label),
                        h('input', {
                          // 密钥那一档按 password 收：粘贴进去之后屏幕上是一串点，但值仍在内存里、一按「存入」就进本机的 secrets 表。
                          type: f.secret === true ? 'password' : 'text',
                          value: cred[key] ?? '', placeholder: shape.configured ? (cfg().secretSavedHint || '')
                            : (f.hint ? `${f.hint}（这一栏可以不填，最长 ${f.max} 字）` : `填 ${f.label}（最长 ${f.max} 字）`),
                          autoComplete: 'off', spellCheck: 'false',
                          onChange: (ev) => onCred(key, ev.target.value),
                        })),
                      h('div', { className: 'ac-row' },
                        h('button', {
                          className: 'ac-mini', disabled: !String(cred[key] ?? '').trim(),
                          onClick: () => onSecret(chosen, f.id, f.label),
                        }, shape.configured ? '覆盖' : '存入'),
                        shape.configured
                          ? h('button', { className: 'ac-mini', onClick: () => onClearSecret(chosen, f.id, f.label) }, '清除')
                          : null));
                  })),
                h('div', { className: 'ac-faint' }, cfg().transCredBoundary || ''))
            : null,
          h('div', { className: 'ac-sec' },
            h('div', { className: 'ac-sec-t' }, '保存与试发'),
            h('div', { className: 'ac-row' },
              h('button', {
                // 这一卡的字段全清单就这四个：开关、渠道、代理模式、代理地址。多带一个间隔就等于替用户按下「保存设置」。
                className: 'ac-btn ac-btn-primary', disabled: saving,
                onClick: () => onSave({ transEnabled: on, transChannel: chosen, proxyMode, proxyUrl: draft?.proxyUrl ?? '' }),
              }, saving ? '保存中…' : '保存现译设置'),
              h('button', { className: 'ac-btn', disabled: testing || running, onClick: onTest }, testing ? '测试中…' : '测试连接'),
              h('button', {
                className: 'ac-btn', disabled: running || testing || !on,
                title: on ? '' : '开关没开，这一发按「现译开关没开」收口',
                onClick: onRun }, running ? '正在补…' : '立即补齐')),
            h(Notice, { msg: note, kind: isErr ? 'err' : 'ok' }),
            h('div', { className: 'ac-faint' },
              `${cfg().transCooldownNote || ''}一次最多补 ${fmtCount(cfg().transMaxPerRound)} 句，剩下的下一轮接着补。` +
              (pass
                ? ` 上一轮：${pass.skipped ? `跳过（${transErrLabel(pass.skipped)}）`
                  : `请求 ${fmtCount(pass.requested)} 发 · 成功 ${fmtCount(pass.ok)} · 失败 ${fmtCount(pass.failed)} · 还剩 ${fmtCount(pass.remaining)} 句${pass.capped ? '（这轮到了上限）' : ''}`} · ${fmtAgo(pass.at)}`
                : ''))),
          // 现译的进度不在这里挂轮询：写完一句宿主就推一帧快照，这一卡的两个数字跟着那帧走。
          t.busy ? h('div', { className: 'ac-faint' }, '现译正在跑（每写进一句都会刷一次这里的数字）') : null));
    }

    /**
     * 设置页。只留**用户真能改的**两项（检查间隔、抓取源顺序）+ 一张报事实的「这份目录里有什么」。
     *   「没有重建库按钮」「代理要用 --use-env-proxy」「载荷版本号」这三句实话的去处改过两次：
     *   2026-10-05 从这一页挪到变更页的「解析台账」（理由：只读诊断混在可改设置里，会让人以为那儿能改）；
     *   2026-10-06 那张卡整个从界面撤掉（用户裁定「界面上彻底不摆」），于是这一页也不再挂指向它的那句提示。
     *   ★ 两句实话的原文没删，照抄在 docs/design-spec.md §9.1n；界面从此不回答「为什么没有那个按钮」。
     */
    function SettingsTab({ snap, draft, onDraft, saving, prefsNote, prefsErr, syncing,
      onSave, onSync, intervalLabels, sources, sourceRejected, trans }) {
      const intervals = cfg().checkIntervals || [];
      const order = draft.sourcePriority || [];
      return h('div', { className: 'ac-panel' },
        h('div', { className: 'ac-card' },
          h('div', { className: 'ac-card-h' }, h('span', { className: 'ac-card-t' }, '检查间隔')),
          h('div', { className: 'ac-card-b ac-set' },
            h('div', { className: 'ac-row' },
              intervals.map((m) => h('button', {
                key: m,
                className: `ac-chip${Number(draft?.intervalMin) === Number(m) ? ' on' : ''}`,
                onClick: () => onDraft({ intervalMin: Number(m) }),
              }, (intervalLabels || {})[m] || `${m} 分钟`)),
              h('button', { className: 'ac-btn ac-btn-primary', disabled: saving, onClick: () => onSave(draft) }, saving ? '保存中…' : '保存设置')),
            h('div', { className: 'ac-faint' }, '多久去上游读一次。改动要按「保存设置」才落库。'),
            h(Notice, { msg: prefsNote, kind: prefsErr ? 'err' : 'ok' }))),
        h('div', { className: 'ac-card' },
          h('div', { className: 'ac-card-h' },
            h('span', { className: 'ac-card-t' }, '抓取源顺序'),
            h('span', { className: 'ac-card-n' }, '按顺序试，前一个失败才走下一个')),
          h('div', { className: 'ac-card-b ac-src' },
            order.map((id, i) => {
              const s = (sources || []).find((x) => x.id === id) || { id, label: id, note: '' };
              return h('div', { className: 'ac-src-i', key: id },
                h('span', { className: 'idx' }, String(i + 1)),
                h('span', { className: 'lb' }, s.label),
                h('span', { className: 'nt', title: s.note || '' }, s.note || ''),
                h('span', { className: 'mv' },
                  h('button', { className: 'ac-mini', disabled: i === 0, onClick: () => onDraft({ moveUp: i }) }, '上移'),
                  h('button', { className: 'ac-mini', disabled: i === order.length - 1, onClick: () => onDraft({ moveDown: i }) }, '下移')));
            }),
            h('div', { className: 'ac-faint' },
              `不用的源：${(sourceRejected || []).map((r) => `${r.id}（${r.reason}）`).join('；') || '无'}`),
            // 「立即同步一轮」原来在设置页这张卡里。页头那枚已经能做同一件事，
            // 两个入口说同一句话，用户就得猜该点哪个（点错了还得看回执才知道生效没有）。
            h('div', { className: 'ac-faint' }, '要立刻跑一轮，点页头的「立即同步」。'))),
        h(TranslateCard, { key: 'trans', ...trans }),
        h('div', { className: 'ac-card' },
          h('div', { className: 'ac-card-h' }, h('span', { className: 'ac-card-t' }, '这份目录里有什么')),
          h('div', { className: 'ac-card-b' },
            h('div', { className: 'ac-sub' },
              `库里 ${fmtCount(snap?.index?.total)} 条 / ${fmtCount(snap?.index?.categories)} 类；我的批注 ${fmtCount(snap?.notes?.total)} 条，其中上游已删 ${fmtCount(snap?.notes?.orphan)} 条。`))));
    }

    // ------------------------------------------------------------
    // 10) 图标 + 页面
    // ------------------------------------------------------------
    function CatalogPanelIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor' },
        h('path', { d: 'M2.5 3.5h4.2c.7 0 1.3.6 1.3 1.3v7.7', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M13.5 3.5H9.3c-.7 0-1.3.6-1.3 1.3', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M6.2 6.4h3.6', strokeWidth: 1.4, strokeLinecap: 'round' }));
    }

    const EMPTY_FILTERS = () => ({ q: '', category: '', auth: [], https: [], cors: [] });

    /** 预设档点进去 = 把它的 facets 变成 chips 的选择（判定式在服务端，这里只搬载荷里的那组条件）。 */
    function applyPreset(filters, preset) {
      const next = { ...filters, auth: [...filters.auth], https: [...filters.https], cors: [...filters.cors] };
      const want = preset?.facets || {};
      for (const field of ['auth', 'https', 'cors']) {
        if (!(field in want)) continue;
        const v = String(want[field]);
        next[field] = [...new Set([...next[field], v])];
      }
      return next;
    }

    function tagsToText(tags) { return (tags || []).join(','); }
    function textToTags(text) {
      return String(text ?? '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    }

    function CatalogPage() {
      const [snap, setSnap] = useState(null);
      const [conn, setConn] = useState({ ok: false, note: '' });
      const [tab, setTab] = useState(DEFAULT_TAB);
      const [filters, setFilters] = useState(EMPTY_FILTERS);
      const [result, setResult] = useState(null);
      const [searching, setSearching] = useState(false);
      const [searchErr, setSearchErr] = useState('');
      const [more, setMore] = useState({});          // 每组 facet 的「更多」展开态（UI 态，不进请求）
      const [loadingMore, setLoadingMore] = useState(false);
      const [listErr, setListErr] = useState('');
      const [detail, setDetail] = useState(null);        // { slug, entry }
      const [detailLoading, setDetailLoading] = useState(false);
      const [detailErr, setDetailErr] = useState('');
      const [draft, setDraft] = useState({});
      const [saving, setSaving] = useState(false);
      const [noteNote, setNoteNote] = useState('');
      const [notes, setNotes] = useState(null);
      const [notesView, setNotesView] = useState('all');
      const [notesErr, setNotesErr] = useState('');
      const [exportText, setExportText] = useState('');
      const [exporting, setExporting] = useState(false);
      const [changes, setChanges] = useState(null);
      const [changesKind, setChangesKind] = useState('');
      const [changesErr, setChangesErr] = useState('');
      const [prefsDraft, setPrefsDraft] = useState(null);
      const [savingPrefs, setSavingPrefs] = useState(false);
      const [prefsNote, setPrefsNote] = useState('');
      const [prefsErr, setPrefsErr] = useState(false);
      const [syncing, setSyncing] = useState(false);
      const [syncNote, setSyncNote] = useState('');
      const [syncErr, setSyncErr] = useState('');
      // ★ S9「中文说明」那一卡的本地态。草稿与上面的 prefsDraft **分开**：一张草稿两个保存按钮
      //   会静默丢掉没按的那一侧的改动（用户改了间隔又按「保存现译设置」= 间隔白改）。
      const [transDraft, setTransDraft] = useState(null);
      const [savingTrans, setSavingTrans] = useState(false);
      const [transNote, setTransNote] = useState('');
      const [transIsErr, setTransIsErr] = useState(false);
      const [credDraft, setCredDraft] = useState({});
      const [testingCh, setTestingCh] = useState(false);
      const [runningTrans, setRunningTrans] = useState(false);
      const searchSeq = useRef(0);
      const detailSeq = useRef(0);
      const timer = useRef(null);

      useStream(setSnap, setConn);

      // ---------- 搜索：输入停顿 250 ms 才发（打一个字发一发会把宿主问烦） ----------
      const loadSearch = useCallback(async (f) => {
        const seq = (searchSeq.current += 1);
        setSearching(true); setSearchErr('');
        try {
          const r = await api(`/search${searchQs(f)}`);
          if (searchSeq.current !== seq) return;
          setResult(r);
        } catch (e) {
          if (searchSeq.current !== seq) return;
          setSearchErr(`查不动：${e?.message ?? e}`);
        } finally {
          if (searchSeq.current === seq) setSearching(false);
        }
      }, []);

      useEffect(() => {
        // 不 gate 在 snap 上：存储坏掉时快照永远不来，界面就不能因此连一句「查不动」都不说（诚实降级）。
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { loadSearch(filters); }, 250);
        return () => { if (timer.current) clearTimeout(timer.current); };
      }, [filters, snap, loadSearch]);

      /**
       * 服务端回传的游标。★ 必须用 ref 而不是直接读 result：
       *   loadMore 是 useCallback([])（空依赖），闭包里的 result 是**第一次渲染那一份**，
       *   永远停在首屏 —— 于是每点一次「继续加载」都拿同一个起点，反复取回第 2 页。
       *   （症状：点了按钮，列表长度一直卡在 200 不动。）
       *   ★ ref 必须声明在 loadMore **之前**：const 有暂时性死区，写在后面看着能跑，
       *   但任何在首帧就走到 loadMore 的分支都会踩到（cl-35b 就是这么红的）。
       */
      const cursorOffset = useRef(0);
      const cursorLimit = useRef(0);

      /**
       * 「继续加载」：**追加**而不是替换。
       * ★ 游标以服务端回传的 offset/limit 为准（q-e3 钉着），前端不许拿 rows.length 猜 ——
       *   服务端把 limit 夹到 200 之后，界面那份 rows.length 与真正的下一起点可能不是同一个数。
       * ★ 换筛选条件时游标清零：offset 是在**排序后的全集**上的位置，
       *   新条件下同一个 offset 指向的是另一批条目（沿用旧游标等于跳过一片）。
       * ★ 失败必须落在页面内（列表卡上就地一条），不弹层、不自动消失，
       *   而且**不清空已经显示的行** —— 失败不该毁掉已经看到的。
       */
      const loadMore = useCallback(async (base) => {
        setLoadingMore(true); setListErr('');
        const next = (cursorOffset.current || 0) + (cursorLimit.current || 0);
        try {
          const r = await api(`/search${searchQs({ ...base, offset: next })}`);
          setResult((prev) => (prev && Array.isArray(r.rows)
            ? { ...prev, rows: [...prev.rows, ...r.rows], offset: r.offset, limit: r.limit, hasMore: r.hasMore, total: r.total }
            : r));
        } catch (e) {
          setListErr(`下一页没接上：${e?.message ?? e}`);
        } finally {
          setLoadingMore(false);
        }
      }, []);
      useEffect(() => {
        if (result && Number.isFinite(Number(result.offset))) cursorOffset.current = Number(result.offset);
        if (result && Number.isFinite(Number(result.limit))) cursorLimit.current = Number(result.limit);
      }, [result]);

      const onFilter = (patch) => {
        setFilters((f) => {
          if (patch.clear) return EMPTY_FILTERS();
          if (patch.preset) return applyPreset(f, patch.preset);
          if (patch.category !== undefined) return { ...f, category: patch.category };
          if (patch.q !== undefined) return { ...f, q: patch.q };
          const field = patch.field;
          if (!field) return f;
          const list = f[field] || [];
          const next = list.includes(patch.value) ? list.filter((x) => x !== patch.value) : [...list, patch.value];
          return { ...f, [field]: next };
        });
        // 换条件 = 回到第一页：旧游标在新结果集上指的是另一批条目。
        cursorOffset.current = 0;
        setListErr('');
      };

      // ---------- 行详情 ----------
      /**
       * @param force 从「我的笔记」跳回来时必须开：这一条可能正是上一次展开过的那条，
       *              走"再点同一行就收起"那一支会把用户从笔记送回一个收起着的目录。
       */
      async function openDetail(row, force) {
        if (!force && detail && detail.slug === row.slug) { setDetail(null); setDraft({}); return; }
        const seq = (detailSeq.current += 1);
        setDetail({ slug: row.slug, entry: null });
        setDetailLoading(true); setDetailErr(''); setNoteNote('');
        try {
          const r = await api(`/entry?slug=${encodeURIComponent(row.slug)}`);
          if (detailSeq.current !== seq) return;
          setDetail({ slug: row.slug, entry: r.entry });
          setDraft({});
        } catch (e) {
          if (detailSeq.current !== seq) return;
          setDetail({ slug: row.slug, entry: null });
          setDetailErr(`这一条读不出：${e?.message ?? e}`);
        } finally {
          if (detailSeq.current === seq) setDetailLoading(false);
        }
      }
      function closeDetail() {
        detailSeq.current += 1;
        setDetail(null); setDraft({}); setNoteNote(''); setDetailErr('');
      }
      /** 行详情的草稿：只有这一条的四个字段。设置页的草稿走 onPrefsDraft，两边不共用一个入口。 */
      const onDraft = useCallback((patch) => {
        setDraft((d) => ({ ...d, ...patch }));
      }, []);

      async function saveNote(entry, d) {
        setSaving(true); setNoteNote('');
        try {
          const body = { slug: entry.slug, category: entry.category };
          if (d.purpose !== undefined) body.purpose = d.purpose;
          if (d.tags !== undefined) body.tags = textToTags(d.tags);
          if (d.starred !== undefined) body.starred = d.starred;
          if (d.hidden !== undefined) body.hidden = d.hidden;
          if (body.purpose === undefined && body.tags === undefined && body.starred === undefined && body.hidden === undefined) {
            body.purpose = d.purpose ?? entry.note?.purpose ?? '';
          }
          const saved = await post('/notes', body);
          setDetail({ slug: entry.slug, entry: { ...entry, note: saved } });
          setDraft({});
          setNoteNote(`已保存（${fmtTime(saved.updatedAt)}）`);
          await refreshSnap(setSnap);
        } catch (e) {
          setNoteNote(`保存失败：${e?.message ?? e}`);
        } finally {
          setSaving(false);
        }
      }

      async function deleteNote(slug) {
        setSaving(true); setNoteNote('');
        try {
          await post('/notes/delete', { slug });
          setDetail({ slug, entry: { ...(detail?.entry || {}), slug, note: null } });
          setDraft({});
          setNoteNote('批注已删除');
          await refreshSnap(setSnap);
        } catch (e) {
          setNoteNote(`删除失败：${e?.message ?? e}`);
        } finally {
          setSaving(false);
        }
      }

      // ---------- 变更页签 ----------
      const loadChanges = useCallback(async (kind) => {
        setChangesErr('');
        try {
          const r = await api(`/changes${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
          setChanges(r.rows || []);
        } catch (e) {
          setChangesErr(`流水读不出：${e?.message ?? e}`);
        }
      }, []);

      // 依赖里带 snap：后台那一轮跑完（用户可能正停在变更页看流水）得跟着重读，
      // 只有手点同步那一支在 doSync 里自己补，定时器那一支不管就永远停在旧流水上。
      useEffect(() => { if (tab === 'changes') loadChanges(changesKind); }, [tab, changesKind, loadChanges, snap]);

      // ---------- 笔记页签 ----------
      const loadNotes = useCallback(async (view) => {
        setNotesErr('');
        try {
          const r = await api(`/notes?view=${encodeURIComponent(view)}`);
          setNotes(r.rows || []);
        } catch (e) {
          setNotesErr(`笔记读不出：${e?.message ?? e}`);
        }
      }, []);

      useEffect(() => { if (tab === 'notes') loadNotes(notesView); }, [tab, notesView, loadNotes, snap]);

      /** 下载能力位：Blob + createObjectURL 都在才谈得上"点了就落盘"，否则导出只剩那段可复制的原文。 */
      const canDownload = typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';

      async function exportNotes() {
        setExporting(true);
        try {
          const rows = await api('/notes?view=all');
          const text = JSON.stringify({ exportedAt: nowMs(), keyRule: snap?.meta?.keyRule ?? null, notes: rows.rows ?? [] }, null, 2);
          setExportText(text);
          if (canDownload) {
            const blob = new Blob([text], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'api-catalog-notes.json';
            a.rel = 'noreferrer';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL?.(a.href), 1000);
          }
        } catch (e) {
          setNotesErr(`导出失败：${e?.message ?? e}`);
        } finally {
          setExporting(false);
        }
      }

      // ---------- 设置页签 ----------
      useEffect(() => {
        if (!snap?.prefs) return;
        setPrefsDraft((d) => (d ? d : { intervalMin: snap.prefs.intervalMin, sourcePriority: [...(snap.prefs.sourcePriority || [])] }));
      }, [snap]);

      function onPrefsDraft(patch) {
        setPrefsDraft((d) => {
          const base = d || snap?.prefs || cfg().defaults || { intervalMin: null, sourcePriority: [] };
          if (patch.moveUp !== undefined || patch.moveDown !== undefined) {
            const list = [...(base.sourcePriority || [])];
            const i = patch.moveUp !== undefined ? patch.moveUp : patch.moveDown;
            const j = patch.moveUp !== undefined ? i - 1 : i + 1;
            if (j < 0 || j >= list.length) return base;
            const t = list[i]; list[i] = list[j]; list[j] = t;
            return { ...base, sourcePriority: list };
          }
          return { ...base, ...patch };
        });
        setPrefsNote(''); setPrefsErr(false);
      }

      async function savePrefs(patch) {
        setSavingPrefs(true); setPrefsNote(''); setPrefsErr(false);
        try {
          const saved = await post('/prefs', patch);
          setPrefsDraft({ intervalMin: saved.intervalMin, sourcePriority: [...(saved.sourcePriority || [])] });
          await refreshSnap(setSnap);
          setPrefsNote(`已保存（间隔 ${saved.intervalMin} 分钟）`);
        } catch (e) {
          setPrefsErr(true);
          setPrefsNote(`保存失败：${e?.message ?? e}`);
        } finally {
          setSavingPrefs(false);
        }
      }

      // ---------- 现译：设置页「中文说明」那一卡 ----------
      // 草稿只铺一次（同 prefsDraft）：正在打的凭据框不能被推流帧冲掉。
      useEffect(() => {
        if (!snap?.prefs) return;
        setTransDraft((d) => (d ? d : {
          transEnabled: snap.prefs.transEnabled === true, transChannel: snap.prefs.transChannel,
          proxyMode: snap.prefs.proxyMode, proxyUrl: snap.prefs.proxyUrl || '',
        }));
      }, [snap]);

      function onTransDraft(patch) {
        setTransDraft((d) => ({ ...(d || snap?.prefs || {}), ...patch }));
        setTransNote(''); setTransIsErr(false);
      }

      /** 渠道 id → 载荷里那一句 label（未登记的值就原样念出来，界面不猜中文名）。 */
      const transChannelLabel = (id) => (cfg().transChannels || []).find((c) => c.id === id)?.label || String(id || '没选渠道');

      async function saveTrans(d) {
        setSavingTrans(true); setTransNote(''); setTransIsErr(false);
        try {
          // 只发这四项：prefs 那张表是读-并-写，但「保存现译设置」不该把没保存的间隔也一起带上（用户会以为按哪枚都一样）。
          const saved = await post('/prefs', {
            transEnabled: d.transEnabled === true, transChannel: d.transChannel,
            proxyMode: d.proxyMode, proxyUrl: String(d.proxyUrl ?? '').trim(),
          });
          setTransDraft({
            transEnabled: saved.transEnabled === true, transChannel: saved.transChannel,
            proxyMode: saved.proxyMode, proxyUrl: saved.proxyUrl || '',
          });
          await refreshSnap(setSnap);
          const proxyLabels = cfg().proxyModeLabels || {};
          setTransNote(`已保存：${saved.transEnabled === true ? `启用现译 · ${transChannelLabel(saved.transChannel)}` : '不启用现译（一句都不发）'}`
            + ` · 出网代理：${proxyLabels[saved.proxyMode] || saved.proxyMode}`);
        } catch (e) {
          setTransIsErr(true); setTransNote(`保存失败：${e?.message ?? e}`);
        } finally {
          setSavingTrans(false);
        }
      }

      function onCred(key, v) { setCredDraft((c) => ({ ...c, [key]: v })); }

      async function saveSecret(channel, field, label) {
        const key = `${channel}.${field}`;
        const value = String(credDraft[key] ?? '').trim();
        setTransNote(''); setTransIsErr(false);
        try {
          await post('/translate/secret', { channel, field, value });
          setCredDraft((c) => ({ ...c, [key]: '' }));   // 存完就把手上这份清掉：界面上不该再留一份值
          await refreshSnap(setSnap);
          setTransNote(`已存入「${label || field}」（${value.length} 位）。值不会再回到这里，要改就再粘一次，要删按「清除」。`);
        } catch (e) {
          setTransIsErr(true); setTransNote(`没存进去：${e?.message ?? e}`);
        }
      }

      async function clearSecret(channel, field, label) {
        setTransNote(''); setTransIsErr(false);
        try {
          await post('/translate/secret/delete', { channel, field });
          await refreshSnap(setSnap);
          setTransNote(`已清除「${label || field}」：这一档缺它的时候一句都不发，原文照给。`);
        } catch (e) {
          setTransIsErr(true); setTransNote(`清除没成：${e?.message ?? e}`);
        }
      }

      async function testChannel() {
        setTestingCh(true); setTransNote(''); setTransIsErr(false);
        try {
          const r = await post('/translate/test', {});
          const res = r?.result || {};
          if (res.ok) setTransNote(res.note || '这一档可用');
          else { setTransIsErr(true); setTransNote(res.note || transErrLabel(res.errKey)); }
          await refreshSnap(setSnap);
        } catch (e) {
          setTransIsErr(true); setTransNote(`测试没成：${e?.message ?? e}`);
        } finally {
          setTestingCh(false);
        }
      }

      async function runTrans() {
        setRunningTrans(true); setTransNote(''); setTransIsErr(false);
        try {
          const r = await post('/translate/run', {});
          const p = r?.result || {};
          setTransNote(p.skipped ? `这一轮没跑：${transErrLabel(p.skipped)}`
            : `这一轮：请求 ${fmtCount(p.requested)} 发 · 成功 ${fmtCount(p.ok)} · 失败 ${fmtCount(p.failed)} · 还剩 ${fmtCount(p.remaining)} 句`
              + `${p.capped ? '（到了单轮上限，再按一次接着补）' : ''}`);
          await refreshSnap(setSnap);
        } catch (e) {
          setTransIsErr(true); setTransNote(`补齐没成：${e?.message ?? e}`);
        } finally {
          setRunningTrans(false);
        }
      }

      async function doSync() {
        setSyncing(true); setSyncNote(''); setSyncErr('');
        try {
          const r = await post('/sync', {});
          const res = r?.result || {};
          setSyncNote(res.status === 'success' ? '这一轮跑完，目录已更新'
            : res.status === 'noChange' ? '跑完了：上游内容没变'
              : `这一轮：${res.reason || res.code || '没说原因'}`);
        } catch (e) {
          if (e?.code === cfg().syncBusyCode) setSyncErr('上一轮同步还没结束，这一发被跳过（不并发跑第二轮）');
          else setSyncErr(`同步没成：${e?.message ?? e}`);
        } finally {
          setSyncing(false);
          // 不在这儿补一发 loadChanges：refreshSnap 换了 snap 对象，变更页那个 effect 会跟着重读（补一发就是两发）。
          await refreshSnap(setSnap);
        }
      }

      async function refreshAll() {
        try {
          setSnap(await api('/snapshot'));
          setConn((c) => ({ ...c, note: '' }));
        } catch (e) {
          setConn({ ok: false, note: `快照读不出：${e?.message ?? e}` });
        }
      }

      const cats = catMap(snap);
      let panel;
      if (tab === 'settings') {
        panel = h(SettingsTab, {
          snap, draft: prefsDraft || snap?.prefs || cfg().defaults || {},
          onDraft: onPrefsDraft, saving: savingPrefs, prefsNote, prefsErr,
          onSave: (d) => savePrefs({ intervalMin: d.intervalMin, sourcePriority: d.sourcePriority }),
          intervalLabels: cfg().intervalLabels, sources: cfg().sources, sourceRejected: cfg().sourceRejected,
          trans: {
            t: snap?.translate, draft: transDraft || snap?.prefs || {}, onDraft: onTransDraft,
            saving: savingTrans, onSave: saveTrans, note: transNote, isErr: transIsErr,
            cred: credDraft, onCred, onSecret: saveSecret, onClearSecret: clearSecret,
            onTest: testChannel, onRun: runTrans, testing: testingCh, running: runningTrans,
          },
        });
      } else if (tab === 'common') {
        panel = h(CommonTab, { snap });
      } else if (tab === 'changes') {
        panel = h(ChangesTab, {
          rows: changes, cats, kind: changesKind, err: changesErr,
          onKind: setChangesKind,
        });
      } else if (tab === 'notes') {
        panel = h(NotesTab, {
          rows: notes, cats, view: notesView, onView: setNotesView, err: notesErr,
          exporting, exportText, onExport: exportNotes, canDownload,
          onOpen: (n) => { setTab('catalog'); openDetail({ slug: n.slug, name: n.entry?.name || n.slug }, true); },
        });
      } else {
        panel = h(CatalogTab, {
          snap, filters, onFilter, more, onMore: (f) => setMore((m) => ({ ...m, [f]: !m[f] })),
          result: result || snap?.result, loading: searching, loadingMore,
          err: searchErr, listErr, openSlug: detail?.slug,
          onRow: openDetail, onLoadMore: () => loadMore(filters),
        });
      }

      // 详情对话框：挂在根上、不在列表里（所以条目被后台那一轮筛掉、或页签长到要滚，都不影响它说话）。
      // ★ 换页签时它不渲染但状态留着：草稿还在，回到目录那一格还是开着的。
      const detailEl = detail ? h(RowDetail, {
        detail, cats, draft, loading: detailLoading, err: detailErr, saving, noteNote,
        onDraft, onSave: saveNote, onDelete: deleteNote, onClose: closeDetail,
      }) : null;

      return h('div', { className: 'ac-root' },
        h('div', { className: 'ac-topbar' },
          // 「重新连接」接的就是原来那枚「刷新」的位置与职责：推流断了才出现，点它重取一份快照。
          // 推流正常时它不存在（常驻一枚灰按钮只是摆设，见 Header 的注释）。
          h(Header, { snap, conn, syncing, onSync: doSync, onReconnect: refreshAll }),
          h(TabBar, { tab, onTab: (t) => setTab(goTab(t, tab)), snap })),
        // 回执落在根上：页头的「立即同步」每一页都点得到，把它写在设置页里等于「点了没反应」。
        (syncNote || syncErr) ? h(Notice, { msg: syncErr || syncNote, kind: syncErr ? 'err' : 'ok' }) : null,
        panel,
        tab === 'catalog' && detailEl
          ? h(DetailModal, { key: 'detail-modal', label: `条目详情 ${detail?.entry?.name || detail?.slug || ''}`, onClose: closeDetail }, detailEl)
          : null);
    }

    // ------------------------------------------------------------
    // 11) apply：入口注册
    // ------------------------------------------------------------
    function apply(ctx) {
      if (!cfg().routePrefix) return;   // 没路由前缀 = 没 webServer：一个入口都不注册（点开全是 404 的面板比看不到入口更糟）
      ctx.effect(() => injectStyle(), 'api-catalog:style');
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER(), label: () => cfg().label || '免费 API 目录' },
          CatalogPanelIcon,
        ));
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, CatalogPage));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.PANEL_ID = PANEL_ID;
    exports.__test = {
      cfg, API_BASE, CSS, STYLE_ID, injectStyle, searchQs, consumeSse, api, post, refreshSnap,
      fmtAgo, fmtTime, fmtMinute, fmtCount, flagClass, flagLabel, authLabel, flagShort, authShort,
      facetShort, facetLabelOf, kindLabel, statusLabel, FACET_DEFS, FACET_SHORT,
      TAB_DEFS, TAB_IDS, DEFAULT_TAB, goTab, tabCounts, NOTE_VIEWS, EMPTY_FILTERS, applyPreset,
      tagsToText, textToTags, catMap, catZh,
      // ★ 这份清单必须跟着版式改版一起换：2026-10-05 改版时漏了它，
      //   症状是沙箱加载期直接抛「FacetChips is not defined」，**44 条用例一起红**，
      //   看起来像整体崩了，实际只是导出清单里还挂着三个已被删掉的组件名。
      //   ——「枚举早暴露了没人渲染」的同族：这里是一份没人维护的清单，成了加载期的地雷。
      components: {
        Header, Notice, TabBar, CategoryRail, FacetFilter, ResultList, RowDetail, CatalogTab, CommonTab,
        ChangesTab, NotesTab, SettingsTab, CatalogPanelIcon, CatalogPage,
      },
    };
    // 宿主 ModuleLoader 吃 factory 的**返回值**当模块导出：返回 module 会让外层取不到 apply
    // （真机报 invalid plugin, received object —— modelwatch 踩过）。
    return module.exports;
  },
});
