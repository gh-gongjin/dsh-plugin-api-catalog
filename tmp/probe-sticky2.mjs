/**
 * tmp/probe-sticky2.mjs —— 按外层 scrollTop 的梯度，看左栏在视口里的位置与可见分类数。
 *
 * 为什么不用 getBoundingClientRect 一次量就下结论：sticky 的表现必须**沿滚动过程**看。
 * 上一版只量了 scrollTop=0 与 scrollTop=max 两点，把「左栏随页面滚走了」当成 sticky 失效 ——
 * 实际上滚到底时它贴住的位置是对的（112），是探针读的那一次恰好在 .ac-cat 的末尾之后。
 */
import { connect } from './cdp-lib.mjs';
import cp from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const f = fs.realpathSync('tmp/_rail2/host.html').replace(/\\/g, '/');
const chrome = cp.spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let api;
try {
  api = await connect(PORT);
  await api.goto('file:///' + f, { settleMs: 800 });
  const at = (top) => api.eval((t) => {
    const host = document.getElementById('host');
    host.scrollTop = t;
    return new Promise((res) => setTimeout(() => {
      const rail = document.querySelector('.ac-rail').getBoundingClientRect();
      const items = document.querySelectorAll('.ac-rail-i');
      let vis = 0;
      for (const i of items) {
        const b = i.getBoundingClientRect();
        if (b.top < window.innerHeight && b.bottom > 0) vis += 1;
      }
      res({
        host: host.scrollTop, railTop: Math.round(rail.top), railBottom: Math.round(rail.bottom),
        visItems: vis, vh: window.innerHeight,
      });
    }, 200));
  }, top);
  console.log('外层scrollTop → 左栏视口top / 可见分类数 / 左栏底缘 / 视口高');
  for (const t of [0, 400, 1000, 2000, 4000, 5400, 6300]) {
    const r = await at(t);
    console.log(`  ${String(r.host).padStart(5)} → top=${String(r.railTop).padStart(5)} 可见=${String(r.visItems).padStart(2)}/52 底缘=${String(r.railBottom).padStart(5)} 视口高=${r.vh}`);
  }
} finally {
  chrome.kill();
  process.exit(0);
}
