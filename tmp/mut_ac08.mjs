/* tmp/mut_ac08.mjs —— 2026-10-06 v3「这个框不要滚动，只滚动下面这个框」这一批改动的**证伪**。
 * 九条，每条都还原一个"用户会看到的那个坏样子"，不是还原一行文本：
 *   F1 根又整块滚（回到 v2）           → 现场：根自己成了滚动容器（探针 root.scrollable=true，36 屏坏）+ cl-39 挂
 *   F6 两栏退回 align-items:flex-start → 现场：右栏按内容长高、尾巴滚不到（tail 两条都 false，8 屏坏）+ cl-39 挂
 *   F7 结果卡退回 flex:none            → 现场：同上（8 屏坏）+ cl-39 挂
 *   F3 撤掉分类栏的兜底滚动（矮格子）   → 现场：52 类裁掉且滚不到（探针 railAt0.ok=false，4 屏坏）+ cl-11c ② 挂
 *   F5 撤掉 .ac-panel>*{flex:none}     → 现场：变更/设置页卡片被压扁、内容裁掉（探针 orphanClips，7 屏坏）+ cl-39 挂
 *   F4 把 sticky 写回顶栏              → 现场：死规则回来（cl-11c ⑤ 与 cl-36 一起挂）
 *   F2 / F2b / F8 三处 min-height:0    → ★ 等价变异：用例挂，但 54 屏现场一点没变（理由见各条注释）。
 *     这三条留在这里是为了让下一轮别再误当"承重墙"，也是 cl-39 那句"链上每一环都有 min-height:0"的诚实边界。
 * 锚点在文件里必须恰好命中 1 次；跑完按字节还原并比 sha。任何一次"绿（没抓住）"就是本轮欠账。
 * 跑法：cd /f/dsh-plugins/dsh-plugin-api-catalog && node tmp/mut_ac08.mjs 2>&1 | tail -40
 *      只跑部分：MUT_ONLY=F1,F3
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = 'F:/dsh-plugins/dsh-plugin-api-catalog';
const FILE = `${ROOT}/client.js`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 << 20 });

const MUTS = [
  {
    id: 'F1', name: '根又整块滚（v2 那一版）',
    edits: [
      ['  height:100%;overflow:hidden;\n', '  height:100%;overflow-y:auto;overscroll-behavior:contain;\n'],
      ['.ac-cat{flex-direction:row;align-items:stretch;overflow:hidden}', '.ac-cat{flex-direction:row;align-items:stretch}'],
    ],
    expectCase: 'cl-39', expectProbe: /"root":\{[^}]*"scrollable":true/,
  },
  {
    // ★ 等价变异（实测）：删掉 .ac-list 的 min-height:0，54 屏现场一点没变 ——
    //   overflow 不是 visible 的盒子，自动最小尺寸按规范本来就是 0，这一发是保险不是承重墙。
    //   用例仍挂（cl-39 钉着它），所以它是"写法层的保险"，不是"几何层的判据"。
    id: 'F2', name: '主滚动层少 min-height:0（等价变异：现场不变）',
    edits: [['.ac-main>.ac-card>.ac-cardfill{flex:1 1 auto;min-height:0;overflow-y:auto',
      '.ac-main>.ac-card>.ac-cardfill{flex:1 1 auto;overflow-y:auto']],
    expectCase: 'cl-39', expectProbe: null, equivalent: true,
  },
  {
    // ★ 等价变异，同上：卡还能缩到 min-content（约 130px），列表照旧能滚、尾巴照旧够得着。
    id: 'F2b', name: '结果卡那一发 min-height:0（等价变异：现场不变）',
    edits: [['  .ac-main>.ac-card{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      '  .ac-main>.ac-card{flex:1 1 auto;display:flex;flex-direction:column}']],
    expectCase: 'cl-39', expectProbe: null, equivalent: true,
  },
  {
    id: 'F6', name: '两栏的 align-items 回到 flex-start（左栏/右栏不再等高）',
    edits: [['.ac-cat{flex-direction:row;align-items:stretch;overflow:hidden}',
      '.ac-cat{flex-direction:row;align-items:flex-start;overflow:hidden}']],
    expectCase: 'cl-39', expectProbe: /"tail":\{[^}]*"inCell":false,"coveredByScroller":false/,
  },
  {
    id: 'F7', name: '结果卡不放开 flex（flex:1 1 auto → flex:none）',
    edits: [['  .ac-main>.ac-card{flex:1 1 auto;min-height:0;', '  .ac-main>.ac-card{flex:none;min-height:0;']],
    expectCase: 'cl-39', expectProbe: /"tail":\{[^}]*"inCell":false,"coveredByScroller":false/,
  },
  {
    id: 'F8', name: '.ac-main 的 min-height:0 删掉（等价变异：现场不变，见下面 F2 那条注释）',
    edits: [['.ac-main{flex:1 1 auto;min-width:0;min-height:0}', '.ac-main{flex:1 1 auto;min-width:0}']],
    expectCase: null, expectProbe: null, equivalent: true,
  },
  {
    id: 'F3', name: '撤掉分类栏的兜底滚动',
    edits: [['    flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}', '    flex:1 1 auto;min-height:0}']],
    expectCase: 'cl-11c', expectProbe: /"railAt0":\{[^}]*"ok":false/,
  },
  {
    id: 'F5', name: '撤掉 .ac-panel>*{flex:none}（卡片被压进滚动容器）',
    edits: [['\n.ac-panel>*{flex:none}', '']],
    expectCase: 'cl-39', expectProbe: /"orphanClips":\["/,
  },
  {
    id: 'F4', name: '把 sticky 写回顶栏',
    edits: [['.ac-topbar{background:var(--ac-card);flex:none;', '.ac-topbar{position:sticky;top:0;z-index:2;background:var(--ac-card);flex:none;']],
    expectCase: 'cl-11c', expectProbe: null,
  },
];

const original = fs.readFileSync(FILE);
const baseSha = sha(original);
const only = (process.env.MUT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
let missed = 0;
let uncovered = 0;
try {
  for (const m of MUTS) {
    if (only.length && !only.includes(m.id)) continue;
    let text = original.toString('utf8');
    for (const [from, to] of m.edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`${m.id} 锚点命中 ${n} 次（要恰好 1 次）：${from.slice(0, 40)}`);
      text = text.replace(from, to);
    }
    if (text === original.toString('utf8')) throw new Error(`${m.id} 改动没落地（替换前后一模一样）`);
    fs.writeFileSync(FILE, text);
    const t = run('node', ['test/client.test.mjs']).stdout;
    const failed = (t.match(/^FAIL\s+(\S+)/gm) || []).map((s) => s.split(/\s+/)[1]);
    const passLine = (t.match(/\[client\] pass \d+ \/ fail \d+ \/ skip \d+/) || [''])[0];
    // 空输出不是"通过"：套件崩了（语法错、抛在 harness 外面）也会 match 不到这一行，
    // 那一发的 caught 就会因为 failed 为空而报漏网 —— 看着像"抓住了"其实是没跑成。
    if (!passLine) throw new Error(`${m.id} 套件没跑出汇总行（多半是崩了，不是判据挂）：\n${(t || '').slice(0, 400)}`);
    let probeLine = '（未量探针）';
    let probeCaught = false;
    if (m.expectProbe) {
      run('node', ['test/make-prototype.mjs']);
      run('node', ['tmp/ac-shots.mjs']);
      const p = run('node', ['tmp/ac-scroll.mjs', '870', '520']).stdout;
      const bad = (p.match(/\[坏 \d+ 屏\]/) || [''])[0];
      const hit = m.expectProbe.exec(p.replace(/\n/g, ' '));
      probeLine = `${bad} / 现场命中=${hit ? 'yes' : 'no'}`;
      probeCaught = !!hit && bad !== '[坏 0 屏]';
      if (!probeCaught) { missed++; probeLine += ' ← 探针没抓到'; }
    } else if (m.equivalent) {
      probeLine = '等价变异：现场不变（用例挂就够，几何量不到）';
    }
    // 没有 expectCase 又没有 expectProbe 的这一发，**不许**默认算抓住。
    // 上一版就是 `: true` 把 F8（`.ac-main` 那发 min-height:0）印成「红（抓住）」的 ——
    // 而它那一行明明白白写着 `pass 54 / fail 0` + 现场不变：没有任何证据，只有脚手架自己判的"抓住"。
    // 等价变异照实单列（灰），混进「漏网 0 条」就是自欺。
    const caught = m.expectCase ? failed.includes(m.expectCase) : probeCaught;
    if (!caught) { if (m.equivalent) uncovered++; else missed++; }
    console.log(`${caught ? '红（抓住）' : m.equivalent ? '灰（等价变异·现场不变·无判据钉这行文本）' : '绿（漏网）'} ${m.id} ${m.name}｜${passLine}｜挂:${failed.join(',') || '无'}｜要:${m.expectCase || '只看现场'}｜${probeLine}`);
    fs.writeFileSync(FILE, original);
    if (sha(fs.readFileSync(FILE)) !== baseSha) throw new Error(`${m.id} 还原后 sha 变了，停在这里`);
  }
} finally {
  fs.writeFileSync(FILE, original);
  console.log(`\n还原：sha ${baseSha} → ${sha(fs.readFileSync(FILE))} ${sha(fs.readFileSync(FILE)) === baseSha ? '一致' : '不一致（要手工查）'}`);
  console.log(`[漏网 ${missed} 条 / 等价变异但无判据可依 ${uncovered} 条]`);
}
