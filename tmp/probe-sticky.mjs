import { connect } from './cdp-lib.mjs';
import cp from 'node:child_process';
import fs from 'node:fs';
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9346;
const f=fs.realpathSync('tmp/_rail2/host.html').replace(/\\/g,'/');
const chrome=cp.spawn(CHROME,['--headless=new','--disable-gpu',`--remote-debugging-port=${PORT}`,'--window-size=1440,900','about:blank'],{stdio:'ignore'});
let api;
try{
  api=await connect(PORT);
  await api.goto('file:///'+f,{settleMs:800});
  const r=await api.eval(()=>{
    const rail=document.querySelector('.ac-rail');
    const cat=document.querySelector('.ac-cat');
    const host=document.getElementById('host');
    const main=document.querySelector('.ac-main');
    const cs=getComputedStyle(rail);
    // 逐个找 sticky 失效的成因
    const ancestors=[];
    let el=rail;
    while(el&&el!==document.body){
      const s=getComputedStyle(el);
      ancestors.push({
        cls:(el.className||el.tagName).toString().slice(0,24),
        overflowY:s.overflowY, overflowX:s.overflowX,
        h:Math.round(el.getBoundingClientRect().height),
        scrollH:el.scrollHeight,
        display:s.display, alignItems:s.alignItems, contain:s.contain,
      });
      el=el.parentElement;
    }
    return {
      railPos:cs.position, railTop:cs.top, railH:Math.round(rail.getBoundingClientRect().height),
      catH:Math.round(cat.getBoundingClientRect().height),
      mainH:Math.round(main.getBoundingClientRect().height),
      hostH:Math.round(host.getBoundingClientRect().height),
      hostScrollH:host.scrollHeight,
      ancestors,
    };
  });
  console.log('rail position=' + r.railPos + ' top=' + r.railTop + '  rail高=' + r.railH);
  console.log('.ac-cat 高=' + r.catH + '  .ac-main 高=' + r.mainH + '  宿主主列高=' + r.hostH + ' scrollHeight=' + r.hostScrollH);
  console.log('');
  console.log('祖先链（找 sticky 失效的成因：祖先里有 overflow 就会让 sticky 只在那个元素内生效）');
  for(const a of r.ancestors) console.log('  ' + a.cls.padEnd(26) + ' h=' + String(a.h).padStart(5) + ' scrollH=' + String(a.scrollH).padStart(5) + ' overflowY=' + a.overflowY + ' display=' + a.display + ' align=' + a.alignItems + (a.contain!=='none'?' contain='+a.contain:''));
}finally{ try{api?.send?.('Browser.close')}catch{} chrome.kill(); }
