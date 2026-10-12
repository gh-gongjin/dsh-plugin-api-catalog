import { createNetTransport, registryProxy, decideRoute } from '../lib/net.js';
const t = createNetTransport({ getPrefs: () => ({ proxyMode: 'system', proxyUrl: '' }), logger: console });
const sys = await registryProxy({});
console.log('注册表读数:', JSON.stringify(sys));
console.log('仲裁:', JSON.stringify(decideRoute({ prefs: { proxyMode: 'system' }, env: {}, sys, targetHost: 'translate.googleapis.com' })));
const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' +
  encodeURIComponent('Data about public libraries in the United Kingdom.');
const t0 = Date.now();
try {
  const r = await t.fetch(url, { headers: { accept: 'application/json' } });
  const body = await r.text();
  console.log(`隧道 status=${r.status} ms=${Date.now() - t0} len=${body.length}`);
  console.log(body.slice(0, 120));
} catch (e) { console.log(`隧道 抛错 ms=${Date.now() - t0} code=${e?.code} ${String(e?.message).slice(0, 160)}`); }
console.log('describe:', JSON.stringify(t.describe()));
