/* tmp/_s16-shot.mjs —— 临时：把设置页那两态的格子撑到全高，核对 S16 加的那两行（渠道芯片排第一 + 出网代理）。
   跑法：node test/make-prototype.mjs && node tmp/ac-shots.mjs && node tmp/_s16-shot.mjs
   产物：tmp/_acshot/s16-<状态名>.png。用完即删。 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { connect } from './cdp-lib.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9227;
const SHOT_DIR = 'F:\\dsh-plugins\\dsh-plugin-api-catalog\\tmp\\_acshot';
const STATES = ['04-设置', '05-设置-中文说明（草稿态）'];

const profile = fs.mkdtempSync(`${fs.realpathSync(os.tmpdir())}/ac-s16shot-`);
const proc = cp.spawn(CHROME, [
  '--headless=old', `--remote-debugging-port=${PORT}`, '--allow-file-access-from-files', '--disable-gpu',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1440,2200', 'about:blank',
], { stdio: 'ignore' });

const setup = () => {
  const sec = document.querySelector('section.shot');
  sec.scrollIntoView({ block: 'start' });
  const cell = sec.querySelector('.hostcell');
  cell.style.setProperty('--cell-h', '2050px');
  // 内容区在真机是靠 .ac-panel 滚的；这里把整格拉高只是为了让下面那几行进入视口，不改任何样式规则。
  const root = cell.querySelector('.ac-root');
  if (root) root.style.height = '2050px';
  const c = cell.getBoundingClientRect();
  return { x: Math.max(0, Math.round(c.x)), y: Math.max(0, Math.round(c.y)), w: Math.round(c.width), h: Math.round(c.height) };
};

const b = await connect(PORT);
for (const name of STATES) {
  await b.goto(`file:///${SHOT_DIR.replace(/\\/g, '/')}/${name}.html`);
  const box = await b.eval(setup);
  await new Promise((r) => setTimeout(r, 250));
  const png = `${SHOT_DIR}\\s16-${name}.png`;
  const r = await b.send('Page.captureScreenshot', {
    format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: Math.min(box.h, 2050), scale: 1 },
    captureBeyondViewport: false,
  });
  fs.writeFileSync(png, Buffer.from(r.data, 'base64'));
  console.log(`${name} ⇒ ${png} (${fs.statSync(png).size}B)`);
}
b.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 还攥着 profile：无害 */ }
