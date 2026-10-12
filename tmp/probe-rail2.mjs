/**
 * tmp/probe-rail2.mjs —— 用**真滚轮**（CDP Input.dispatchMouseEvent mouseWheel）复核三件事：
 *   ① 悬停在分类栏上滚，页面动不动（上一版用合成 WheelEvent 量出"两层都不动"，那是探针的错：
 *      合成事件不触发浏览器的默认滚动行为，量的是事件派发，不是滚动）；
 *   ② 51 类是不是全部可达（内层滚动容器撤掉之后不该再有内容被藏）；
 *   ③ sticky 的 top 写多少才对 —— 量出 .ac-topbar 的真实高度，不许猜。
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import { connect } from './cdp-lib.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = new URL('../prototype/index.html', import.meta.url);
const OUT = new URL('../tmp/_rail2/', import.meta.url);
const PORT = 9345;
fs.mkdirSync(OUT, { recursive: true });

const html = fs.readFileSync(SRC, 'utf8');
const head = html.slice(0, html.indexOf('<div class="proto">'));
const protoOpen = html.slice(html.indexOf('<div class="proto">'), html.indexOf('<section class="shot">'));
const parts = html.split('  <section class="shot">').slice(1);
const section = '  <section class="shot">' + parts[5].slice(0, parts[5].lastIndexOf('</section>') + '</section>'.length);
const inner = `${head}${protoOpen}${section}\n</div>`;

const shell = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;padding:0}
#host{height:900px;overflow-y:auto;overflow-x:hidden;background:#f4f4f6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.pad{padding:24px 20px 60px}
</style></head><body><div id="host"><div class="pad">${inner}</div></div></body></html>`;
const file = `${OUT.pathname.replace(/^\//, '').replace(/\//g, '\\\\')}\\\\host.html`;
fs.writeFileSync(file, shell);

const chrome = cp.spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let api;
try {
  api = await connect(PORT);
  await api.goto(`file:///${file.replace(/\\/g, '/')}`, { settleMs: 900 });
  await api.viewport(1440, 900);

  // ① 量 topbar 真实高度 + 分类栏初始几何
  const geo = await api.eval(() => {
    const tb = document.querySelector('.ac-topbar');
    const rail = document.querySelector('.ac-rail');
    const list = document.querySelector('.ac-rail-list');
    const main = document.querySelector('.ac-main');
    const host = document.getElementById('host');
    const items = list.querySelectorAll('.ac-rail-i');
    return {
      topbarH: Math.round(tb.getBoundingClientRect().height),
      railTop: Math.round(rail.getBoundingClientRect().top),
      railH: Math.round(rail.getBoundingClientRect().height),
      mainH: Math.round(main.getBoundingClientRect().height),
      items: items.length,
      listClient: list.clientHeight,
      listScroll: list.scrollHeight,
      listOverflowY: getComputedStyle(list).overflowY,
      railPos: getComputedStyle(rail).position,
      railTopCss: getComputedStyle(rail).top,
      hostScrollable: host.scrollHeight > host.clientHeight + 1,
      hostScrollH: host.scrollHeight,
      x: Math.round(rail.getBoundingClientRect().left + rail.getBoundingClientRect().width / 2),
      y: Math.round(rail.getBoundingClientRect().top + 100),
    };
  });

  // ② **真滚轮**：悬停在分类栏上派发 mouseWheel，看外层滚不滚
  const wheel = async (x, y, dy) => {
    await api.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse',
    });
    await new Promise((r) => setTimeout(r, 260));
  };
  const readTop = () => api.eval(() => ({
    host: document.getElementById('host').scrollTop,
    rail: document.querySelector('.ac-rail').getBoundingClientRect().top,
    tb: document.querySelector('.ac-topbar').getBoundingClientRect().top,
  }));

  const before = await readTop();
  await wheel(geo.x, geo.y, 400);
  const after1 = await readTop();
  await wheel(geo.x, geo.y, 600);
  const after2 = await readTop();

  // ③ 最后一个分类项能不能滚进视口
  const reach = await api.eval(() => {
    const host = document.getElementById('host');
    const items = document.querySelectorAll('.ac-rail-i');
    const last = items[items.length - 1];
    host.scrollTop = host.scrollHeight;
    return new Promise((res) => setTimeout(() => {
      const b = last.getBoundingClientRect();
      res({
        lastText: last.textContent.trim().slice(0, 20),
        lastTop: Math.round(b.top),
        lastBottom: Math.round(b.bottom),
        vh: window.innerHeight,
        visible: b.top < window.innerHeight && b.bottom > 0,
        railTop: Math.round(document.querySelector('.ac-rail').getBoundingClientRect().top),
        hostTop: host.scrollTop,
      });
    }, 300));
  });

  await api.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.writeFileSync(`${OUT.pathname.replace(/^\//, '').replace(/\//g, '\\\\')}\\\\scrolled.png`, Buffer.from(r.data, 'base64'));
  });

  console.log('【几何】');
  console.log(`  .ac-topbar 实高 = ${geo.topbarH}px  （sticky 的 top 必须 ≥ 它，否则会被盖住）`);
  console.log(`  当前写的 rail sticky top = ${geo.railTopCss}  position=${geo.railPos}`);
  console.log(`  分类项 ${geo.items} 个，列表 clientHeight=${geo.listClient} scrollHeight=${geo.listScroll} overflow-y=${geo.listOverflowY}`);
  console.log(`  ⇒ 内容被藏？${geo.listScroll > geo.listClient + 1 ? '是' : '否'}`);
  console.log(`  左栏高 ${geo.railH} / 右栏高 ${geo.mainH}`);
  console.log('');
  console.log('【真滚轮（悬停在分类栏上 x=' + geo.x + ' y=' + geo.y + '）】');
  console.log(`  起点   外层scrollTop=${before.host}  左栏top=${before.rail}`);
  console.log(`  滚 400 外层scrollTop=${after1.host}  左栏top=${after1.rail}   ${before.host === after1.host ? '← 没动' : '← 动了'}`);
  console.log(`  滚 600 外层scrollTop=${after2.host}  左栏top=${after2.rail}   ${after1.host === after2.host ? '← 没动' : '← 动了'}`);
  console.log(`  页头 top：${after2.tb}（负数=已随页面上滚，sticky 生效中）`);
  console.log('');
  console.log('【最后一类可达性（滚到底）】');
  console.log(`  末项「${reach.lastText}」top=${reach.lastTop} bottom=${reach.lastBottom} 视口高=${reach.vh}`);
  console.log(`  ⇒ 在视口内？${reach.visible ? '是（51 类全部可达）' : '否（有分类仍然够不到）'}`);
  console.log(`  滚到底时左栏 top=${reach.railTop}（应≈topbar 高度，不该是负数）`);
  console.log(`  外层可滚=${geo.hostScrollable} scrollHeight=${geo.hostScrollH}`);
} finally {
  try { api?.send?.('Browser.close'); } catch { /* 忽略 */ }
  chrome.kill();
}
