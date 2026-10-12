/* 最小的 CDP 驱动（零依赖）：Node 内置 WebSocket 连 headless Chrome，
   够用来设视口 / 导航 / 求值 / 截图。跑法见 tmp/verify-s8.mjs 顶部注释。 */
export async function connect(port = 9222, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* Chrome 还没起来 */ }
    if (Date.now() > deadline) throw new Error('连不上 CDP：' + port);
    await new Promise((r) => setTimeout(r, 150));
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || ''))); });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
      else res(msg.result);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时：' + method)); } }, 30000);
  });
  await send('Page.enable');
  await send('Runtime.enable');

  const api = {
    send,
    events,
    async eval(fn, ...args) {
      const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('求值抛错：' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async goto(url, { settleMs = 600 } = {}) {
      await send('Page.navigate', { url });
      // 等 loadEventFired：新导航会让事件列表继续累积，取导航之后的第一个
      const at = events.length;
      const t0 = Date.now();
      for (;;) {
        if (events.slice(at).some((e) => e.method === 'Page.loadEventFired')) break;
        if (Date.now() - t0 > 15000) throw new Error('等 loadEventFired 超时');
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, settleMs));
    },
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async beforeNavigate(jsSource) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: jsSource });
    },
    async shot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const fs = await import('node:fs');
      fs.writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
    async waitFor(fn, { timeoutMs = 12000, everyMs = 120 } = {}) {
      const t0 = Date.now();
      for (;;) {
        if (await api.eval(fn)) return true;
        if (Date.now() - t0 > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, everyMs));
      }
    },
    close() { try { ws.close(); } catch { /* noop */ } },
  };
  return api;
}
