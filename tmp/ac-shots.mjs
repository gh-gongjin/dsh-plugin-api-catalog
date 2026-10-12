/* tmp/ac-shots.mjs —— 把图纸拆成一状态一张，逐张 headless Chrome 出图（S5 走查通道）。
   跑法：node tmp/ac-shots.mjs [高]（默认 900）。产物：tmp/_acshot/NN-<状态名>.html|png。用完即删。 */
import cp from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = new URL('../prototype/index.html', import.meta.url);
const OUT = new URL('../tmp/_acshot/', import.meta.url);
const W = 1440, H = Number(process.argv[2] || 900);

const html = fs.readFileSync(SRC, 'utf8');
const head = html.slice(0, html.indexOf('<div class="proto">'));
const protoOpen = html.slice(html.indexOf('<div class="proto">'), html.indexOf('<section class="shot">'));
const parts = html.split('  <section class="shot">').slice(1);
const slug = (s) => s.replace(/[\/\\:*?"<>|·]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

fs.mkdirSync(OUT, { recursive: true });
// 产物名是 `NN-<状态名>`：插一个新状态会把后面所有编号顶下去 ⇒ 上一轮的旧文件不会被覆盖，
// 会和新的一起留在目录里，而 tmp/ac-scroll.mjs 是**按目录现扫**的（名单不手抄），
// 于是走查屏数虚高、还有一批状态看不见得绿。每轮出图前先把这一格清干净。
for (const f of fs.readdirSync(OUT)) {
  if (/\.(html|png)$/.test(f)) fs.rmSync(new URL(f, OUT));
}
const dir = fs.mkdtempSync ? fs.realpathSync(new URL('.', OUT).pathname.replace(/^\//, '')) : '';
const files = [];
parts.forEach((body, i) => {
  const cap = body.match(/<b>([^<]+)<\/b>/)[1];
  const section = '  <section class="shot">' + body.slice(0, body.lastIndexOf('</section>') + '</section>'.length);
  const one = `${head}${protoOpen}${section}\n</div>\n</body>\n</html>\n`;
  const name = `${String(i).padStart(2, '0')}-${slug(cap)}`;
  const path = `${dir}\\${name}.html`;
  fs.writeFileSync(path, one);
  files.push({ name, path });
});

for (const f of files) {
  const png = f.path.replace(/\.html$/, '.png');
  cp.execFileSync(CHROME, [
    '--headless=old', '--allow-file-access-from-files', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${W},${H}`, '--virtual-time-budget=4000',
    `--screenshot=${png}`,
    'file:///' + encodeURI(f.path.replace(/\\/g, '/')),
  ], { stdio: 'ignore' });
  console.log(`${f.name}.png ${fs.statSync(png).size}B`);
}
