/* tmp/ac-shot-scrolled.mjs —— v3 的视觉证据：同一屏在「列表滚到底」前后各拍一张，
 * 用来核对用户第五张截图那两句（搜索框不许滚走 / 只滚下面那个框）。
 * 跑法：node test/make-prototype.mjs && node tmp/ac-shots.mjs && node tmp/ac-shot-scrolled.mjs
 * 产物：tmp/_acshot/v3-<状态>-滚前|滚后.png。用完即删。 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { connect } from './cdp-lib.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9226;
const SHOT_DIR = 'F:\\dsh-plugins\\dsh-plugin-api-catalog\\tmp\\_acshot';
const CELL_H = 870;
const STATES = ['06-目录-整页', '05-目录-点开一行', '01-变更-变更记录'];

const profile = fs.mkdtempSync(`${fs.realpathSync(os.tmpdir())}/ac-v3shot-`);
const proc = cp.spawn(CHROME, [
  '--headless=old', `--remote-debugging-port=${PORT}`, '--allow-file-access-from-files', '--disable-gpu',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1440,970', 'about:blank',
], { stdio: 'ignore' });

// 把目标状态滚进视口、套上宿主格子的壳，返回格子在视口里的矩形（captureScreenshot 的 clip 用视口坐标）
const setup = (cellH) => {
  const sec = document.querySelector('section.shot');
  sec.scrollIntoView({ block: 'start' });
  sec.querySelector('.hostcell').style.setProperty('--cell-h', cellH + 'px');
  const c = sec.querySelector('.hostcell').getBoundingClientRect();
  return { x: Math.max(0, Math.round(c.x)), y: Math.max(0, Math.round(c.y)), w: Math.round(c.width), h: Math.round(c.height) };
};

const scrollActive = () => {
  const s = [...document.querySelectorAll('section.shot .ac-root *')].find((el) => {
    const cs = getComputedStyle(el);
    return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
  });
  if (!s) return 'none';
  s.scrollTop = s.scrollHeight;
  return s.className.split(' ')[0];
};

const b = await connect(PORT);
for (const name of STATES) {
  await b.goto(`file:///${SHOT_DIR.replace(/\\/g, '/')}/${name}.html`);
  const box = await b.eval(setup, CELL_H);
  const clip = { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 };
  const shot = async (tag) => {
    const png = `${SHOT_DIR}\\v3-${name}-${tag}.png`;
    const r = await b.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    fs.writeFileSync(png, Buffer.from(r.data, 'base64'));
    return png;
  };
  await new Promise((r) => setTimeout(r, 200));
  await shot('滚前');
  const which = await b.eval(scrollActive);
  await new Promise((r) => setTimeout(r, 200));
  const png = await shot('滚后');
  console.log(`${name} 滚的是「${which}」 ⇒ ${png} (${fs.statSync(png).size}B)`);
}
b.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 还攥着 profile：无害 */ }
