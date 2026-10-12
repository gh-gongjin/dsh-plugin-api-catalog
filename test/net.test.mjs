/**
 * test/net.test.mjs —— 现译的出网传输层（lib/net.js，S16）。
 *
 * 这一层是本轮**改判**的产物（旧口径「本插件没有代理开关」的原文与当时的理由留在 §9.1n，历史不抹），
 * 它改的是「这一发从哪条路离开这台机器」，所以判据不按 API 列表排，按病历排：
 *   A 地址形状：三种写法都能解析 / 只支持 http:// / 凭据只进 Proxy-Authorization 且**绝不进回显**。
 *   B 来源仲裁：设置页自定义 > 环境变量 > Windows 注册表 > 直连；脏模式按 system 收，不挡人。
 *   C **绝不静默回落直连**：坏到发不出去就报坏在哪一步，两个发送实现（隧道、直连 fetch）一次都不许被碰。
 *   D CONNECT 那一包：字节、200 之后多余字节要 unshift（不 unshift 就是 TLS 握手莫名其妙地挂）、五种失败各自的 code。
 *   E 隧道 → TLS → HTTPS 的接线：agent 的 createConnection 必须**真回调出那个 socket**，SNI 跟着目标走，
 *     accept-encoding 必须是 identity（node:https 不解压）。
 *   F 门面：注册表只在需要时读、带 TTL 缓存、invalidate 后重读、并发只 spawn 一次；describe 出去的一律打码。
 *   G 本机现场：拿这台机器真 `reg query` 的输出与真例外表当夹具 —— 既读得出地址，又不会把登记域名放过直连。
 *
 * ★ 全篇不碰真网络：net / tls / https / fetch / reg 五样都是注入的 spy。
 *   真网络那三发读数（直连 fetch failed @10.8s、经代理 200/932ms、注册表 ProxyEnable=0x1）记在 spec §9.1r；
 *   本文件的假设施只负责"形状对"，不负责"这台机器通不通"。
 */
import fs from 'node:fs';
import { check, runAll, assert, flush, sourceText, makeFakeFacility } from './_helpers.mjs';
import {
  PROXY_MODES, PROXY_ENV_ORDER, PROXY_REGISTRY_KEY, PROXY_TUNNEL_TIMEOUT_MS, PROXY_REGISTRY_TTL_MS,
  TRANS_HOSTS, TRANS_ENDPOINTS, FETCH_TIMEOUT_MS,
} from '../lib/domain.js';
import {
  PROXY_ERROR, parseProxyUrl, maskProxyUrl, envProxy, parseRegistryValues, registryProxy,
  bypassMatch, decideRoute, openTunnel, createTunnelAgent, tunnelRequest, createNetTransport,
} from '../lib/net.js';
import { createAllStores } from '../lib/stores.js';
import { createTranslateService, TRANS_PROBE_TEXT } from '../lib/translate.js';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const PROXY = '127.0.0.1:7897';
const TARGET_HOST = 'translate.googleapis.com';
const TARGET_URL = `${TRANS_ENDPOINTS.keyless}?q=x`;

function fakeSocket() {
  const listeners = new Map();
  const s = {
    written: [], unshifted: [], destroyCount: 0, noDelay: false,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return s; },
    once(ev, fn) { const wrap = (arg) => { s.removeListener(ev, wrap); fn(arg); }; return s.on(ev, wrap); },
    removeListener(ev, fn) {
      const l = listeners.get(ev) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
      return s;
    },
    listenerCount(ev) { return (listeners.get(ev) || []).length; },
    emit(ev, arg) { for (const fn of [...(listeners.get(ev) || [])]) fn(arg); return listeners.has(ev); },
    write(buf) { s.written.push(Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf)); return true; },
    unshift(chunk) { s.unshifted.push(Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk)); },
    setNoDelay() { s.noDelay = true; },
    destroy() { s.destroyCount += 1; },
  };
  return s;
}

/** 假 node:net：connect(port, host) 的**参数顺序**也钉住 —— 写反了就是连到一个不存在的端口。 */
function fakeNet() {
  const connects = [];
  return {
    connects,
    last: () => connects[connects.length - 1]?.socket,
    connect(port, host) {
      const socket = fakeSocket();
      connects.push({ port, host, socket });
      return socket;
    },
  };
}

/** 假 node:tls：secureConnect 由用例点；socket 身份与 servername 留痕。 */
function fakeTls() {
  const opts = [];
  return {
    opts,
    lastSecure: () => opts[opts.length - 1]?.secure,
    connect(o) { const secure = fakeSocket(); opts.push({ ...o, secure }); return secure; },
  };
}

/** 假 node:https.request：end() 之后分两拍发 response → data → end（一拍到底就测不出"半途 error"那一类）。 */
function fakeHttps(responses = [{ statusCode: 200, headers: {}, body: '[]' }]) {
  const requests = [];
  let n = 0;
  return {
    requests,
    request(options) {
      const req = {
        options,
        _l: new Map(),
        on(ev, fn) { req._l.set(ev, fn); return req; },
        end() {
          const preset = responses[Math.min(n, responses.length - 1)];
          n += 1;
          requests.push({ options, agent: options.agent });
          const res = { statusCode: preset.statusCode ?? 200, headers: preset.headers ?? {} };
          res.on = (ev, fn) => {
            if (ev === 'data') return req.on('__body', fn);
            if (ev === 'end') return req.on('__end', fn);
            return req.on(ev, fn);
          };
          setTimeout(() => {
            req._l.get('response')?.(res);
            setTimeout(() => {
              req._l.get('__body')?.(Buffer.from(preset.body ?? '', 'utf8'));
              req._l.get('__end')?.();
            }, 0);
          }, 0);
        },
        destroy(err) { if (err) setTimeout(() => req._l.get('error')?.(err), 0); },
      };
      return req;
    },
  };
}

/** 假 reg query：键与次数留痕（只读那条律靠它 + 源码扫描）。 */
function fakeRunReg(stdout, { code = 0, throwWith = null } = {}) {
  const calls = [];
  const fn = async (key, timeoutMs) => {
    calls.push({ key, timeoutMs });
    if (throwWith) throw throwWith;
    return { code, stdout };
  };
  fn.calls = calls;
  return fn;
}

