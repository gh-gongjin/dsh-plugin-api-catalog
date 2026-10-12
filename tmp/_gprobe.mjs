const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' +
  encodeURIComponent('Data about public libraries in the United Kingdom.');
const t0 = Date.now();
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
  const body = await r.text();
  console.log(`直连 status=${r.status} ms=${Date.now() - t0} len=${body.length}`);
  console.log(body.slice(0, 200));
} catch (e) {
  console.log(`直连 抛错 ms=${Date.now() - t0} ${e?.name} ${String(e?.message).slice(0, 120)}`);
}
