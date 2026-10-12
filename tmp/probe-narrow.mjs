/**
 * tmp/probe-narrow.mjs —— 量「窄面板下会不会横向溢出」+ 三处版式细节。
 *
 * 为什么要量而不靠看：改版式的核心主张是「列表行不用横向滚动」，
 * 而截图工具默认 1440px 宽 —— 真机评审常在~430~500px 的窄面板里看，
 * 那一档如果溢出，claim 就是假的。
 *
 * 三处细节（截图里看出来的，但量得出来才敢改）：
 *  ① 「更多 N」紧跟在最后一枚芯片后面，没有视觉分隔 ⇒ 读起来像上一枚的计数后缀；
 *  ② 状态标签右对齐，与名称之间留了一大片空白（名称短的时候尤其明显）；
 *  ③ 分类栏「收起」与「51 类 · 2018 条」挤在一行。
 */
import cp from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = new URL('../prototype/index.html', import.meta.url);
const OUT = new URL('../tmp/_acnarrow/', import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

const html = fs.readFileSync(SRC, 'utf8');
const head = html.slice(0, html.indexOf('<div class="proto">'));
const protoOpen = html.slice(html.indexOf('<div class="proto">'), html.indexOf('<section class="shot">'));
const parts = html.split('  <section class="shot">').slice(1);
const body = parts[5];
const cap = body.match(/<b>([^<]+)<\/b>/)[1];
const section = '  <section class="shot">' + body.slice(0, body.lastIndexOf('</section>') + '</section>'.length);
const one = `${head}${protoOpen}${section}\n</div>\n</body>\n</html>\n`;

const probe = `
<script>
window.addEventListener('load', () => {
  const root = document.querySelector('.ac-root');
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const out = [];
  const say = (s) => out.push(s);
  say('视口宽=' + vw + '  文档scrollWidth=' + doc.scrollWidth + '  横向溢出=' + (doc.scrollWidth > vw + 1 ? '是' : '否'));
  const r = root.getBoundingClientRect();
  const p = root.parentElement;
  say('根 box-sizing=' + getComputedStyle(root).boxSizing + '  根宽=' + Math.round(r.width)
    + '  父内容盒=' + p.clientWidth + '  根超出父=' + (Math.round(r.width) > p.clientWidth + 1 ? '是' : '否'));
  // 逐个量：超宽的元素（排除滚动容器内的，那是设计如此）
  const wide = [...document.querySelectorAll('#root *, .ac-root *')]
    .filter((el) => el.getBoundingClientRect().width > vw + 1)
    .map((el) => el.className + '=' + Math.round(el.getBoundingClientRect().width));
  say('超宽元素数=' + wide.length + (wide.length ? ' → ' + wide.slice(0, 5).join(', ') : ''));
  // 三处细节
  const auth = [...document.querySelectorAll('.ac-fg')].find((g) => /鉴权/.test(g.textContent));
  if (auth) {
    const chips = [...auth.querySelectorAll('.ac-chip')];
    const more = auth.querySelector('.ac-more');
    const last = chips[chips.length - 1];
    say('鉴权组：芯片' + chips.length + '枚，更多按钮=' + (more ? more.textContent : '无'));
    if (more && last) {
      const a = last.getBoundingClientRect(), b = more.getBoundingClientRect();
      say('  末枚芯片右缘=' + Math.round(a.right) + ' 「更多」左缘=' + Math.round(b.left) + ' 间距=' + Math.round(b.left - a.right) + 'px');
      const cs = getComputedStyle(last);
      say('  末枚芯片 margin-right=' + cs.marginRight + '（0 ⇒ 与「更多」之间没有任何视觉分隔）');
    }
  }
  // 名称与状态标签之间的距离
  const li = document.querySelector('.ac-li');
  if (li) {
    const main = li.querySelector('.ac-li-main');
    const flags = li.querySelector('.ac-flags');
    say('行内：主体宽=' + Math.round(main.getBoundingClientRect().width)
      + ' 状态区宽=' + Math.round(flags.getBoundingClientRect().width)
      + ' 主体与状态间距=' + Math.round(flags.getBoundingClientRect().left - main.getBoundingClientRect().right) + 'px');
  }
  // 分类栏头
  const rh = document.querySelector('.ac-rail-h');
  if (rh) say('分类栏头：' + rh.textContent.trim().replace(/\\s+/g, ' '));
  const pre = document.createElement('pre');
  pre.id = 'dbg';
  pre.style.cssText = 'word-break:break-all;max-width:100%;overflow:hidden;font-size:11px';
  pre.textContent = out.join('\\n');
  document.body.appendChild(pre);
});
</script>
`;

const p2 = one.replace('</body>', `${probe}</body>`);
const name = cap.replace(/[\/\\:*?"<>|·]/g, '').replace(/\s+/g, '-');
const file = `${OUT.pathname.replace(/^\//, '').replace(/\//g, '\\\\')}\\\\${name}.html`;
fs.writeFileSync(file, p2);
const png = file.replace(/\.html$/, '.png');
for (const W of [1440, 900, 520, 430]) {
  const out = png.replace(/\.png$/, `-${W}.png`);
  cp.execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--virtual-time-budget=6000', `--window-size=${W},1100`,
    `--screenshot=${out}`, `file:///${file.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' });
  console.log(`出图 ${W}px → ${out}`);
}
console.log('\n诊断:');
cp.execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--virtual-time-budget=6000', '--window-size=1440,1100',
  '--dump-dom', `file:///${file.replace(/\\/g, '/')}`,
], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
const dom = cp.execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--virtual-time-budget=6000', '--window-size=1440,1100',
  '--dump-dom', `file:///${file.replace(/\\/g, '/')}`,
], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
const m = dom.match(/<pre id="dbg">([\s\S]*?)<\/pre>/);
console.log(m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '(没读到诊断块)');