/** 这台机器 `reg query HKCU\...\Internet Settings` 的真输出（2026-10-07 原样抄，与代理相关的行都在）。 */
const REG_TEXT_REAL = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    CertificateRevocation    REG_DWORD    0x1',
  '    MigrateProxy    REG_DWORD    0x1',
  '    ProxyEnable    REG_DWORD    0x1',
  '    User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)',
  '    ZonesSecurityUpgrade    REG_BINARY    84563CBA0DEBDC01',
  '    LockDatabase    REG_QWORD    0x1dd54a28939e101',
  '    ProxyServer    REG_SZ    127.0.0.1:7897',
  '    ProxyOverride    REG_SZ    localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;127.0.0.1;<local>',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\5.0',
].join('\r\n');

/** 系统代理关着的那台：形状一致，只有开关不同。 */
const REG_TEXT_OFF = REG_TEXT_REAL.replace('ProxyEnable    REG_DWORD    0x1', 'ProxyEnable    REG_DWORD    0x0');

/**
 * 回包夹具：形状 = lib/net.js 里 netResponse 那一份（status/ok/headers.get/text/json）。
 * ★ 少给一个方法就等于夹具与真宿主形状不一致：渠道层会拿到 TypeError，判据测的是夹具的洞而不是代码。
 */
