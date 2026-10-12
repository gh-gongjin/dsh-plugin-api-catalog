/**
 * tmp/probe-rail.mjs —— 量分类栏这两个问题：① 只显示 18/51 类 ② 那个框滚不动。
 *
 * 关键在于**模拟宿主主列的滚动模型**：宿主主列是 overflow:hidden 的滚动容器
 * （技能 §41 记过），所以真实环境里存在**两层滚动**：页面外层 + 分类栏内层。
 * 截图工具（--window-size 那套）没有外层滚动容器，量出来的行为与真机不同 ——
 * 这就是"原型上看着没事、真机上滚不动"的来源。
 *
 * 这里用两层盒子复刻：外层 fixed 高 + overflow:auto（宿主主列），内层放 .ac-root。
 */
import cp from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = new URL('../prototype/index.html', import.meta.url);
const OUT = new URL('../tmp/_rail/', import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

const html = fs.readFileSync(SRC, 'utf8');
const head = html.slice(0, html.indexOf('<div class="proto">'));
const protoOpen = html.slice(html.indexOf('<div class="proto">'), html.indexOf('<section class="shot">'));
const parts = html.split('  <section class="shot">').slice(1);
const body = parts[5];
const section = '  <section class="shot">' + body.slice(0, body.lastIndexOf('</section>') + '</section>'.length);
const plain = `${head}${protoOpen}${section}\n</div>\n</body>\n</html>\n`;

// 宿主外壳：外层就是那个 overflow:auto 的主列
const hostShell = (inner, h) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
/* 宿主主列：固定视口高 + 自己滚动（技能 §41：真机抓到宿主主列 overflow:hidden） */
#host{height:${h}px;overflow-y:auto;overflow-x:hidden;background:#f4f4f6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.pad{padding:24px 20px 60px}
</style></head><body><div id="host"><div class="pad">${inner}</div></div>
<script>
window.addEventListener('load', () => setTimeout(() => {
  const out = [];
  const say = (s) => out.push(s);
  const host = document.getElementById('host');
  const rail = document.querySelector('.ac-rail');
  const list = document.querySelector('.ac-rail-list');
  const main = document.querySelector('.ac-main');
  const root= document.querySelector('.ac-root');
  if (!rail || !list) { say('没找到分类栏'); }
  else {
    const cs = getComputedStyle(list);
    const items = list.querySelectorAll('.ac-rail-i');
    say('分类项数=' + items.length);
    say('列表 clientHeight=' + list.clientHeight + ' scrollHeight=' + list.scrollHeight
      + ' ⇒ 内容溢出=' + (list.scrollHeight > list.clientHeight + 1 ? '是（这是内层滚动容器）' : '否'));
    say('列表 overflow-y=' + cs.overflowY + ' max-height=' + cs.maxHeight);
    say('rail 高=' + Math.round(rail.getBoundingClientRect().height)
      + '  main 高=' + Math.round(main.getBoundingClientRect().height)
      + '  ⇒ 左侧比右侧矮 ' + Math.round(main.getBoundingClientRect().height - rail.getBoundingClientRect().height) + 'px（下面那块空白）');
    say('最后一个分类项底缘=' + Math.round(items[items.length-1].getBoundingClientRect().bottom)
      + ' 列表底缘=' + Math.round(list.getBoundingClientRect().bottom)
      + ' ⇒ 藏起来 ' + (items.length - Math.round((list.clientHeight - (items[0].getBoundingClientRect().top - list.getBoundingClientRect().top)) / (items[1].getBoundingClientRect().height - items[0].getBoundingClientRect().height)) - 1) + ' 项');
  }
  // 外层滚动模型
  say('');
  say('【宿主主列】clientHeight=' + host.clientHeight + ' scrollHeight=' + host.scrollHeight
    + ' ⇒ 外层可滚=' + (host.scrollHeight > host.clientHeight + 1 ? '是' : '否'));
  say('文档 scrollWidth=' + document.documentElement.scrollWidth + ' /视口=' + window.innerWidth
    + ' ⇒ 横向溢出=' + (document.documentElement.scrollWidth > window.innerWidth + 1 ? '是' : '否'));
  // 滚轮：模拟指针在分类栏上滚，看内层还是外层动
  const r = rail ? rail.getBoundingClientRect() : null;
  if (r) {
    const x = r.left + r.width / 2, y = r.top + Math.min(120, r.height / 2);
    const el = document.elementFromPoint(x, y);
    say('');
    say('分类栏上 (' + Math.round(x) + ',' + Math.round(y) + ') 命中的是：' + (el ? el.className || el.tagName : 'null'));
    // 真实滚一格
    const hostBefore = host.scrollTop;
    const listBefore = list.scrollTop;
    const target = el || list;
    for (const type of ['wheel', 'mousewheel']) {
      target.dispatchEvent(new WheelEvent(type, { deltaY: 300, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }
    say('滚一格之后：内层 scrollTop ' + listBefore + '→' + list.scrollTop
      + '   外层 scrollTop ' + hostBefore + '→' + host.scrollTop);
    say('⇒ 滚轮被谁吃掉：' + (list.scrollTop > listBefore ? '内层（分类栏自己在滚）'
      : host.scrollTop > hostBefore ? '外层（页面在滚，分类栏跟着一起动）' : '没人（滚不动）'));
  }
  // sticky 检查：滚到下面，分类栏头还在不在
  host.scrollTop = 600;
  const rh = document.querySelector('.ac-rail-h');
  if (rh) {
    const b = rh.getBoundingClientRect();
    say('');
    say('外层滚到 600 后，分类栏头 top=' + Math.round(b.top)
      + (b.top < window.innerHeight && b.top > -5 ? '（仍在视口内）' : '（已滚出视口）'));
  }
  host.scrollTop = 0;
  const pre = document.createElement('pre');
  pre.style.cssText='position:fixed;left:0;bottom:0;z-index:99999;background:#000;color:#0f0;font:11px monospace;padding:6px;max-width:100%;white-space:pre-wrap';
  pre.textContent = out.join('\\n');
  document.body.appendChild(pre);
}, 400));
</script></body></html>`;

const results = [];
for (const H of [900, 1100]) {
  const file = `${OUT.pathname.replace(/^\//, '').replace(/\//g, '\\\\')}\\\\host-${H}.html`;
  fs.writeFileSync(file, hostShell(plain, H));
  const dom = cp.execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--virtual-time-budget=8000',
    `--window-size=1440,${H + 200}`, '--dump-dom', `file:///${file.replace(/\\/g, '/')}`,
  ], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
  const m = dom.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
  results.push(`\n===== 宿主主列高 ${H}px =====\n` + (m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : '(没读到)'));
  cp.execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=8000',
    `--window-size=1440,${H}`, `--screenshot=${file.replace(/\.html$/, '.png')}`,
    `file:///${file.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' });
}
console.log(results.join('\n'));
