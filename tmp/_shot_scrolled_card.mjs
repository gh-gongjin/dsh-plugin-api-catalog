/* tmp/_shot_scrolled_card.mjs —— 一次性走查：把图纸里「设置 · 中文说明（草稿态）」那一状态滚到凭据那一节再出图。
   图纸的壳是定高的（照抄宿主那一格），整张卡一屏装不下 ⇒ 看下半截只能滚。产物 tmp/_acshot/scroll-中文说明*.png */
import cp from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = fs.realpathSync(new URL('../prototype/index.html', import.meta.url));
const OUT_DIR = fs.mkdtempSync(`${fs.realpathSync(new URL('..', import.meta.url))}/tmp/_shotcard-`);
const html = fs.readFileSync(SRC, 'utf8');
const head = html.slice(0, html.indexOf('<div class="proto">'));
const protoOpen = html.slice(html.indexOf('<div class="proto">'), html.indexOf('<section class="shot">'));
const parts = html.split('  <section class="shot">').slice(1);

const pickIdx = (needle) => parts.findIndex((b) => b.includes(needle));
const idx = pickIdx('设置 · 中文说明（草稿态）');
if (idx < 0) throw new Error('图纸里没有那一状态');
const body = parts[idx];
const section = '  <section class="shot">' + body.slice(0, body.lastIndexOf('</section>') + '</section>'.length);
const inject = '<script>window.addEventListener("load",()=>{const s=document.querySelector(".ac-panel");if(s)s.scrollTop=430;});</script>';
const one = `${head}${protoOpen}${section}\n</div>\n${inject}\n</body>\n</html>\n`;
const p = `${OUT_DIR}\\card.html`;
fs.writeFileSync(p, one);
const png = `${OUT_DIR}\\card.png`;
cp.execFileSync(CHROME, [
  '--headless=old', '--allow-file-access-from-files', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,1000', '--virtual-time-budget=5000', `--screenshot=${png}`,
  'file:///' + encodeURI(p.replace(/\\/g, '/')),
], { stdio: 'ignore' });
console.log(png, fs.statSync(png).size, 'B');