const KEYLESS_BODY = '[[["英国公共图书馆的数据。","Data about public libraries in the UK.",null,null,10]],[null,[["en",1,[[9999,[[1000,1]]]]]]],["en",null,[1],1]]';
function fakeResponse({ status = 200, body = KEYLESS_BODY } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 一个"什么都不设"的传输层，用例只管往上添。 */
function transport(prefs, extra = {}) {
  const direct = [];
  const tunnels = [];
  const reads = [];
  const tr = createNetTransport({
    getPrefs: () => prefs,
    env: {},
    platform: 'win32',
    registryRead: async () => { reads.push(1); return { ok: true, enabled: false, server: '', override: '', reason: '没配系统代理' }; },
    fetchFn: async (url, init) => { direct.push({ url, init }); return fakeResponse(); },
    tunnelRequestFn: async (url, opts) => { tunnels.push({ url, opts }); return fakeResponse(); },
    ...extra,
  });
  return { tr, direct, tunnels, reads };
}

/* ------------------------------------------------------------------ *
 * A. 地址形状与打码
 * ------------------------------------------------------------------ */

check('nt-01 代理地址四种写法都收（host:port / http:// / 带凭据 / IPv6 方括号），规范化出来的 url 里永远没有凭据', () => {
  for (const raw of [PROXY, `http://${PROXY}`, `http://u:pw@${PROXY}`, `  ${PROXY}  `]) {
    const p = parseProxyUrl(raw);
    assert.equal(p.ok, true, `${raw} 解析不出来：${p.reason}`);
    assert.equal(p.host, '127.0.0.1');
    assert.equal(p.port, 7897);
    assert.equal(p.url, `http://${PROXY}`, `${raw} 规范化出来的不是 host:port 那一份：${p.url}`);
    assert.equal(String(p.url).includes('pw'), false, `${raw} 规范化之后密码还挂在地址串上`);
  }
  const withAuth = parseProxyUrl(`http://u:pw@${PROXY}`);
  assert.equal(Buffer.from(withAuth.auth, 'base64').toString('utf8'), 'u:pw',
    '凭据没还原成 user:pass：Proxy-Authorization 那一头就拼不出来');
  assert.equal(parseProxyUrl(PROXY).auth, '', '没凭据的地址凭空多出一份 auth');
  const v6 = parseProxyUrl('http://[::1]:8080');
  assert.equal(v6.ok && v6.host === '::1' && v6.port === 8080 && v6.bracket === true, true,
    `IPv6 方括号写法没收住：${JSON.stringify(v6)}`);
  assert.equal(v6.url, 'http://[::1]:8080', 'IPv6 回显丢了方括号：那串地址是坏的');
});

check('nt-02 不收的形状各自点名（缺端口 / 端口越界 / socks / 认不出的前缀 / 只有密码）：不许一句「不合法」糊过去', () => {
  const bad = ['', '127.0.0.1', '127.0.0.1:0', '127.0.0.1:99999', ':7897', '[::1]', 'http://:pw@127.0.0.1:7897'];
  for (const raw of bad) {
    const p = parseProxyUrl(raw);
    assert.equal(p.ok, false, `${raw || '(空)'} 居然解析成功了`);
    assert.ok(String(p.reason).length > 0, `${raw || '(空)'} 拒了却没说为什么：界面只能显示「形状不合法」`);
  }
  // socks / https 是「本层没实现」，不是「你写错了」：文案必须点名只支持 http://，否则用户会反复改地址
  for (const raw of ['socks5://127.0.0.1:7897', 'socks4://127.0.0.1:7897', 'https://127.0.0.1:7897']) {
    const p = parseProxyUrl(raw);
    assert.equal(p.ok, false);
    assert.ok(p.reason.includes('http://'), `${raw} 的拒绝没说只支持 http://：${p.reason}`);
  }
  assert.ok(parseProxyUrl('gopher://127.0.0.1:1').reason.includes('gopher'), '认不出的前缀没被点名');
});

check('nt-03 maskProxyUrl：带凭据只留 host:port，不带凭据原样；密码子串出现一次都算泄漏', () => {
  assert.equal(maskProxyUrl(`http://u:s3cr3t@${PROXY}`), `http://***@${PROXY}`);
  assert.equal(maskProxyUrl(`u:s3cr3t@${PROXY}`), `***@${PROXY}`);
  assert.equal(maskProxyUrl(PROXY), PROXY);
  assert.equal(maskProxyUrl(''), '');
  for (const raw of [`http://u:s3cr3t@${PROXY}`, `s3cr3t@${PROXY}`]) {
    assert.equal(maskProxyUrl(raw).includes('s3cr3t'), false, `${raw} 打码后密码还在`);
  }
  // 双保险：解析那一步已经把凭据摘干净，所以就算忘了打码也漏不出去
  assert.equal(parseProxyUrl(`http://u:s3cr3t@${PROXY}`).url.includes('s3cr3t'), false);
});

check('nt-04 环境变量优先序吃 domain 那张表（一处命名）：空串与纯空格算没设，表外的名字一律不算来源', () => {
  const all = Object.fromEntries(PROXY_ENV_ORDER.map((n) => [n, `env-${n}`]));
  assert.equal(envProxy(all).name, PROXY_ENV_ORDER[0]);
  assert.equal(envProxy(all).url, `env-${PROXY_ENV_ORDER[0]}`);
  assert.equal(envProxy({ ...all, [PROXY_ENV_ORDER[0]]: '' }).name, PROXY_ENV_ORDER[1],
    '第一格空着就该往下走一格');
  assert.equal(envProxy({ ...all, [PROXY_ENV_ORDER[0]]: '  ' }).name, PROXY_ENV_ORDER[1],
    '纯空格算设了：那会发一发注定失败的请求');
  assert.equal(envProxy({}), null);
  assert.equal(envProxy(null), null);
  assert.equal(envProxy({ FTP_PROXY: PROXY, httpsProxy: PROXY }), null, '表外的名字被当成了来源：优先序就有第二处定义了');
});

/* ------------------------------------------------------------------ *
 * B. 注册表（只读）与例外表
 * ------------------------------------------------------------------ */

check('nt-05 注册表解析：本机真输出读得出地址与例外表；十六进制与十进制都认；关着就是关着', () => {
  const on = parseRegistryValues(REG_TEXT_REAL);
  assert.equal(on.proxyEnable, true);
  assert.equal(on.proxyServer, PROXY);
  assert.ok(on.proxyOverride.startsWith('localhost;127.*'), '例外表没读到：命中判据就成了瞎猜');
  assert.equal(on.proxyOverride.includes('REG_BINARY'), false, '旁边的 REG_BINARY 行串进了代理值里');

  const off = parseRegistryValues(REG_TEXT_OFF);
  assert.equal(off.proxyEnable, false, '0x0 被当成开着');
  assert.equal(off.proxyServer, PROXY, '关着的时候地址还留在值里（仲裁那一层必须不用它）');
  assert.equal(parseRegistryValues('    ProxyEnable    REG_DWORD    1').proxyEnable, true, '十进制写法不认');
  assert.equal(parseRegistryValues('    ProxyEnable    REG_DWORD    0x2').proxyEnable, true);
  assert.equal(parseRegistryValues('    ProxyServer    REG_SZ    10.0.0.1:8080').proxyEnable, null, '只有地址没开关');
  assert.equal(parseRegistryValues('HKEY_CURRENT_USER\\Whatever').proxyEnable, null);
  assert.equal(parseRegistryValues('').proxyServer, '');
});

check('nt-06 registryProxy：非 Windows 一个进程都不 spawn；reg 抛了算「没读到」不算网络故障；只有 reg query', async () => {
  const runReg = fakeRunReg(REG_TEXT_REAL);
  const mac = await registryProxy({ platform: 'darwin', runReg });
  assert.deepEqual(mac, { ok: true, enabled: false, server: '', override: '', reason: '' });
  assert.equal(runReg.calls.length, 0, '不是 Windows 也 spawn 了一次 reg');

  const win = await registryProxy({ platform: 'win32', runReg });
  assert.deepEqual(win, { ok: true, enabled: true, server: PROXY, override: parseRegistryValues(REG_TEXT_REAL).proxyOverride, reason: '' });
  assert.deepEqual(runReg.calls.map((c) => c.key), [PROXY_REGISTRY_KEY], '查的不是 domain 里那一个键');
  assert.equal(runReg.calls[0].timeoutMs, 2000, 'reg query 没带超时：挂住的 reg 进程会把现译那一发拖到总闸');

  const off = await registryProxy({ platform: 'win32', runReg: fakeRunReg(REG_TEXT_OFF) });
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.ok(off.reason.includes('是关的'), `关着的那台没说清：${off.reason}`);

  const broken = await registryProxy({ platform: 'win32', runReg: async () => { throw new Error('reg 命令不可用'); } });
  assert.equal(broken.ok, false);
  assert.equal(broken.enabled, false);
  assert.ok(broken.reason.includes('读注册表失败'), `reg 不可用没报成「读不到」：${broken.reason}`);

  const noEnable = await registryProxy({ platform: 'win32', runReg: fakeRunReg('    ProxyServer    REG_SZ    1.2.3.4:1') });
  assert.equal(noEnable.ok, false);
  assert.ok(noEnable.reason.includes('ProxyEnable'), `缺 ProxyEnable 那句没说清：${noEnable.reason}`);

  // 只读那条律：整份文件里不许出现写注册表的动词（插件不改系统），查询走 reg query
  const src = await sourceText('lib/net.js');
  assert.deepEqual(src.match(/\b(add|delete|import|export|copy|replace)\b\s*[,}\]]?\s*['"]?HK/gi) || [], [],
    'net.js 里出现了写注册表的目标键');
  assert.deepEqual(src.match(/reg(?:\.exe)?['"]?\s*,\s*\[['"](?!(query))/gi) || [], [],
    'reg 的第二参数不是 query：那是往注册表里写');
  assert.ok(src.includes("['query', key]"), '查询不是 reg query 那一发');
});

check('nt-07 例外表匹配：本机那条真例外命中 localhost 与内网，一台登记域名都不放；<-loopback> / <local> 不算规则', () => {
  const override = parseRegistryValues(REG_TEXT_REAL).proxyOverride;
  for (const h of ['localhost', '127.0.0.1', '127.5.6.7', '192.168.1.9', '10.0.0.5']) {
    assert.equal(bypassMatch(h, override), true, `${h} 本该绕开代理`);
  }
  // ★ 扫描面从 TRANS_HOSTS 派生，不手抄：登记的这几台**一台都不许被例外表放过直连**
  //   （例外表写宽了的症状是「配了代理还是 fetch failed」，那是这一档最难查的形状）。
  const hosts = [...new Set(TRANS_HOSTS)];
  assert.ok(hosts.length >= 2, `派生白名单只剩 ${hosts.length} 台：TRANS_ENDPOINTS 或派生漂了`);
  for (const host of hosts) {
    assert.equal(bypassMatch(host, override), false, `${host} 命中了系统代理例外：那一发会绕过代理直连`);
    const route = decideRoute({ prefs: { proxyMode: 'system' }, env: {}, sys: { ok: true, enabled: true, server: PROXY, override }, targetHost: host });
    assert.equal(route.via, 'proxy', `${host} 在这台机器的真例外表面前没走代理`);
  }
  assert.equal(bypassMatch('example.com', '<local>;<-loopback>'), false);
  assert.equal(bypassMatch('a.example.com', '*.example.com'), true);
  assert.equal(bypassMatch('example.com', '*.example.com'), true, '*.x 连裸域也覆盖（系统口径）');
  assert.equal(bypassMatch('notexample.com', '*.example.com'), false);
  assert.equal(bypassMatch('anything', ''), false);
  assert.equal(bypassMatch('', override), false);
  // 前缀通配按 Windows 口径整段前缀匹配（`127.*` 也吃 127.0.0.1.evil.com）：这一层不重新发明例外语法，
  // 真正的护栏是上面那条 —— 登记的域名一台都不在这张表里。
  assert.equal(bypassMatch('127.0.0.1.evil.com', '127.*'), true, '前缀通配语义漂了：那等于我们自己发明了一套例外语法');
});

/* ------------------------------------------------------------------ *
 * C. 来源仲裁
 * ------------------------------------------------------------------ */

check('nt-08 仲裁四档：自定义盖过环境与环境注册表，直连档连环境变量都不读，脏模式按 system 收', () => {
  const sys = { ok: true, enabled: true, server: '1.1.1.1:1', override: '' };
  const env = { [PROXY_ENV_ORDER[0]]: '2.2.2.2:2' };

  const custom = decideRoute({ prefs: { proxyMode: 'custom', proxyUrl: PROXY }, env, sys, targetHost: TARGET_HOST });
  assert.equal(custom.via, 'proxy');
  assert.equal(custom.source, 'custom');
  assert.equal(custom.proxy.port, 7897, '自定义档没用它自己的地址');

  const viaEnv = decideRoute({ prefs: { proxyMode: 'system' }, env, sys, targetHost: TARGET_HOST });
  assert.equal(viaEnv.source, `env:${PROXY_ENV_ORDER[0]}`);
  assert.equal(viaEnv.proxy.port, 2, '环境变量盖过注册表这条没成立');

  const viaReg = decideRoute({ prefs: { proxyMode: 'system' }, env: {}, sys, targetHost: TARGET_HOST });
  assert.equal(viaReg.source, 'registry');
  assert.equal(viaReg.proxy.port, 1);

  const direct = decideRoute({ prefs: { proxyMode: 'direct' }, env, sys, targetHost: TARGET_HOST });
  assert.deepEqual({ via: direct.via, source: direct.source, proxy: direct.proxy }, { via: 'direct', source: 'mode:direct', proxy: null });

  const nothing = decideRoute({
    prefs: { proxyMode: 'system' }, env: {}, targetHost: TARGET_HOST,
    sys: { ok: true, enabled: false, server: '', override: '', reason: '系统「使用代理服务器」是关的' },
  });
  assert.equal(nothing.via, 'direct');
  assert.equal(nothing.source, 'none');

  // prefs 是读-并-写：历史行里可能躺着没登记的模式，那不该把整条现译路挡死
  const dirty = decideRoute({ prefs: { proxyMode: 'socks' }, env: {}, sys, targetHost: TARGET_HOST });
  assert.equal(dirty.source, 'registry', '脏模式没按 system 档仲裁');
  assert.equal(PROXY_MODES.includes('socks'), false);
});

check('nt-09 坏配置一律 via=failed（自定义空 / socks / 缺端口 / 环境变量坏值 / 注册表坏值）：五条都不给直连留门', () => {
  const cases = [
    [{ proxyMode: 'custom', proxyUrl: '' }, {}, null, '自定义那一格是空的'],
    [{ proxyMode: 'custom', proxyUrl: 'socks5://127.0.0.1:1' }, {}, null, '自定义填了 socks'],
    [{ proxyMode: 'custom', proxyUrl: '127.0.0.1' }, {}, null, '自定义缺端口'],
    [{ proxyMode: 'system' }, { [PROXY_ENV_ORDER[0]]: 'not-an-address' }, null, '环境变量给的不是地址'],
    [{ proxyMode: 'system' }, {}, { ok: true, enabled: true, server: 'socks4://1.2.3.4:1', override: '' }, '注册表里是本层不支持的协议'],
  ];
  for (const [prefs, env, sys, what] of cases) {
    const r = decideRoute({ prefs, env, sys, targetHost: TARGET_HOST });
    assert.equal(r.via, 'failed', `${what}：仲裁成了 ${r.via}，那就会发一发「碰碰看」的请求`);
    assert.equal(r.proxy, null, `${what}：failed 还带着代理地址`);
    assert.ok(String(r.reason).length > 0, `${what}：failed 没给原因，界面只能显示「出网失败」`);
  }
  const unreadable = decideRoute({
    prefs: { proxyMode: 'system' }, env: {}, targetHost: TARGET_HOST,
    sys: { ok: false, enabled: false, server: '', override: '', reason: '读注册表失败（reg 命令不可用）' },
  });
  assert.equal(unreadable.via, 'direct', '读不到注册表被报成故障：那是把用户引向错误的一侧');
  assert.equal(unreadable.source, 'registry-unreadable');
  assert.ok(unreadable.reason.includes('reg 命令不可用'));

  const bypassed = decideRoute({
    prefs: { proxyMode: 'system' }, env: {}, targetHost: 'localhost',
    sys: { ok: true, enabled: true, server: PROXY, override: 'localhost' },
  });
  assert.deepEqual({ via: bypassed.via, source: bypassed.source }, { via: 'direct', source: 'bypass' });
  assert.ok(bypassed.reason.includes('例外'));
});

/* ------------------------------------------------------------------ *
 * D. CONNECT 那一包
 * ------------------------------------------------------------------ */

check('nt-10 CONNECT 那一包：目标 host:443 + Host + UA，connect 参数顺序是 (port, host)，带凭据才加认证头且头里没明文', async () => {
  const n = fakeNet();
  const proxy = parseProxyUrl(PROXY);
  const p = openTunnel({ proxy, targetHost: TARGET_HOST, targetPort: 443, timeoutMs: 1000, fakeNet: n });
  p.catch(() => {});   // 本发后面还有断言：中途红了也不要把这条 promise 留成未处理拒绝
  await flush(0);
  assert.equal(n.connects.length, 1, '隧道没发出去');
  assert.deepEqual({ port: n.connects[0].port, host: n.connects[0].host }, { port: 7897, host: '127.0.0.1' },
    `connect 的参数顺序不对：${JSON.stringify(n.connects[0])}`);
  const sock = n.last();
  assert.equal(sock.noDelay, true, '没 setNoDelay：CONNECT 那一小包会攒在 Nagle 里');
  const head = sock.written.join('');
  assert.ok(head.startsWith(`CONNECT ${TARGET_HOST}:443 HTTP/1.1\r\n`), head);
  assert.ok(head.includes(`Host: ${TARGET_HOST}:443\r\n`), head);
  assert.ok(head.includes('User-Agent: dsh-plugin-api-catalog\r\n'), head);
  assert.equal(head.includes('Proxy-Authorization'), false, '没凭据的地址凭空发了一发认证头');
  assert.ok(head.endsWith('\r\n\r\n'), '请求行没收口：代理会一直等下一字节');

  const n2 = fakeNet();
  const withAuth = parseProxyUrl(`http://u:pw@${PROXY}`);
  const p2 = openTunnel({ proxy: withAuth, targetHost: TARGET_HOST, timeoutMs: 1000, fakeNet: n2 });
  p2.catch(() => {});
  await flush(0);
  const head2 = n2.last().written.join('');
  assert.ok(head2.includes(`Proxy-Authorization: Basic ${withAuth.auth}\r\n`), `带凭据却没发认证头：${head2}`);
  assert.equal(head2.includes('u:pw'), false, '认证头里出现明文 user:pass（该是 base64 那一串）');

  // 200 之后同一包里已经带进 TLS 字节：那几字节必须退回读队列，否则 TLS 握手拿到的是被啃过的一口
  const HELLO = Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n', 'latin1');
  sock.emit('data', HELLO);
  const first = await p;
  assert.equal(first, sock, 'resolve 回来的不是那条 socket');
  assert.equal(sock.listenerCount('data'), 0, '隧道建好还挂着 data 监听：下一步 TLS 与它抢字节');
  assert.deepEqual(sock.unshifted, [], '响应正好收口也 unshift 了一发（连空串都推回去，TLS 那边的读位就错了）');

  n2.last().emit('data', Buffer.concat([HELLO, Buffer.from('AB', 'latin1')]));
  await p2;
  assert.deepEqual(n2.last().unshifted, ['AB'], `200 之后的字节没退回读队列：${JSON.stringify(n2.last().unshifted)}`);
});

check('nt-11 隧道的六种失败各有 code（407 / 502 / ECONNREFUSED / 提前关 / 超时 / 超大响应），每一种都把 socket 拆了', async () => {
  async function drive({ respond, error, closeBeforeResponse, timeoutMs = 50 }) {
    const n = fakeNet();
    const p = openTunnel({ proxy: parseProxyUrl(PROXY), targetHost: TARGET_HOST, timeoutMs, fakeNet: n });
    await flush(0);
    const sock = n.last();
    if (respond) sock.emit('data', Buffer.from(respond, 'latin1'));
    if (error) sock.emit('error', Object.assign(new Error(error.message), { code: error.code }));
    if (closeBeforeResponse) sock.emit('close');
    const e = await p.then(() => null, (x) => x);
    assert.ok(e, '这一发居然成功了');
    assert.equal(sock.destroyCount, 1, `失败后没关掉 socket（code=${e.code}）：一条坏连接留在了进程里`);
    assert.equal(sock.listenerCount('data'), 0, '失败后监听没摘干净');
    return e;
  }

  const auth = await drive({ respond: 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n' });
  assert.equal(auth.code, 'proxy_auth');
  assert.ok(auth.message.includes(PROXY_ERROR.auth), auth.message);
  assert.ok(auth.message.includes('Proxy Authentication Required'), `407 那句原因没带回来：${auth.message}`);

  const refused = await drive({ respond: 'HTTP/1.1 502 Bad Gateway\r\n\r\n' });
  assert.equal(refused.code, 'proxy_refused');
  assert.ok(refused.message.includes('502'), refused.message);

  const junk = await drive({ respond: 'not http at all\r\n\r\n' });
  assert.equal(junk.code, 'proxy_refused', `响应首行不是 HTTP 状态行却没点名：${junk.code}`);

  const unreachable = await drive({ error: { message: 'connect ECONNREFUSED 127.0.0.1:7897', code: 'ECONNREFUSED' } });
  assert.equal(unreachable.code, 'proxy_unreachable');
  assert.ok(unreachable.message.includes(PROXY_ERROR.unreachable), unreachable.message);
  assert.deepEqual(unreachable.proxy, { host: '127.0.0.1', port: 7897 }, '错误里没带代理坐标（日志与界面要打码用的就是它）');

  const closed = await drive({ closeBeforeResponse: true });
  assert.equal(closed.code, 'proxy_closed');

  const slow = await drive({ timeoutMs: 20 });
  assert.equal(slow.code, 'proxy_timeout');
  assert.ok(slow.message.includes(PROXY_ERROR.timeout), slow.message);

  const huge = await drive({ respond: `HTTP/1.1 200 ok\r\n\r\n${'x'.repeat(16 * 1024 + 10)}` });
  assert.equal(huge.code, 'proxy_bad_gateway', `响应超过上限没单独点名：${huge.code}`);

  // 没解析出代理地址：内部错，一个 socket 都不发
  const n = fakeNet();
  const bad = await openTunnel({ proxy: null, targetHost: TARGET_HOST, fakeNet: n }).then(() => null, (e) => e);
  assert.ok(String(bad.message).includes(PROXY_ERROR.bad_url), bad.message);
  assert.equal(n.connects.length, 0);

  // 隧道超时必须小于现译那一发的总闸：否则总闸先到，报的是「超时」而不是「代理坏在哪一步」
  assert.ok(PROXY_TUNNEL_TIMEOUT_MS < FETCH_TIMEOUT_MS,
    `隧道 ${PROXY_TUNNEL_TIMEOUT_MS}ms 没小于总闸 ${FETCH_TIMEOUT_MS}ms：故障归因会错位`);
});

/* ------------------------------------------------------------------ *
 * E. 隧道 → TLS → HTTPS 的接线
 * ------------------------------------------------------------------ */

check('nt-12 createTunnelAgent：createConnection 真的回调出 TLS socket，SNI 跟着目标走；TLS 挂了错误从回调出来且带原始 code', async () => {
  const n = fakeNet();
  const t = fakeTls();
  const agent = createTunnelAgent({ proxy: parseProxyUrl(PROXY), timeoutMs: 500, fakeNet: n, fakeTls: t });
  let cbErr = '没回调';
  let cbSock = null;
  let called = 0;
  agent.createConnection({ host: TARGET_HOST, port: 443 }, (e, sock) => { called += 1; cbErr = e; cbSock = sock; });
  await flush(0);
  assert.equal(n.connects.length, 1);
  assert.ok(n.last().written.join('').startsWith(`CONNECT ${TARGET_HOST}:443 HTTP/1.1`), n.last().written.join(''));
  n.last().emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n', 'latin1'));
  await flush(0);
  assert.equal(t.opts.length, 1, '隧道通了却没接 TLS');
  assert.equal(t.opts[0].socket, n.last(), 'TLS 没接在隧道那条 socket 上');
  assert.equal(t.opts[0].servername, TARGET_HOST, `SNI 没跟着目标走：${t.opts[0].servername}`);
  assert.deepEqual(t.opts[0].ALPNProtocols, ['http/1.1']);
  t.lastSecure().emit('secureConnect');
  await flush(0);
  assert.equal(called, 1, '回调跑了两次');
  assert.equal(cbErr, null, `createConnection 回调把错误带回来了：${cbErr?.message}`);
  assert.equal(cbSock, t.lastSecure(), '回调给 https 的不是那条 TLS socket');

  const n2 = fakeNet();
  const t2 = fakeTls();
  const agent2 = createTunnelAgent({ proxy: parseProxyUrl(PROXY), timeoutMs: 500, fakeNet: n2, fakeTls: t2 });
  let err2 = null;
  agent2.createConnection({ host: TARGET_HOST }, (e) => { err2 = e; });
  await flush(0);
  n2.last().emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n', 'latin1'));
  await flush(0);
  t2.lastSecure().emit('error', Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }));
  await flush(0);
  assert.ok(err2, 'TLS 失败没回调错误');
  assert.ok(err2.message.includes(PROXY_ERROR.tls), err2.message);
  assert.equal(err2.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', '原始 code 被覆盖成通用值：日志就分不出是证书还是协议');
  assert.equal(n2.last().destroyCount >= 1, true, 'TLS 失败后隧道 socket 还留着');

  // 没给代理地址时也要走同一条收口（createConnection 的回调不能把 reject 吞掉）
  const n3 = fakeNet();
  const agent3 = createTunnelAgent({ proxy: null, fakeNet: n3, timeoutMs: 50 });
  let err3 = null;
  agent3.createConnection({ host: TARGET_HOST }, (e) => { err3 = e; });
  await flush(0);
  assert.ok(err3, '代理地址缺失时回调既没给 socket 也没给错误');
  assert.equal(n3.connects.length, 0);
});

check('nt-13 tunnelRequest：GET + accept-encoding identity（node:https 不解压）+ 只跟 https 目标 + 3xx 跟进与跟满原样回', async () => {
  const agentFactory = () => ({ createConnection: (_o, cb) => cb(new Error('不该真发')) });
  const responses = [
    { statusCode: 302, headers: { location: '/translate_a/single?next=1' }, body: '' },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '[[["中文。","zh",null,true]]]' },
  ];
  const mod = fakeHttps(responses);
  const res = await tunnelRequest(`https://${TARGET_HOST}/translate_a/single?a=1`, {
    headers: { accept: 'application/json' }, timeoutMs: 500, connect: { proxy: parseProxyUrl(PROXY) },
    httpsMod: mod, agentFactory,
  });
  assert.equal(mod.requests.length, 2, `3xx 没跟进：只发了 ${mod.requests.length} 发`);
  const [first, second] = mod.requests.map((r) => r.options);
  assert.equal(first.method, 'GET');
  assert.equal(first.headers['accept-encoding'], 'identity',
    '没显式要 identity：node:https 不会自动解压，gzip 字节会直接进 JSON.parse，读数就成了「回包读不出结构」');
  assert.equal(first.headers.accept, 'application/json', '调用方给的头被吞了');
  assert.equal(first.hostname, TARGET_HOST);
  assert.equal(first.servername, TARGET_HOST);
  assert.equal(first.port, 443);
  assert.equal(first.path, '/translate_a/single?a=1');
  assert.equal(second.path, '/translate_a/single?next=1', '相对 Location 没按当前 URL 解析');
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(await res.text(), '[[["中文。","zh",null,true]]]');
  assert.deepEqual(await res.json(), [[['中文。', 'zh', null, true]]]);
  assert.equal(res.headers.get('Content-Type'), 'application/json', '头取值大小写不敏感这条没保住');
  assert.equal(res.headers.get('x-nope'), null);
  assert.equal(res.redirected, true);
  assert.equal(res.url, `https://${TARGET_HOST}/translate_a/single?next=1`, 'url 没跟着最后一跳走');

  // 跟满上限：把最后一个 3xx 原样交回去（编一个「重定向过多」的假错误比这更不诚实）
  const mod2 = fakeHttps([{ statusCode: 302, headers: { location: 'https://x.test/a' }, body: '' }]);
  const r2 = await tunnelRequest('https://x.test/a', { timeoutMs: 500, maxRedirects: 2, httpsMod: mod2, agentFactory });
  assert.equal(r2.status, 302);
  assert.equal(mod2.requests.length, 3, 'maxRedirects 没起作用');

  // 非 https 目标：隧道只支持 https，明文目标点名拒（不「顺手」改用直连）
  const mod3 = fakeHttps([{ statusCode: 200, headers: {}, body: '' }]);
  const e = await tunnelRequest('http://example.com/a', { httpsMod: mod3, agentFactory }).then(() => null, (x) => x);
  assert.equal(e?.code, 'proxy_target_scheme');
  assert.equal(mod3.requests.length, 0, `明文目标还是发了一发：${mod3.requests.length}`);

  // 超时那一发：定时器先到 ⇒ req.destroy(err) ⇒ 错误从 promise 出来（不能默默返回一个空响应）
  const silent = {
    requests: [],
    request(options) {
      silent.requests.push(options);
      const l = new Map();
      return {
        on: (ev, fn) => { l.set(ev, fn); return this; },
        end() {},
        destroy: (err) => { if (err) l.get('error')(err); },
      };
    },
  };
  const e4 = await tunnelRequest(`https://${TARGET_HOST}/a`, { timeoutMs: 20, httpsMod: silent, agentFactory })
    .then(() => null, (x) => x);
  assert.ok(e4, '超时没报错却像成功一样回来了');
  assert.equal(e4.code, 'ETIMEDOUT', `超时报成了 ${e4.code}`);
  assert.equal(silent.requests.length, 1);
});

/* ------------------------------------------------------------------ *
 * F. 门面
 * ------------------------------------------------------------------ */

check('nt-14 门面三档：proxy 只走隧道、direct 只走 fetch、failed 两个发送实现一次都不碰（绝不静默回落）', async () => {
  const viaProxy = transport({ proxyMode: 'custom', proxyUrl: PROXY });
  const r1 = await viaProxy.tr.fetch(TARGET_URL, { headers: { accept: 'application/json' } });
  assert.equal(r1.status, 200);
  assert.equal(viaProxy.tunnels.length, 1);
  assert.equal(viaProxy.direct.length, 0, '选了代理还发了一发直连');
  assert.equal(viaProxy.tunnels[0].url, TARGET_URL);
  assert.equal(viaProxy.tunnels[0].opts.connect.proxy.host, '127.0.0.1');
  assert.equal(viaProxy.tunnels[0].opts.connect.proxy.url, `http://${PROXY}`, '递给隧道的代理地址带着凭据位');
  assert.equal(viaProxy.tunnels[0].opts.headers.accept, 'application/json', 'init.headers 没透传到隧道那一发');

  const viaDirect = transport({ proxyMode: 'direct' });
  await viaDirect.tr.fetch(TARGET_URL, {});
  assert.equal(viaDirect.direct.length, 1);
  assert.equal(viaDirect.tunnels.length, 0);

  // ★ 本轮那条律的锚：坏到发不出去 ⇒ 抛代理配置错，两个发送实现都不许碰。
  //   谁哪天改成「解析失败就当没配，走直连碰碰看」，这一发会红 —— 症状「配了个不通的代理」不会再伪装成「网络不通」。
  const broken = transport({ proxyMode: 'custom', proxyUrl: 'socks5://1.2.3.4:1' });
  const e = await broken.tr.fetch(TARGET_URL, {}).then(() => null, (x) => x);
  assert.ok(e, '坏代理配置居然发出去了');
  assert.equal(e.code, 'proxy_config', `回落成了 ${e.code}`);
  assert.ok(e.message.includes('socks'), `报的不是配置坏在哪：${e.message}`);
  assert.equal(broken.direct.length, 0, '坏配置还是发了一发直连：静默回落');
  assert.equal(broken.tunnels.length, 0);
  assert.equal(broken.tr.lastRoute.via, 'failed', '仲裁结果没留在 lastRoute：界面那一行说不出为什么');

  // 宿主没给 fetch（直连那一发发不出去）也要点名，不是返回一个假 200
  const noFetch = transport({ proxyMode: 'direct' }, { fetchFn: null });   // 得是 null：undefined 会被当成"没这一项"，落回宿主的全局 fetch
  const e2 = await noFetch.tr.fetch(TARGET_URL, {}).then(() => null, (x) => x);
  assert.equal(e2?.code, 'no_transport', e2?.message);
});

check('nt-15 注册表只在需要时读、TTL 内吃缓存、invalidate 后立刻重读、并发只 spawn 一次', async () => {
  let clock = 1_000_000;
  const reads = [];
  const tr = createNetTransport({
    getPrefs: () => ({ proxyMode: 'system' }),
    env: {},
    registryRead: async () => { reads.push(clock); return { ok: true, enabled: true, server: PROXY, override: '', reason: '' }; },
    registryTtlMs: PROXY_REGISTRY_TTL_MS,
    now: () => clock,
    fetchFn: async () => ({ ok: true, status: 200 }),
    tunnelRequestFn: async () => ({ ok: true, status: 200 }),
  });
  await tr.fetch(TARGET_URL, {});
  clock += 1000;
  await tr.fetch(TARGET_URL, {});
  assert.equal(reads.length, 1, `TTL 内读了 ${reads.length} 次：每发都 spawn 一个 reg 进程`);
  clock += PROXY_REGISTRY_TTL_MS;
  await tr.fetch(TARGET_URL, {});
  assert.equal(reads.length, 2, '过了 TTL 还吃缓存：改了系统代理永远不会被感知');

  tr.invalidate();
  await tr.fetch(TARGET_URL, {});
  assert.equal(reads.length, 3, 'invalidate 后没重读：改完偏好那一发用的还是旧地址');

  // custom / direct 两档压根不需要注册表：连那一发 spawn 都不该有
  const reads2 = [];
  for (const mode of PROXY_MODES.filter((m) => m !== 'system')) {
    const t2 = transport({ proxyMode: mode, proxyUrl: PROXY }, {
      registryRead: async () => { reads2.push(mode); return { ok: true, enabled: false, server: '' }; },
    });
    await t2.tr.fetch(TARGET_URL, {});
    assert.equal(t2.reads.length, 0, `${mode} 档走了默认那份注册表读取`);
  }
  assert.deepEqual(reads2, [], `custom/direct 档还是去读了注册表：${reads2.join(',')}`);

  // 并发两发共用那一次在飞的读取；注册表抛错按「没读到」收，不把这一发拖崩
  const boom = createNetTransport({
    getPrefs: () => ({ proxyMode: 'system' }),
    env: {},
    registryRead: async (arg) => { await flush(1); throw new Error('spawn 挂了'); },
    fetchFn: async () => ({ ok: true, status: 200 }),
    tunnelRequestFn: async () => ({ ok: true, status: 200 }),
  });
  const [a, b] = await Promise.all([boom.fetch(TARGET_URL, {}), boom.fetch(TARGET_URL, {})]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const d = boom.describe();
  assert.equal(d.via, 'direct', `注册表读失败被当成了故障：${JSON.stringify(d)}`);
  assert.equal(d.source, 'registry-unreadable');
  assert.ok(d.reason.includes('spawn 挂了'), d.reason);
});

check('nt-16 describe/lastRoute：没发过是 idle；发过只有打码后的地址与目标 host；换偏好不必重建传输层', async () => {
  const idle = transport({ proxyMode: 'system' });
  assert.equal(idle.tr.describe().via, 'idle');
  assert.equal(idle.tr.lastRoute, null);
  assert.equal(idle.tr.describe().proxy, '');

  let prefs = { proxyMode: 'custom', proxyUrl: `http://user:s3cr3t@${PROXY}` };
  const tr = createNetTransport({
    getPrefs: () => prefs,
    env: {},
    fetchFn: async () => ({ ok: true, status: 200 }),
    tunnelRequestFn: async () => ({ ok: true, status: 200 }),
  });
  await tr.fetch(TARGET_URL, {});
  const d = tr.describe();
  assert.equal(d.via, 'proxy');
  assert.equal(d.source, 'custom');
  // 解析那一步就把凭据摘掉了（proxy.url 是规范化的 host:port），describe 再打一次码是双保险
  assert.equal(d.proxy, `http://${PROXY}`, `回显不是那一份干净地址：${d.proxy}`);
  assert.equal(JSON.stringify(d).match(/s3cr3t|user:/), null, 'describe 的某个字段漏出凭据');
  assert.equal(d.targetHost, TARGET_HOST, '没记目标 host：界面说不出「去哪台被挡了」');
  assert.equal(typeof d.at, 'number');

  // 换一档现取现算（index.js 里 onPrefsSaved 那支的地基）
  prefs = { proxyMode: 'direct' };
  await tr.fetch(TARGET_URL, {});
  assert.equal(tr.describe().via, 'direct');
  assert.equal(tr.describe().proxy, '');

  // failed 那一支的 reason 必须一路带到 describe：界面念的就是这一句
  prefs = { proxyMode: 'custom', proxyUrl: '' };
  await tr.fetch(TARGET_URL, {}).catch(() => {});
  assert.equal(tr.describe().via, 'failed');
  assert.ok(tr.describe().reason.length > 0, 'failed 却没留下原因');
});

/* ------------------------------------------------------------------ *
 * G. 形状守恒：这一层不越界
 * ------------------------------------------------------------------ */

check('nt-17 传输层不自己挑目标、不自己拼渠道地址：出网域名只有 TRANS_ENDPOINTS 派生那一张表', async () => {
  // net.js 里没有第二个「域名名单」：白名单只在 lib/translate.js 的闸门那一处（新渠道不开后门）。
  const src = await sourceText('lib/net.js');
  const importLine = src.match(/from '\.\/domain\.js'/);
  assert.ok(importLine, 'net.js 没从 domain.js 取常量：优先序与超时就有第二处定义了');
  assert.equal(/HTTPS_PROXY|ALL_PROXY|HTTP_PROXY|127\.0\.0\.1:7897/.test(src.split('*/')[1] || ''), false,
    'net.js 的实现里写死了环境变量名或本机代理地址（名单只该在 domain.js）');
  assert.equal(src.includes('TRANS_HOSTS'), false, 'net.js 自己拿白名单挑目标：闸门就变成两处了');
  assert.equal(/translate\.googleapis\.com|fanyi\.baidu|tmt\.tencentcloudapi|mt\.cn-hangzhou|itrans\.xf/.test(src), false,
    'net.js 里出现了渠道域名：出网名单就有了第二处');
  // 注入的 fakeNet 只被 CONNECT 那一头发一次：传输层不会绕过调用方自己找别的出口
  const n = fakeNet();
  const ot = openTunnel({ proxy: parseProxyUrl(PROXY), targetHost: TARGET_HOST, timeoutMs: 500, fakeNet: n });
  n.last().emit('data', Buffer.from('HTTP/1.1 200 ok\r\n\r\n', 'latin1'));
  const socket = await ot;
  assert.equal(n.connects.length, 1);
  assert.equal(socket, n.last());
});

check('nt-18 门面接上渠道层：免费接口那一发经隧道出去，出去的就是登记的端点 + 那一句；全局 fetch 一次都不碰', async () => {
  const t = transport({ proxyMode: 'custom', proxyUrl: PROXY });
  const facility = makeFakeFacility();
  const stores = createAllStores({ getFacility: () => facility, now: () => 1_777_000_000_000 });
  const svc = createTranslateService({
    stores,
    getPrefs: () => ({ transEnabled: true, transChannel: 'keyless', proxyMode: 'custom', proxyUrl: PROXY }),
    fetchImpl: t.tr.fetch,
    getTransport: () => t.tr.describe(),
    now: () => 1_777_000_000_000,
    nonce: () => 'nonce-1',
  });

  const sent = await svc.testConnection();
  assert.equal(sent.ok, true, `经隧道那一发没译出来：${JSON.stringify(sent)}`);
  assert.equal(sent.channel, 'keyless');
  assert.equal(t.tunnels.length, 1, '现译那一发没走注入的传输层');
  assert.equal(t.direct.length, 0, '现译还碰了全局 fetch：代理仲裁就被绕过了');
  const url = new URL(t.tunnels[0].url);
  assert.equal(url.origin + url.pathname, TRANS_ENDPOINTS.keyless, `出去的地址不是登记的那个端点：${url.href}`);
  assert.equal(url.searchParams.get('q'), TRANS_PROBE_TEXT, '测试连接那句没逐字进 q');
  assert.equal([...new Set(TRANS_HOSTS)].includes(url.hostname), true, '渠道层把没登记的域名递给了传输层');
  assert.equal(t.tunnels[0].opts.connect.proxy.url, `http://${PROXY}`);

  // 状态里那一块带着路线（界面念的就是它）；装配没接 getTransport 时给 null，界面按"这一格没话"处理
  const st = await svc.status();
  assert.equal(st.transport.via, 'proxy');
  assert.equal(st.transport.source, 'custom');
  const noTransport = createTranslateService({
    stores,
    getPrefs: () => ({ transEnabled: true, transChannel: 'keyless' }),
    fetchImpl: async () => { throw new Error('不该发'); },
    now: () => 1_777_000_000_000,
  });
  assert.equal((await noTransport.status()).transport, null, '装配没给传输层时状态里凭空多一块');
});

await runAll('net');
