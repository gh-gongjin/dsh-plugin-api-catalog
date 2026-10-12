/**
 * test/translate.test.mjs —— 现译渠道层（lib/translate.js，S8/S9）。
 *
 * 这一层是宿主半边**唯一**会出网到非 GitHub 域名的地方，也是唯一拿宿主模型句柄的地方，
 * 所以判据按"病历"排，不按功能列表排：
 *   A 边界：密钥不进 URL / 不进日志 / 不进任何回包；出网域名必须是登记表派生的那一台。
 *   B 默认零调用：开关关着 ⇒ 模型句柄与 fetch 一次都不许被碰（spy 计数为 0，不是"返回了 off"就算过）。
 *   C 真调的那一发：交给 stream() 的 opts 要自证（provider/model/reasoningEffort 都是实测口径）。
 *   D 成败看帧不看 throw：宿主的错误坐在 finish 帧里；回包没有汉字/超长一律按没译成。
 *   E 复用与 cooldown：逐字相同才复用；失败行也要登记，否则每轮同步都把接口打一遍。
 *   F runPass 的上限与单飞：关着/没备好连 entries 都不读；撞车那一发一个请求都不发。
 *   G 状态 / readiness / 测试连接。
 *
 * ★ 全篇不发真请求：fetchImpl 与模型句柄都是注入的 spy。
 */
import crypto from 'node:crypto';
import { check, runAll, assert, makeFakeFacility, flush, sourceText, makeLlmHandle, makeModelPicker, fixture } from './_helpers.mjs';
import { parseCatalog } from '../lib/parse.js';
import {
  TRANS_CHANNELS, TRANS_CHANNEL_IDS, TRANS_ENDPOINTS, TRANS_HOSTS, TRANS_CRED_FIELDS,
  TRANS_OUT_MAX, TRANS_MAX_PER_ROUND, TRANS_FAIL_COOLDOWN_MS, TRANS_RATE_LIMIT_COOLDOWN_MS, TRANS_ERROR_KEYS,
  TRANS_ERROR_LABELS, DEFAULT_TRANS_CHANNEL, transZhLabel, TENCENT_DEFAULT_REGION,
  DOMAIN_NAME, TABLES, TRANS_HAN_RE,
} from '../lib/domain.js';
import { createAllStores } from '../lib/stores.js';
import { descZhView, DESC_ZH_ROWS } from '../lib/desc-zh.js';
import {
  createTranslateService, channelSpec, baiduSign, baiduUrl, parseBaiduResponse,
  keylessUrl, parseKeylessResponse,
  tencentTc3Sign, tencentPayload, parseTencentResponse,
  aliyunSign, aliyunUrl, aliyunCanonicalQuery, aliyunPercentEncode, parseAliyunResponse,
  xunfeiAuth, xunfeiBody, parseXunfeiResponse,
  TRANS_PROBE_TEXT, TRANS_LLM_SYSTEM, TRANS_LLM_MAX_TOKENS,
} from '../lib/translate.js';

const NOW = 1777000000000;
const APPID = 'APPID-abcdef';
const KEY = 'super-secret-key-9f3a';

/** 一句**内置表肯定没有**的原文（判据要的是"走到现译这一路"，而不是命中回填表）。 */
const RAW = 'Weather alerts and radar imagery for Europe.';

/* ------------------------------------------------------------------ *
 * 夹具：假句柄 / 假 fetch / 装配好的服务
 *   （makeLlmHandle / makeModelPicker 在 _helpers.mjs：浏览器半边的夹具要用同一份形状）
 * ------------------------------------------------------------------ */

/** 假 fetch：记录每一发的 url/opts，回包由用例给。域名、方法、请求头都从这份留痕里判。 */
function makeFetch(payload) {
  const reqs = [];
  const fn = async (url, opts = {}) => {
    reqs.push({ url, opts });
    if (payload?.throw) throw new Error(payload.throw);
    if (payload?.status && payload.status !== 200) {
      return { ok: false, status: payload.status, json: async () => payload.json ?? {} };
    }
    return { ok: true, status: 200, json: async () => payload?.json ?? { trans_result: [{ src: 'x', dst: '一句中文。' }] } };
  };
  return { fn, reqs };
}

/**
 * @param gate 让某一发 stream 挂起的 promise（单飞那条要的就是"第一发还没回来"）
 */
function rig({ prefs = {}, handle, picker, fetchImpl, stores, now, nonce } = {}) {
  const clock = { at: NOW, ...(now ? { at: now } : {}) };
  const holder = { transEnabled: false, transChannel: DEFAULT_TRANS_CHANNEL, ...prefs };
  const f = makeFakeFacility();
  const st = stores ?? createAllStores({ getFacility: () => f, now: () => clock.at });
  const logs = [];
  const log = { warn: (m) => logs.push(String(m)), info: (m) => logs.push(String(m)) };
  const written = [];
  const svc = createTranslateService({
    ctx: handle || picker ? { inject(keys, cb) { cb({ llm: handle, agentDefaultModel: picker }); } } : undefined,
    stores: st,
    getPrefs: () => holder,
    logger: log,
    onWritten: () => written.push(clock.at),
    now: () => clock.at,
    // 阿里那一发的 SignatureNonce 出厂是真随机；用例要核对整条 URL，所以默认钉成一个定值。
    nonce: nonce ?? (() => 'nonce-fixed'),
    fetchImpl: fetchImpl ?? (async () => { throw new Error('这一发不该出网'); }),
  });
  return { f, stores: st, svc, holder, logs, written, clock };
}

/** 库里的一条条目（现译那一轮读的是 entries，所以必须给满 schema 要的字段）。 */
function storedItem(desc, i) {
  const slug = `C::Line${i}`;
  return {
    slug, name: `Line${i}`, desc, host: `h${i}.example`, url: `https://h${i}.example/`,
    auth: 'No', https: 'Yes', cors: 'Yes', category: 'C', firstSeenAt: NOW, lastSeenAt: NOW,
  };
}

async function seedEntries(stores, descs) {
  await stores.entries.writeMany([{ category: 'C', updatedAt: NOW, items: descs.map((d, i) => storedItem(d, i)) }]);
}

function baiduCreds(stores) {
  return Promise.all([
    stores.secrets.write({ channel: 'baidu', field: 'appid', value: APPID, at: NOW }),
    stores.secrets.write({ channel: 'baidu', field: 'key', value: KEY, at: NOW }),
  ]);
}

/** 给某一档写齐凭据（字段名从登记表取，不手抄 ⇒ 域名/字段漂了这条夹具自己先挂）。
 *  登记成 optional 的字段可以不递（递了才写）。 */
function credsFor(stores, channel, values) {
  const fields = TRANS_CRED_FIELDS[channel] || [];
  for (const f of fields) {
    if (values[f.id] === undefined) {
      if (f.optional === true) continue;
      throw new Error(`夹具没给 ${channel}.${f.id} ⇒ 登记表加了字段，用例得跟着给`);
    }
  }
  return Promise.all(fields
    .filter((f) => values[f.id] !== undefined)
    .map((f) => stores.secrets.write({ channel, field: f.id, value: values[f.id], at: NOW })));
}

/*
 * 三家官方算例（2026-10-06 逐层跑通：tmp/sig-vectors.mjs 的读数与本文件一致）。
 * ★ 这三组常量是**厂商文档里的假设参数**，不是我们自己编的：算例的输入与期望输出成对抄，
 *   任何一侧漂了（拼接少一行、百分号编码少一个字符）期望值就对不上，用例立刻红。
 */
const TC_DOC = {
  secretId: `AKID${'*'.repeat(32)}`,
  secretKey: '*'.repeat(32),
  ts: 1551113065,
  payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
  hashedPayload: '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064',
  hashedCanonical: '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84',
  secretDate: 'da98fb70dcf6b112dc21038d1eeeb3a95c74b4dcb12c1131f864f6066bd02be0',
  secretService: '8d70cbefb03939f929db64d32dc2ba89b1095620119fe3e050e2b18c5bd2752f',
  secretSigning: 'b596b923aad85185e2d1f6659d2a062e0a86731226e021e61bfe06f7ed05f5af',
  signature: '10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f',
};
const ALI_DOC = {
  accessKeyId: 'testid',
  accessKeySecret: 'testsecret',
  params: {
    Action: 'DescribeDedicatedHosts',
    Version: '2014-05-26',
    Format: 'JSON',
    AccessKeyId: 'testid',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: 'edb2b34af0af9a6d14deaf7c1a5315eb',
    Timestamp: '2023-03-13T08:34:30Z',
    RegionId: 'cn-beijing',
  },
  signature: '9NaGiOspFP5UPcwX8Iwt2YJXXuk=',
};
const XF_DOC = {
  apiKey: `apikey${'X'.repeat(26)}`,
  apiSecret: `apisecret${'X'.repeat(23)}`,
  date: 'Thu, 18 Nov 2021 03:05:18 GMT',
  signature: 'f1JArA6ktheNPofP4WX8264qNFNBA8HZB31O/deJcuc=',
  authorization: 'YXBpX2tleT0iYXBpa2V5WFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFgiLCBhbGdvcml0aG09ImhtYWMtc2hhMjU2'
    + 'IiwgaGVhZGVycz0iaG9zdCBkYXRlIHJlcXVlc3QtbGluZSIsIHNpZ25hdHVyZT0iZjFKQXJBNmt0aGVOUG9mUDRXWDgyNjRxTkZOQkE4SFpCMzFPL2RlSmN1Yz0i',
};

/*
 * 真发用例用的凭据（**假值**，形状照各家控制台里能看到的样）。
 * 每条真发用例最后都拿 assertNoLeak 扫一遍：这一份里的"密钥位"字段不许出现在 URL / 头 / 正文 / peek / 日志里。
 */
const TC_REAL = {
  secret_id: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3example',
  secret_key: 'Gu5t9xGARNpq86cd98joQYCN3exampleregg',
  region: 'ap-shanghai',
};
const ALI_REAL = {
  access_key_id: 'LTAIexampleKeyId000001',
  access_key_secret: 'accessKeySecretExample0000001',
};
const XF_REAL = {
  appid: 'appexample001',
  api_key: 'apiKeyExample0000000000001',
  api_secret: 'apiSecretExample000000000000001',
};
/** 各家"密钥位"字段（进 HMAC/MD5 的那一栏）；公开的 id 不在这里 —— id 该出现在哪一格由用例自己钉。 */
const SECRET_FIELDS = {
  baidu: ['key'],
  tencent: ['secret_key'],
  aliyun: ['access_key_secret'],
  xunfei: ['api_secret'],
};

/**
 * 密钥不许出现在任何**能被读出来的地方**：出网 URL、请求头、正文、自证读数 peek()、日志。
 * ★ 腾讯的 SecretId 与讯飞的 api_key 按**官方协议**要发出去（前者进 Authorization 的 Credential=，
 *   后者进 base64 的 authorization 查询参数），所以它们不在 SECRET_FIELDS 这一份清单里；
 *   这一条不掩盖那件事：讯飞那条用例把"api_key 确实在查询串里"逐字钉出来，说清是厂商口径。
 */
function assertNoLeak(r, reqs, channel, values, where) {
  const surfaces = [
    ['出网那一发', JSON.stringify(reqs.map((q) => ({ url: q.url, headers: q.opts.headers ?? {}, body: q.opts.body ?? '' })))],
    ['peek 读数', JSON.stringify(r.svc.peek())],
    ['日志', r.logs.join('\n')],
  ];
  for (const field of SECRET_FIELDS[channel]) {
    const v = String(values[field] ?? '');
    assert.ok(v.length >= 8, `${channel}.${field} 的夹具值太短，扫不出泄漏`);
    for ( const [name, text] of surfaces) {
      assert.equal(text.includes(v), false, `${where}：${channel}.${field} 出现在${name}里（它会随诊断被贴进工单）`);
    }
  }
}

/** 从内置表里取一条**真有中文**的原文（不手抄句子：表改了这条判据照样咬得住回填表）。 */function builtinSample() {
  const row = DESC_ZH_ROWS.find(([s, z]) => s !== z && descZhView(s).translated && descZhView(s).zh === z);
  assert.ok(row, '内置表里取不到一条真有中文的原文 ⇒ 表或 translated 判据漂了');
  return { src: row[0], zh: row[1] };
}

/* ------------------------------------------------------------------ *
 * A 边界：密钥与域名
 * ------------------------------------------------------------------ */

check('渠道登记表：六档全部 implemented，每档的端点域名都在派生白名单里（用户 2026-10-06 裁定三家必须接入、2026-10-07 裁定免费接口排第一）', () => {
  assert.deepEqual(TRANS_CHANNEL_IDS, TRANS_CHANNELS.map((c) => c.id));
  for (const c of TRANS_CHANNELS) {
    assert.ok(c.label && c.quota && c.note, `${c.id} 的登记表少了一样，设置页就会出现只有名字的芯片`);
    assert.equal(typeof c.needsKey, 'boolean');
    assert.equal(typeof c.implemented, 'boolean');
    assert.equal(TRANS_ENDPOINTS[c.id] === undefined, false, `${c.id} 没登端点（host_llm 也必须是空串而不是缺键）`);
    if (c.needsKey === true) assert.ok(TRANS_CRED_FIELDS[c.id]?.length, `${c.id} 要密钥却没登记字段`);
    // 反向：不要凭据的那一档**不许**登记字段（界面会摆没人消费的输入框，闸门也会自相矛盾）
    if (c.needsKey !== true) {
      assert.equal((TRANS_CRED_FIELDS[c.id] || []).length, 0, `${c.id} 不要凭据却登记了字段`);
    }
    if (TRANS_ENDPOINTS[c.id]) {
      const host = new URL(TRANS_ENDPOINTS[c.id]).hostname;
      assert.equal(TRANS_HOSTS.includes(host), true, `${c.id} 的端点域名没进白名单`);
    }
  }
  // 排第一（用户 2026-10-07 裁定「和热榜一样」）与出厂档（没跟着挪）是**两件事**：芯片顺序 ≠ 默认值。
  assert.equal(TRANS_CHANNELS[0].id, 'keyless', `第一档不是免费接口：${TRANS_CHANNELS[0].id}`);
  assert.equal(DEFAULT_TRANS_CHANNEL, 'host_llm', '出厂档跟着芯片顺序挪了：那一改就把默认出网方向换了');
  assert.equal(new URL(TRANS_ENDPOINTS.keyless).hostname, 'translate.googleapis.com');
  const unimplemented = TRANS_CHANNELS.filter((c) => c.implemented !== true).map((c) => c.id);
  assert.deepEqual(unimplemented, [],
    '登记表里又出现未接入的档位 ⇒ 本文件那三条官方算例之外还得补一条，且设置页要重新说明');
  // 每家签的到底是什么，写在 note 里：界面只照 note 说，不另编一套算法名。
  assert.match(channelSpec('tencent').note, /TC3-HMAC-SHA256/);
  assert.match(channelSpec('aliyun').note, /HMAC-SHA1/);
  assert.match(channelSpec('xunfei').note, /HMAC-SHA256/);
  // 免费接口那一档的话术：它不是官方授权接口，额度没有承诺 —— 界面照这一句念，不许自己写"免费"两个字。
  assert.equal(channelSpec('keyless').needsKey, false);
  assert.match(channelSpec('keyless').quota, /没有承诺的额度/);
  assert.match(channelSpec('keyless').note, /代理/);
  assert.equal(new URL(TRANS_ENDPOINTS.xunfei).hostname, 'itrans.xf-yun.com',
    '讯飞新接口是带连字符的 xf-yun.com；旧文档里的 itrans.xfyun.cn 不是同一个服务');
  assert.equal(new URL(TRANS_ENDPOINTS.tencent).hostname, 'tmt.tencentcloudapi.com');
  assert.equal(new URL(TRANS_ENDPOINTS.aliyun).hostname, 'mt.cn-hangzhou.aliyuncs.com');
});

check('百度签名：拼接式与官方口径逐字一致，密钥只进摘要不进 URL', () => {
  const salt = String(NOW);
  const sign = baiduSign({ appid: APPID, text: RAW, salt, key: KEY });
  assert.equal(sign, crypto.createHash('md5').update(`${APPID}${RAW}${salt}${KEY}`, 'utf8').digest('hex'));
  const url = baiduUrl({ endpoint: TRANS_ENDPOINTS.baidu, appid: APPID, text: RAW, salt, sign });
  assert.equal(url.includes(KEY), false, '密钥出现在了 URL 里（它会进浏览器历史、代理日志与宿主的请求记录）');
  assert.ok(url.includes(`sign=${sign}`) && url.includes(`appid=${APPID}`) && url.includes('to=zh'));
  assert.equal(new URL(url).hostname, 'fanyi-api.baidu.com');
  assert.equal(TRANS_HOSTS.includes(new URL(url).hostname), true, '签名与端点两头对不上：白名单漏了这一档');
});

check('百度回包四种形状：正常取值 / error_code 当失败 / 缺 trans_result 当坏包 / 无汉字与超长当没译成', () => {
  const ok = parseBaiduResponse({ trans_result: [{ src: 'a', dst: '一句中文。' }, { src: 'b', dst: '还有半句。' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.zh, '一句中文。还有半句。', '多行回包要接成一句（"一次一句"的口径在这里收尾）');
  const err = parseBaiduResponse({ error_code: '54001', error_msg: 'Sign invalid' });
  assert.equal(err.ok, false);
  assert.equal(err.errKey, 'http');
  assert.ok(err.errText.includes('54001'), '官方错误码没带出来，用户去控制台该查什么');
  assert.equal(parseBaiduResponse({ result: 'x' }).errKey, 'bad_json');
  assert.equal(parseBaiduResponse(null).errKey, 'bad_json');
  assert.equal(parseBaiduResponse({ trans_result: [{ dst: 'Still English.' }] }).errKey, 'no_han');
  assert.equal(parseBaiduResponse({ trans_result: [] }).errKey, 'empty');
  assert.equal(parseBaiduResponse({ trans_result: [{ dst: '汉'.repeat(TRANS_OUT_MAX + 1) }] }).errKey, 'too_long');
});

check('出网那道域名闸在 httpCall 的第一行：白名单里少一台就一个字节都不发（新增一档不许开后门）', async () => {
  // 源码那一半：闸门必须排在发送点之前。行为那一半只能证"有闸"，证不了"闸在第一行"——
  // 而 2026-10-07 加的这一档恰恰是"新渠道顺手在别处发"最形状的时候。
  const src = await sourceText('lib/translate.js');
  const at = src.indexOf('async function httpCall({');
  assert.ok(at > 0, '找不到 httpCall 的锚点：这条判据不许悄悄永真');
  const body = src.slice(at);
  const gate = body.indexOf('TRANS_HOSTS.includes(host)');
  const send = body.indexOf('fetchImpl(url');
  assert.ok(gate > 0, 'httpCall 里那道域名闸没了（或被人搬走了）：白名单从此没人执行');
  assert.ok(send > 0, 'httpCall 里找不到发送点 ⇒ 这条顺序判据在测空气');
  assert.equal(gate < send, true, '域名闸排在发送之后：先把那一发发出去再判白名单，等于没判');

  // 行为那一半：真把一台从名单里摘掉 ⇒ 那一发在闸门上收口，fetchImpl 一次都没被调。
  const host = new URL(TRANS_ENDPOINTS.keyless).hostname;
  const idx = TRANS_HOSTS.indexOf(host);
  assert.ok(idx >= 0, `派生白名单里没有 ${host}：夹具不齐，下面两句会空转`);
  const stub = makeFetch({ json: KEYLESS_OK });
  const r = rig({ prefs: { transEnabled: true, transChannel: 'keyless' }, fetchImpl: stub.fn });
  const cut = TRANS_HOSTS.splice(idx, 1)[0];
  let res = null;
  try {
    res = await r.svc.translateOne(RAW);
  } finally {
    TRANS_HOSTS.splice(idx, 0, cut);
  }
  assert.deepEqual([...TRANS_HOSTS].includes(host), true, '摘掉的域名没装回去：后面每一条用例都在替这个现场说话');
  assert.equal(res.ok, false, `域名不在白名单却还发了出去：${JSON.stringify(res)}`);
  assert.equal(stub.reqs.length, 0, '闸门放行之后 fetchImpl 真被调了：那一发已经出网');

  // 对照：装回去同一档发得出去 —— 否则上面两句等于在测一个本来就发不出去的形状。
  // ★ 换一句原文：RAW 那一发已经登记了失败行，同一句在 cooldown 里本来就不会重发（那是 E 组的判据）。
  const back = await r.svc.translateOne('Marine tide and current predictions for UK ports.');
  assert.equal(back.ok, true, `白名单还原后同一档还是发不出去：${JSON.stringify(back)}`);
  assert.equal(stub.reqs.length, 1);
});

check('百度那一发的域名闸：出网只打登记的那一台，方法是 GET，头里不带任何凭据', async () => {
  const hosts = Object.values(TRANS_ENDPOINTS).filter(Boolean).map((u) => new URL(u).hostname);
  assert.deepEqual([...new Set(hosts)].sort(), [...TRANS_HOSTS].sort(), '白名单不是从端点表派生的');
  const fetchStub = makeFetch();
  const r = rig({ prefs: { transEnabled: true, transChannel: 'baidu' }, fetchImpl: fetchStub.fn });
  await baiduCreds(r.stores);
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fetchStub.reqs.length, 1);
  assert.equal(fetchStub.reqs[0].opts.method, 'GET', '翻译这一路也写死 GET；要放宽红线得先改口径再改代码');
  const headers = JSON.stringify(fetchStub.reqs[0].opts.headers ?? {}).toLowerCase();
  for (const banned of ['cookie', 'authorization', 'apikey']) {
    assert.equal(headers.includes(banned), false, `请求头里带了 ${banned}`);
  }
  assert.equal(fetchStub.reqs[0].url.startsWith(TRANS_ENDPOINTS.baidu), true);
  assert.equal(fetchStub.reqs[0].url.includes(KEY), false);
  assert.equal(r.svc.peek('lastUrl').includes(KEY), false, '自证读数里也不许留密钥（它会随诊断被贴进工单）');
});

check('密钥不出现在日志里：成功与失败两头的日志都只提渠道与位数', async () => {
  const r = rig({ prefs: { transEnabled: true, transChannel: 'baidu' } });
  await baiduCreds(r.stores);
  // fetchImpl 缺省那一发抛「这一发不该出网」⇒ 走 transport 失败
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, false);
  assert.equal(res.errKey, 'transport');
  const all = r.logs.join('\n');
  assert.equal(all.includes(KEY), false, `日志里出现了密钥：${all}`);
  assert.equal(all.includes(APPID), false);
});

/* ------------------------------------------------------------------ *
 * A1 渠道〇：免费接口（Google 网页版翻译，用户 2026-10-07 裁定接入并排第一）
 *   · 这一档与四家官方的差别不是"更简单的签名"，是**没有签名也没有凭据** ⇒ 闸门、回显、
 *     失败归因三处都得走另一支；写死 id 清单的实现在这里全绿、在下一次加档时全红。
 *   · 它在这台机器上只有经代理才通（读数在 §9.1r）⇒ "配置坏了"必须报成配置坏了，
 *     不许回落直连再"碰碰看"（那一条的锚在 test/net.test.mjs nt-14，这里钉的是渠道层怎么收口）。
 * ------------------------------------------------------------------ */

/** 本机 2026-10-07 经 127.0.0.1:7897 实测回来的那份形状（多一个第二段、少一个都不算对上账）。 */
const KEYLESS_OK = [
  [['有关英国公共图书馆的数据。', 'Data about public libraries in the United Kingdom.', null, null, 10]],
  [null, [['en', 1, [[9999, [[1000, 1]]]]]], ['en', null, 1, 0, 1.0]],
];

check('免费接口的 URL：五个参数逐字（client=gtx / sl=auto / tl=zh-CN / dt=t / q=原句），端点从登记表取，串里没有一个凭据位', () => {
  const text = 'Data about & "public" libraries? a=1&b=2 中文 尾巴';
  const url = new URL(keylessUrl({ endpoint: TRANS_ENDPOINTS.keyless, text }));
  assert.equal(`${url.origin}${url.pathname}`, TRANS_ENDPOINTS.keyless, '端点不是登记的那一个');
  assert.equal(url.hostname, 'translate.googleapis.com');
  assert.equal(url.searchParams.get('client'), 'gtx');
  assert.equal(url.searchParams.get('sl'), 'auto');
  assert.equal(url.searchParams.get('tl'), 'zh-CN', '目标语言写死中文：这一档只服务"中文说明"那一格');
  assert.equal(url.searchParams.get('dt'), 't');
  // ★ 编码必须可逆：直接拼字符串的话，原文里的 & 会把 q 截断成两截（症状是"只译了半句"）
  assert.equal(url.searchParams.get('q'), text, `原文没逐字进 q：${url.searchParams.get('q')}`);
  // 原文里的 & 与 = 必须被编掉：没编的话 q 在半路截断，症状是"只译了半句"
  assert.equal(url.searchParams.has('b'), false, `原文里的 & 变成了新参数：${url.search}`);
  assert.equal(url.searchParams.has('a'), false, `原文里的 = 变成了新参数：${url.search}`);
  assert.deepEqual(
    [...url.searchParams.keys()].filter((k) => /key|appid|sign|secret|token|salt/i.test(k)),
    [], '免密钥的那一档在 URL 里带了凭据位');
  // 原文超上限在发送侧被截（TRANS_IN_MAX），URL 不该因此爆长
  const longUrl = new URL(keylessUrl({ endpoint: TRANS_ENDPOINTS.keyless, text: 'x'.repeat(5000) }));
  assert.ok(longUrl.searchParams.get('q').length <= 5000);
});

check('免费接口的回包：实测那份拼成整句，多段逐段接；读不出形状算 bad_json，不许归到 empty（两件事两句话）', () => {
  const ok = parseKeylessResponse(KEYLESS_OK);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.zh, '有关英国公共图书馆的数据。');

  const joined = parseKeylessResponse([[['甲半句。', 'A'], ['乙半句。', 'B']]]);
  assert.equal(joined.ok, true);
  assert.equal(joined.zh, '甲半句。乙半句。', '多段没逐段拼接（标点也是回包给的那一份）');

  // 形状认不出来（对方改了接口）与这句真没译出来，是两条不同的话 —— 混成一句就等于让用户替我们盯上游。
  // ★ 判据分界：**装段子的第一层数组没了**（整体是空表、或那一位不是数组）才是坏包；
  //   第一层还在、只是段里没字，那是"没译出来"。
  for (const junk of [{}, null, undefined, '[]', 42, 'x', [], { 0: [] }]) {
    const bad = parseKeylessResponse(junk);
    assert.equal(bad.ok, false);
    assert.equal(bad.errKey, 'bad_json', `${JSON.stringify(junk)} 归成了 ${bad.errKey}，本该是坏包`);
    assert.equal(bad.zh, '', '失败还带着半句');
  }
  for (const none of [[[]], [[null]], [[1, 2]], [['']], [['  ']]]) {
    const r = parseKeylessResponse(none);
    assert.equal(r.errKey, 'empty', `${JSON.stringify(none)} 归成了 ${r.errKey}，形状是对的该按没译出收`);
  }
  const noHan = parseKeylessResponse([[['abc', 'abc']]]);
  assert.equal(noHan.errKey, 'no_han');
  const tooLong = parseKeylessResponse([[[('汉'.repeat(TRANS_OUT_MAX + 1)), 'x']]]);
  assert.equal(tooLong.errKey, 'too_long');
});

check('免费接口真发那一发：GET 到登记的端点、头里没有凭据、库里落的就是那句实测译文', async () => {
  const stub = makeFetch({ json: KEYLESS_OK });
  const r = rig({ prefs: { transEnabled: true, transChannel: 'keyless' }, fetchImpl: stub.fn });
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.zh, '有关英国公共图书馆的数据。');
  assert.equal(stub.reqs.length, 1);
  assert.equal(stub.reqs[0].opts.method, 'GET', '这一档也写死 GET（抓取全程只读那条律对它同样成立）');
  assert.equal(stub.reqs[0].url.startsWith(TRANS_ENDPOINTS.keyless), true);
  assert.equal(stub.reqs[0].url.includes(RAW), false, '原文没被编码（空格/与号会把 q 截断）');
  const headers = JSON.stringify(stub.reqs[0].opts.headers ?? {}).toLowerCase();
  for (const banned of ['cookie', 'authorization', 'apikey']) {
    assert.equal(headers.includes(banned), false, `免密钥档的请求头里带了 ${banned}`);
  }
  assert.equal(r.svc.peek('lastKind'), 'keyless', '自证读数没记下这一发是哪一档');
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.trans), 1, '现译落库这一行没写进去');
});

check('免费接口的闸门看 needsKey 而不是手抄 id 清单：库里一格凭据都没填也「现在能发」（hasAll 对无字段的档是 false）', async () => {
  const r = rig({ prefs: { transEnabled: true, transChannel: 'keyless' } });
  // 这一对读数就是那条律的现场：免密钥档 hasAll 必然是 false，闸门若走 hasAll 那一支就会判成 no_credential
  assert.equal(await r.stores.secrets.hasAll('keyless'), false, '夹具不齐：这一档不该有任何凭据字段');
  const ready = await r.svc.readiness();
  assert.equal(ready.can, true, `免密钥档被判成发不出去：${JSON.stringify(ready)}`);
  assert.equal(ready.errKey, '');

  // 对照两支：要凭据的档没填 ⇒ no_credential；宿主模型那档看句柄不看凭据
  const baiduR = rig({ prefs: { transEnabled: true, transChannel: 'baidu' } });
  assert.equal((await baiduR.svc.readiness()).errKey, 'no_credential');
  const llmR = rig({ prefs: { transEnabled: true, transChannel: 'host_llm' } });
  assert.equal((await llmR.svc.readiness()).errKey, 'unavailable');
  const withHandle = rig({
    prefs: { transEnabled: true, transChannel: 'host_llm' }, handle: makeLlmHandle(),
  });
  assert.equal((await withHandle.svc.readiness()).can, true);
});

check('免费接口经代理才通：传输层抛 proxy_config ⇒ 渠道按 transport 收口并把那句原因带回界面', async () => {
  const reason = '自定义代理地址不可用：只支持 http:// 代理（CONNECT 隧道），socks 与 https 代理未实现';
  const stub = makeFetch({ throw: reason });
  const r = rig({ prefs: { transEnabled: true, transChannel: 'keyless' }, fetchImpl: stub.fn });
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, false);
  assert.equal(res.errKey, 'transport', `代理配置坏掉被归成了 ${res.errKey}：界面就分不清该改设置还是该等网络`);
  assert.equal(res.errText.includes('socks'), true, res.errText);
  assert.equal(res.zh, '', '失败还带着半句');
  assert.equal(r.svc.peek('failed'), 1);
  // 失败行也要登记（否则每一轮同步都把同一个坏配置打一遍）
  assert.equal(r.f.rowCount(DOMAIN_NAME, TABLES.trans) >= 1, true, '代理失败没留失败行');
});

check('测试连接（免费接口）：探针那句走隧道那一份地址，库里一行都不留，note 念的是回来的译文', async () => {
  const stub = makeFetch({ json: KEYLESS_OK });
  const r = rig({ prefs: { transEnabled: false, transChannel: 'keyless' }, fetchImpl: stub.fn });
  const res = await r.svc.testConnection();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.channel, 'keyless');
  assert.ok(res.note.includes('有关英国公共图书馆的数据。'), res.note);
  assert.equal(stub.reqs.length, 1, '测试连接发了不止一发');
  assert.equal(new URL(stub.reqs[0].url).searchParams.get('q'), TRANS_PROBE_TEXT,
    '探针原文不是登记的那一句：换一句就会把"没配额"误判成"这句太长"');
  assert.equal((await r.stores.trans.counts()).rows, 0, '测试连接往现译表里写了行');
  // ★ 开关关着也能测：它验的就是"这一档现在发得出去吗"，而这一档现在发不发得出去全看代理选没选对
  assert.equal(r.holder.transEnabled, false);
});

/* ------------------------------------------------------------------ *
 * A2 三家新接的签名与真发（用户 2026-10-06 裁定「腾讯，阿里，讯飞必须接入」，
 *     方法定的是「官方算例钉签名 + 填 key 后真发」）
 *   · 算例那几条钉的是**算法**：厂商文档给的输入 → 文档给的输出，逐层对，一格都不许漂；
 *   · 真发那几条钉的是**发送形状**：签名吃的那一份字节与发出去的那一份字节必须同一份，
 *     且密钥（HMAC/MD5 的 key 位）不许出现在任何能被读出来的地方。
 *   「拼错了离线全绿、真机每一发 401」就是靠这两层夹住的。
 * ------------------------------------------------------------------ */

check('腾讯 TC3-HMAC-SHA256：官方算例逐层复现（少一行、少一层派生都对不上）', () => {
  const tc = tencentTc3Sign({
    secretId: TC_DOC.secretId, secretKey: TC_DOC.secretKey, timestampSeconds: TC_DOC.ts,
    service: 'cvm', host: 'cvm.tencentcloudapi.com', action: 'DescribeInstances',
    contentType: 'application/json; charset=utf-8', payload: TC_DOC.payload,
  });
  assert.equal(tc.hashedPayload, TC_DOC.hashedPayload);
  assert.equal(tc.signedHeaders, 'content-type;host;x-tc-action');
  assert.equal(tc.hashedCanonicalRequest, TC_DOC.hashedCanonical);
  assert.equal(tc.credentialScope, '2019-02-25/cvm/tc3_request');
  assert.equal(tc.stringToSign,
    `TC3-HMAC-SHA256\n${TC_DOC.ts}\n2019-02-25/cvm/tc3_request\n${TC_DOC.hashedCanonical}`);
  // 派生密钥链：这三层任何一层用了错的 key 或错的输入，真机就是 AuthenticationFailure，离线却全绿
  assert.equal(tc.secretDate, TC_DOC.secretDate);
  assert.equal(tc.secretService, TC_DOC.secretService);
  assert.equal(tc.secretSigning, TC_DOC.secretSigning);
  assert.equal(tc.signature, TC_DOC.signature);
  assert.equal(tc.authorization,
    `TC3-HMAC-SHA256 Credential=${TC_DOC.secretId}/2019-02-25/cvm/tc3_request, `
    + 'SignedHeaders=content-type;host;x-tc-action, '
    + `Signature=${TC_DOC.signature}`);
  // 规范请求串的换行结构：空查询串那一行**保留**，CanonicalHeaders 自带结尾换行 ⇒ 它与 SignedHeaders 之间是空行
  const lines = tc.canonicalRequest.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['POST', '/', ''], '规范请求串前三行是 方法/URI/查询串，空查询串不许整行省掉');
  assert.equal(lines[6], '', 'CanonicalHeaders 的结尾换行少了：头块与 SignedHeaders 之间必须隔一个空行');
  assert.equal(lines[7], tc.signedHeaders);
  assert.equal(lines[8], TC_DOC.hashedPayload);
  assert.equal(lines.length, 9, `规范请求串 ${lines.length} 行（应为 9）：${JSON.stringify(lines)}`);
  // 日期从**秒级时间戳按 UTC** 推（文档明写东八区凌晨会全线失败），不是本地日历
  assert.equal(tc.date, new Date(TC_DOC.ts * 1000).toISOString().slice(0, 10));
});

check('阿里 RPC 签名：官方算例的三个中间量 + RFC3986 多编的那五个字符', () => {
  const s = aliyunSign({ params: ALI_DOC.params, accessKeySecret: ALI_DOC.accessKeySecret });
  assert.equal(s.canonicalQuery,
    'AccessKeyId=testid&Action=DescribeDedicatedHosts&Format=JSON&RegionId=cn-beijing'
    + '&SignatureMethod=HMAC-SHA1&SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb&SignatureVersion=1.0'
    + '&Timestamp=2023-03-13T08%3A34%3A30Z&Version=2014-05-26',
    '规范化串要键 ASCII 升序、键值都百分号编码');
  assert.equal(s.stringToSign,
    'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeDedicatedHosts%26Format%3DJSON%26RegionId%3Dcn-beijing'
    + '%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3Dedb2b34af0af9a6d14deaf7c1a5315eb%26SignatureVersion%3D1.0'
    + '%26Timestamp%3D2023-03-13T08%253A34%253A30Z%26Version%3D2014-05-26',
    'StringToSign 是"二次编码"：冒号在规范化串里是 %3A，进 StringToSign 要变成 %253A');
  assert.equal(s.signature, ALI_DOC.signature);
  assert.equal(aliyunPercentEncode("a!b'c(d)e*f g~h"), 'a%21b%27c%28d%29e%2Af%20g~h',
    "encodeURIComponent 不编 !'()* 而阿里要编，~ 反过来必须不编 —— 差一个字符就签名不匹配");
  assert.equal(aliyunCanonicalQuery({ ...ALI_DOC.params, Signature: 'x/y+z' }).includes('Signature='), false,
    '签名自己不该进规范化串（那等于把自己也签了一遍）');
  // 我们自己那一发的参数集（TranslateGeneral）也过同一条链：URL 末尾是签名，串里没有一个字符来自密钥
  const built = aliyunUrl({
    endpoint: TRANS_ENDPOINTS.aliyun, text: RAW,
    accessKeyId: ALI_DOC.accessKeyId, accessKeySecret: ALI_DOC.accessKeySecret,
    nonce: 'n once', timestamp: '2023-03-13T08:34:30Z',
  });
  assert.equal(built.url.startsWith(`${TRANS_ENDPOINTS.aliyun}?`), true);
  assert.match(built.url, /&Signature=[^&]+$/);
  assert.equal(built.url.includes(ALI_DOC.accessKeySecret), false, 'AccessKeySecret 泄漏进了查询串');
  assert.equal(new URL(built.url).searchParams.get('SignatureNonce'), 'n once',
    'nonce 里有空格也得按 RFC3986 编成 %20（用 + 服务端不认）');
});

check('讯飞鉴权：官方算例的两层 base64，request-line 从登记端点推出来', () => {
  const u = new URL(TRANS_ENDPOINTS.xunfei);
  assert.equal(`${u.hostname}${u.pathname}`, 'itrans.xf-yun.com/v1/its',
    '官方文档那发的 host+path（带连字符的 xf-yun，不是旧版的 xfyun.cn）');
  const a = xunfeiAuth({
    apiKey: XF_DOC.apiKey, apiSecret: XF_DOC.apiSecret, endpoint: TRANS_ENDPOINTS.xunfei, date: XF_DOC.date,
  });
  assert.equal(a.signatureOrigin, `host: ${u.hostname}\ndate: ${XF_DOC.date}\nPOST ${u.pathname} HTTP/1.1`,
    '签名原文三行：方法与路径都从登记端点推，不写第二份');
  assert.equal(a.signature, XF_DOC.signature);
  assert.equal(a.authorization, XF_DOC.authorization);
  assert.equal(Buffer.from(a.authorization, 'base64').toString('utf8'), a.authorizationOrigin,
    '第二层就是 authorization_origin 的 base64（解出来少一个空格都对不上文档那发）');
  assert.match(a.authorizationOrigin, /algorithm="hmac-sha256", headers="host date request-line"/);
  const q = new URL(a.url).searchParams;
  assert.equal(q.get('date'), XF_DOC.date, 'date 进了查询串就要参与签名，两处必须同一个值');
  assert.equal(q.get('host'), u.hostname);
  assert.equal(q.get('authorization'), a.authorization);
});

check('两家 POST 的正文：只有这一句原文 + 应用 id，没有库里别的字段', () => {
  assert.equal(tencentPayload(RAW), JSON.stringify({ SourceText: RAW, Source: 'en', Target: 'zh', ProjectId: 0 }));
  const body = JSON.parse(xunfeiBody({ appId: 'app-1', text: RAW }));
  assert.deepEqual(Object.keys(body).sort(), ['header', 'parameter', 'payload']);
  assert.equal(body.header.app_id, 'app-1');
  assert.equal(body.header.status, 3, 'status 不是 3 ⇒ 服务端等下一帧，这一发永远不回');
  assert.equal(body.payload.input_data.status, 3);
  assert.equal(body.parameter.its.from, 'en');
  assert.equal(body.parameter.its.to, 'cn', '讯飞的中文代码是 cn，不是 zh（与另两家不同）');
  assert.equal(Buffer.from(body.payload.input_data.text, 'base64').toString('utf8'), RAW);
});

check('三家回包解析：成功取那一格，错误码算失败并带出码，缺层算坏包，没汉字/超长算没译成', () => {
  const ZH = '欧洲的天气预报与雷达图。';
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  assert.equal(parseTencentResponse({ Response: { TargetText: ZH } }).zh, ZH);
  const tcErr = parseTencentResponse({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名不匹配' } } });
  assert.equal(tcErr.ok, false);
  assert.equal(tcErr.errKey, 'http');
  assert.ok(tcErr.errText.includes('AuthFailure.SignatureFailure'), '厂商错误码没带出来 ⇒ 用户拿什么去提工单');
  assert.equal(parseTencentResponse({}).errKey, 'bad_json');
  assert.equal(parseTencentResponse({ Response: { TargetText: 'English only.' } }).errKey, 'no_han');
  assert.equal(parseTencentResponse({ Response: { TargetText: '' } }).errKey, 'empty');
  assert.equal(parseTencentResponse({ Response: { TargetText: '汉'.repeat(TRANS_OUT_MAX + 1) } }).errKey, 'too_long');

  assert.equal(parseAliyunResponse({ Code: '200', Data: { Translated: ZH } }).zh, ZH);
  const al = parseAliyunResponse({ Code: '30001', Message: 'invalid param' });
  assert.equal(al.errKey, 'http');
  assert.ok(al.errText.includes('30001'));
  assert.equal(parseAliyunResponse({ Code: '200' }).errKey, 'empty');
  assert.equal(parseAliyunResponse({ Data: { Translated: ZH } }).ok, true,
    'Code 缺省但带着译文按成功（文档里成功就是 Code:200；这里别让缺省把成功判死）');
  assert.equal(parseAliyunResponse(null).errKey, 'bad_json');

  const xfOk = parseXunfeiResponse({
    header: { code: 0, status: 3 },
    payload: { result: { text: b64(JSON.stringify({ trans_result: { src: RAW, dst: ZH } })) } },
  });
  assert.equal(xfOk.zh, ZH);
  assert.equal(parseXunfeiResponse({ header: { code: 10007, message: 'license empty' } }).errKey, 'http');
  assert.equal(parseXunfeiResponse({}).errKey, 'bad_json');
  assert.equal(parseXunfeiResponse({ header: { code: 0 }, payload: { result: { text: b64('not json') } } }).errKey, 'bad_json');
  assert.equal(parseXunfeiResponse({ header: { code: 0 } }).errKey, 'empty');
});

const TC_ANSWER = { Response: { TargetText: '欧洲的天气预报与雷达图。', SourceText: RAW } };
const ALI_ANSWER = { Code: '200', Data: { Translated: '欧洲的天气预报与雷达图。' }, RequestId: 'req-example' };
const XF_ANSWER = {
  header: { code: 0, status: 3, message: 'success', sid: 'xf-example' },
  payload: {
    result: {
      text: Buffer.from(JSON.stringify({ trans_result: { src: RAW, dst: '欧洲的天气预报与雷达图。' } }), 'utf8')
        .toString('base64'),
      encoding: 'utf8', status: 3,
    },
  },
};

check('腾讯真发那一发：POST 到登记端点，Authorization 就是照着**发出去的正文**算的那一份', async () => {
  const spy = makeFetch({ json: TC_ANSWER });
  const r = rig({ prefs: { transEnabled: true, transChannel: 'tencent' }, fetchImpl: spy.fn });
  await credsFor(r.stores, 'tencent', TC_REAL);
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(spy.reqs.length, 1);
  const { url, opts } = spy.reqs[0];
  assert.equal(url, TRANS_ENDPOINTS.tencent);
  assert.equal(opts.method, 'POST', 'TMT 官方就吃 POST：这一发的 POST 是厂商形状，不是我们把抓取那侧的红线放宽了');
  const h = opts.headers;
  assert.equal(h['X-TC-Action'], 'TextTranslate');
  assert.equal(h['X-TC-Version'], '2018-03-21');
  assert.equal(h['X-TC-Region'], TC_REAL.region);
  assert.equal(h['content-type'], 'application/json');
  assert.equal(JSON.parse(opts.body).SourceText, RAW, '正文里不是这一句原文 = 把 A 的描述挂到 B 上');
  assert.equal(JSON.parse(opts.body).Target, 'zh');
  // ★ 拿**录下来的 body 与头**重算一遍：签名吃的字节与发出去的字节若是两份，真机每一发 SignatureDoesNotMatch
  const again = tencentTc3Sign({
    secretId: TC_REAL.secret_id, secretKey: TC_REAL.secret_key,
    timestampSeconds: Number(h['X-TC-Timestamp']), service: 'tmt',
    host: new URL(TRANS_ENDPOINTS.tencent).hostname, action: 'TextTranslate',
    contentType: h['content-type'], payload: opts.body,
  });
  assert.equal(h.Authorization, again.authorization, 'Authorization 与发出去的正文对不上（两次 stringify 之间差了一个空格也算错）');
  assert.equal(h.Authorization.startsWith('TC3-HMAC-SHA256 Credential='), true);
  assert.equal(h.Authorization.includes(TC_REAL.secret_key), false, 'SecretKey 泄漏进了 Authorization');
  assert.equal(new Date(Number(h['X-TC-Timestamp']) * 1000).toISOString().slice(0, 10), again.date,
    'X-TC-Timestamp 与签名用的时间戳不是同一个 ⇒ 服务端按头里的时间重算就对不上');
  assertNoLeak(r, spy.reqs, 'tencent', TC_REAL, '腾讯那一发');
});

check('腾讯地域留空：optional 字段不挡闸门，发送侧回落登记的默认地域', async () => {
  const spy = makeFetch({ json: TC_ANSWER });
  const r = rig({ prefs: { transEnabled: true, transChannel: 'tencent' }, fetchImpl: spy.fn });
  await credsFor(r.stores, 'tencent', { secret_id: TC_REAL.secret_id, secret_key: TC_REAL.secret_key });
  assert.deepEqual(await r.svc.readiness(), { can: true, errKey: '' }, '地域是 optional，缺了不该挡闸门');
  assert.equal((await r.svc.translateOne(RAW)).ok, true);
  assert.equal(spy.reqs[0].opts.headers['X-TC-Region'], TENCENT_DEFAULT_REGION,
    '回落的地域必须与 domain 登记的那一个同源（hint 文案与发送侧不许各写一遍）');
});

check('阿里真发那一发：GET，签名在查询串末尾，且签的就是串里那几件', async () => {
  const spy = makeFetch({ json: ALI_ANSWER });
  const r = rig({ prefs: { transEnabled: true, transChannel: 'aliyun' }, fetchImpl: spy.fn });
  await credsFor(r.stores, 'aliyun', ALI_REAL);
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.channel, 'aliyun');
  const { url, opts } = spy.reqs[0];
  assert.equal(opts.method, 'GET', '阿里通用翻译官方是 GET（RPC 风格），这里不许写方法');
  const sent = new URL(url);
  assert.equal(sent.hostname, new URL(TRANS_ENDPOINTS.aliyun).hostname);
  assert.equal(sent.searchParams.get('Action'), 'TranslateGeneral');
  assert.equal(sent.searchParams.get('Version'), '2018-10-12');
  assert.equal(sent.searchParams.get('SourceLanguage'), 'en');
  assert.equal(sent.searchParams.get('TargetLanguage'), 'zh');
  assert.equal(sent.searchParams.get('FormatType'), 'text');
  assert.equal(sent.searchParams.get('RegionId'), 'cn-hangzhou');
  assert.equal(sent.searchParams.get('AccessKeyId'), ALI_REAL.access_key_id);
  assert.equal(sent.searchParams.get('SourceText'), RAW, '原文要逐字进查询串（多了归一或截断就是把 A 挂到 B）');
  assert.equal(sent.searchParams.get('SignatureNonce'), 'nonce-fixed',
    'nonce 没吃注入项 ⇒ 这条用例核对不了整条 URL，也就说不出"签名覆盖的就是这几件"');
  assert.match(url, /&Signature=[^&]+$/, '签名必须是查询串最后一个参数');
  // ★ 独立重算：把录下来的查询串去掉 Signature 再签一次，要等于串里那一个
  const params = Object.fromEntries(sent.searchParams);
  const sig = params.Signature;
  delete params.Signature;
  assert.equal(sig, aliyunSign({ params, accessKeySecret: ALI_REAL.access_key_secret }).signature,
    '签名覆盖的参数集合与实际发出去的不是同一份');
  assert.equal(sent.searchParams.get('Timestamp'), `${new Date(NOW).toISOString().slice(0, 19)}Z`,
    'Timestamp 用的是本次时刻（服务端按它校时效）');
  assertNoLeak(r, spy.reqs, 'aliyun', ALI_REAL, '阿里那一发');
});

check('讯飞真发那一发：正文走 base64，鉴权三件在查询串；api_key 确实在串里（厂商口径，如实钉住）', async () => {
  const spy = makeFetch({ json: XF_ANSWER });
  const r = rig({ prefs: { transEnabled: true, transChannel: 'xunfei' }, fetchImpl: spy.fn });
  await credsFor(r.stores, 'xunfei', XF_REAL);
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.zh, '欧洲的天气预报与雷达图。');
  const { url, opts } = spy.reqs[0];
  assert.equal(opts.method, 'POST', '机器翻译（新）官方就吃 POST');
  const sent = new URL(url);
  assert.equal(`${sent.hostname}${sent.pathname}`, 'itrans.xf-yun.com/v1/its');
  const date = sent.searchParams.get('date');
  assert.equal(date, new Date(NOW).toUTCString(), 'date 是本次时刻的 UTC 串，且与参与签名的那一个同一个');
  const again = xunfeiAuth({ apiKey: XF_REAL.api_key, apiSecret: XF_REAL.api_secret, endpoint: TRANS_ENDPOINTS.xunfei, date });
  assert.equal(sent.searchParams.get('authorization'), again.authorization,
    '查询串里的 authorization 与照着 date 算的那份不一致 ⇒ 头/串两边日期漂了');
  assert.equal(sent.searchParams.get('host'), new URL(TRANS_ENDPOINTS.xunfei).hostname);
  const authOrigin = Buffer.from(sent.searchParams.get('authorization'), 'base64').toString('utf8');
  assert.ok(authOrigin.includes(`api_key="${XF_REAL.api_key}"`),
    '★ api_key 按官方协议就在这段 base64 里（base64 不是加密）：这是厂商口径，判据把它钉住而不是假装看不见');
  assert.equal(authOrigin.includes(XF_REAL.api_secret), false);
  const body = JSON.parse(opts.body);
  assert.equal(body.header.app_id, XF_REAL.appid);
  assert.equal(Buffer.from(body.payload.input_data.text, 'base64').toString('utf8'), RAW);
  assert.equal(opts.body.includes(XF_REAL.api_key), false, 'api_key 只在鉴权串，不该混进正文');
  assertNoLeak(r, spy.reqs, 'xunfei', XF_REAL, '讯飞那一发');
});

check('三家的失败那一发也登记，且失败行里不许带半句译文（同宿主模型那一档的判据）', async () => {
  const cases = [
    ['tencent', { json: { Response: { Error: { Code: 'FailedToDownloadModel', Message: 'x' } } } }, TC_REAL, 'FailedToDownloadModel'],
    ['aliyun', { json: { Code: '404', Message: 'not found' } }, ALI_REAL, '404'],
    ['xunfei', { json: { header: { code: 10045, message: 'quota empty' } } }, XF_REAL, '10045'],
  ];
  for (const [id, payload, creds, codeIn] of cases) {
    const spy = makeFetch(payload);
    const r = rig({ prefs: { transEnabled: true, transChannel: id }, fetchImpl: spy.fn });
    await credsFor(r.stores, id, creds);
    const res = await r.svc.translateOne(RAW);
    assert.equal(res.ok, false, `${id}：厂商错误码被当成成功 ⇒ 库里存了一句根本不存在的"译文"`);
    assert.equal(res.errKey, 'http', `${id} 的 errKey 回的是 ${res.errKey}`);
    assert.ok(String(res.errText).includes(codeIn), `${id} 没把厂商错误码带出来：${res.errText}`);
    assert.equal(spy.reqs.length, 1);
    const bad = (await r.stores.trans.readAll()).find((x) => x.src === RAW);
    assert.ok(bad && bad.ok === false, `${id}：失败没登记 ⇒ 下一轮同步还会把同一句再打一遍`);
    assert.equal(bad.zh, undefined, `${id}：失败行带着 zh 入库`);
  }
});

check('HTTP 层与超时的三条：非 2xx / 回包不是 JSON / fetch 抛异常，三样都归到各自的 errKey', async () => {
  for (const [step, want] of [
    [{ status: 403, json: {} }, 'http'],
    [{ throw: 'socket hang up' }, 'transport'],
  ]) {
    const spy = makeFetch(step);
    const r = rig({ prefs: { transEnabled: true, transChannel: 'tencent' }, fetchImpl: spy.fn });
    await credsFor(r.stores, 'tencent', TC_REAL);
    const res = await r.svc.translateOne(RAW);
    assert.equal(res.errKey, want, `腾讯那一发的 ${JSON.stringify(step)} 回的是 ${res.errKey}`);
    assert.equal(res.ok, false);
  }
  const notJson = { ok: true, status: 200, json: async () => { throw new Error('Unexpected token <'); } };
  const r2 = rig({ prefs: { transEnabled: true, transChannel: 'aliyun' }, fetchImpl: async () => notJson });
  await credsFor(r2.stores, 'aliyun', ALI_REAL);
  assert.equal((await r2.svc.translateOne(RAW)).errKey, 'bad_json');
});

/* ------------------------------------------------------------------ *
 * B 默认零调用
 * ------------------------------------------------------------------ */

check('开关关着（出厂态）：句柄与 fetch 一次都不碰，返回 off 并带话术，也不留失败行', async () => {
  const handle = makeLlmHandle();
  const fetchStub = makeFetch();
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), fetchImpl: fetchStub.fn });
  await baiduCreds(r.stores);
  const one = await r.svc.translateOne(RAW);
  assert.equal(one.ok, false);
  assert.equal(one.errKey, 'off');
  assert.ok(one.note.length > 0, 'off 没带话术 ⇒ 界面上就是"点了没反应"');
  assert.equal(handle.calls.length, 0, '开关关着却把模型句柄调了 ⇒ "默认零调用"是假的');
  assert.equal(fetchStub.reqs.length, 0);
  assert.equal((await r.stores.trans.counts()).rows, 0, '被拒的一发不该在译文表里留行');
  const pass = await r.svc.runPass({ reason: 'timer' });
  assert.equal(pass.skipped, 'off');
  assert.equal(handle.calls.length, 0);
});

check('开关只认真布尔：字符串 "true" 不算开（宁可少发一发，不可多发一发）', async () => {
  const handle = makeLlmHandle();
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: 'true' } });
  assert.equal((await r.svc.translateOne(RAW)).errKey, 'off');
  assert.equal(handle.calls.length, 0);
});

check('runPass 在"关着"与"渠道没备好"两支都不读条目表（早收口，不为算剩余白读 2019 行）', async () => {
  const stores = createAllStores({ getFacility: () => makeFakeFacility(), now: () => NOW });
  let reads = 0;
  const orig = stores.entries.readAllItems.bind(stores.entries);
  stores.entries.readAllItems = () => { reads += 1; return orig(); };
  await seedEntries(stores, [RAW]);
  const off = rig({ stores });
  assert.equal((await off.svc.runPass({ reason: 'timer' })).skipped, 'off');
  assert.equal(reads, 0, `开关没开却读了 ${reads} 遍条目表`);
  const on = rig({ stores, prefs: { transEnabled: true, transChannel: 'baidu' } });
  assert.equal((await on.svc.runPass({ reason: 'timer' })).skipped, 'no_credential');
  assert.equal(reads, 0, `渠道没备好却读了 ${reads} 遍条目表`);
});

/* ------------------------------------------------------------------ *
 * C/D 模型档：真调的那一发 + 成败判据
 * ------------------------------------------------------------------ */

check('真调的那一发：opts 自证 provider / model / reasoningEffort / temperature，原文逐字进 messages', async () => {
  const handle = makeLlmHandle();
  const picker = makeModelPicker({ provider: 'dsh-local', model: 'deepseek-chat' });
  const r = rig({ handle, picker, prefs: { transEnabled: true } });
  const res = await r.svc.translateOne(RAW);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(handle.calls.length, 1);
  const opts = handle.calls[0];
  assert.equal(opts.provider, 'dsh-local', 'provider 不填的真机读数是 NO_ADAPTER，这一格必须由服务填');
  assert.equal(opts.model, 'deepseek-chat');
  assert.equal(opts.reasoningEffort, 'off', '关思考的实测写法只有这一种：顶层 thinking/reasoning 适配器不认');
  assert.equal(opts.temperature, 0);
  assert.equal(opts.system, TRANS_LLM_SYSTEM);
  assert.equal(opts.maxTokens, TRANS_LLM_MAX_TOKENS);
  assert.equal(opts.messages[0].content[0].text, RAW);
  assert.ok(opts.signal, '没有 AbortSignal ⇒ 超时闸门形同虚设');
  assert.equal(picker.calls.n, 1, '默认档不该每发都问宿主两次');
  const peeked = r.svc.peek('lastOpts');
  assert.equal(peeked.provider, 'dsh-local', 'peek 的自证必须是交给 stream() 的那一份，不是另造的标签');
  assert.equal(peeked.signal, 'AbortSignal', 'AbortSignal 原样进 JSON 会炸，读数里要换成标签');
});

check('宿主没给模型服务 / 没设默认档 / 读档抛异常：三种都是不发，errKey 各说各的', async () => {
  const noSvc = rig({ prefs: { transEnabled: true } });
  assert.equal((await noSvc.svc.translateOne(RAW)).errKey, 'unavailable');
  assert.equal(noSvc.svc.peek('calls'), 0, '宿主根本没给模型服务，连"派活"都不该记上一笔');
  const noModelA = makeLlmHandle();
  const empty = rig({ prefs: { transEnabled: true }, handle: noModelA, picker: makeModelPicker({ provider: '', model: 'm' }) });
  assert.equal((await empty.svc.translateOne(RAW)).errKey, 'no_model');
  assert.equal(empty.svc.peek('calls'), 1, '派活计数要如实算上一发（这一发确实被派过，只是没发出去）');
  // 模型句柄一次都没被碰：provider 空就该在这一发出门之前收住，而不是发出去让宿主报错
  assert.equal(noModelA.calls.length, 0, '没设默认档却还调了 stream()：那一句会白烧一次 token');
  const noModelB = makeLlmHandle();
  const threwPicker = makeModelPicker(new Error('宿主抛了'));
  const threw = rig({ prefs: { transEnabled: true }, handle: noModelB, picker: threwPicker });
  assert.equal((await threw.svc.translateOne(RAW)).errKey, 'no_model');
  assert.equal(threw.svc.peek('calls'), 1);
  assert.equal(noModelB.calls.length, 0);
  assert.equal(threwPicker.calls.n, 1, '读档只试一次：抛异常不许在闸门层重试');
});

check('失败坐在 finish 帧里也要判负：抛异常与不抛但带 failure 是两条路，都得回 errKey', async () => {
  const inBand = makeLlmHandle([{ type: 'finish', kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter registered' } }]);
  const r1 = rig({ handle: inBand, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
  const one = await r1.svc.translateOne(RAW);
  assert.equal(one.ok, false, 'in-band 错误被当成成功 ⇒ 库里存的是一句根本不存在的"译文"');
  assert.equal(one.errKey, 'http');
  assert.ok(one.errText.includes('NO_ADAPTER'));
  const thrown = makeLlmHandle([{ throw: 'stream blew up' }]);
  const r2 = rig({ handle: thrown, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
  assert.equal((await r2.svc.translateOne(RAW)).errKey, 'transport');
});

check('回来的不像一句描述就按没译成：空 / 无汉字 / 超长，三样都登记失败行、都不进读侧', async () => {
  const cases = [
    [[{ type: 'text-delta', text: '   ' }, { type: 'finish' }], 'empty'],
    [[{ type: 'text-delta', text: 'Still English text.' }, { type: 'finish' }], 'no_han'],
    [[{ type: 'text-delta', text: '汉'.repeat(TRANS_OUT_MAX + 5) }, { type: 'finish' }], 'too_long'],
  ];
  for (const [frames, key] of cases) {
    const r = rig({ handle: makeLlmHandle(frames), picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
    const res = await r.svc.translateOne(RAW);
    assert.equal(res.errKey, key, `${key} 那一支回的是 ${res.errKey}`);
    assert.equal(res.ok, false);
    const bad = (await r.stores.trans.readAll()).find((x) => x.src === RAW);
    assert.ok(bad && bad.ok === false, '失败没登记 ⇒ 下一轮还会把同一句再打一遍');
    assert.equal(bad.zh, undefined, '失败行不许带着半句译文入库');
    assert.equal((await r.stores.trans.zhMap()).has(RAW), false, '读侧必须是"没有中文"，不是"有一句英文冒充中文"');
  }
});

check('思考帧只计数不进译文：reasoning-delta 再多也不会混进 zh', async () => {
  const reasoning = '让我想想这段话该怎么翻译。';
  const handle = makeLlmHandle([
    { type: 'reasoning-delta', text: reasoning },
    { type: 'text-delta', text: '欧洲的天气预报与雷达图。' },
    { type: 'finish' },
  ]);
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
  assert.equal((await r.svc.translateOne(RAW)).zh, '欧洲的天气预报与雷达图。');
  assert.equal(r.svc.peek('lastReasoningChars'), reasoning.length, '思考字符没单独计 ⇒ 探针自证不了关思考生效');
});

/* ------------------------------------------------------------------ *
 * E 复用、内置表分工与 cooldown
 * ------------------------------------------------------------------ */

check('内置表命中的句子不发渠道、不进 trans 表：两层分工靠的是同一条命中判据', async () => {
  const sample = builtinSample();
  const handle = makeLlmHandle();
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
  const res = await r.svc.translateOne(sample.src);
  assert.equal(res.ok, true);
  assert.equal(res.from, 'builtin');
  assert.equal(res.zh, sample.zh);
  assert.equal(handle.calls.length, 0);
  assert.equal((await r.stores.trans.counts()).rows, 0, '内置表命中的那句又存了一份 = 本机白摊一行');
});

check('现译表逐字相同才复用：空白不同仍复用，换了词就重译，force 确会重发', async () => {
  const handle = makeLlmHandle([{ type: 'text-delta', text: '欧洲的天气预报。' }, { type: 'finish' }]);
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
  await r.svc.translateOne(RAW);
  assert.equal(handle.calls.length, 1);
  const again = await r.svc.translateOne(`  ${RAW.replace(/ /g, '  ')}  `);
  assert.equal(again.cached, true, '归一化后逐字相同却没复用 ⇒ 与 lib/keys.js 的 transKey 不是同一个口径');
  assert.equal(handle.calls.length, 1, '复用了还再发一发 = 每轮同步白打');
  assert.match(again.note, /^现译 · 百度翻译|^现译 · 宿主模型/, `命中复用的落款要跟着行里的渠道走：${again.note}`);
  const changed = await r.svc.translateOne('Weather alerts and radar imagery for Asia.');
  assert.equal(changed.cached, false);
  assert.equal(handle.calls.length, 2, '原文换了词必须重译');
  const forced = await r.svc.translateOne(RAW, { force: true });
  assert.equal(forced.cached, false);
  assert.equal(handle.calls.length, 3);
});

check('失败行进入 cooldown：同一句 24 小时内不再发，过了那点才回到待译清单', async () => {
  const handle = makeLlmHandle([{ throw: 'boom' }]);
  const items = [RAW, 'Another line without Chinese.'];
  const stores = createAllStores({ getFacility: () => makeFakeFacility(), now: () => NOW });
  await seedEntries(stores, items);
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true }, stores });
  await r.svc.runPass({ reason: 'timer' });
  assert.equal(handle.calls.length, 2, '一轮该把两句都打过（失败也要登记）');
  const missing = await r.svc.missingSources(items.map((d) => ({ desc: d })), { at: r.clock.at });
  assert.equal(missing.texts.length, 2);
  assert.equal(missing.inCooldown.length, 2, '刚失败的两句都要算进 cooldown（藏掉就是少报"还剩几句没中文"）');
  r.clock.at = NOW + TRANS_FAIL_COOLDOWN_MS + 1;
  const later = await r.svc.missingSources(items.map((d) => ({ desc: d })), { at: r.clock.at });
  assert.equal(later.inCooldown.length, 0);
  handle.calls.length = 0;
  const pass = await r.svc.runPass({ reason: 'timer' });
  assert.equal(pass.requested, 2, '过了 cooldown 还不重发 ⇒ 这两句永远不会有中文');
});

check('429 单独一档：种类留在行上、冷却比别的错短，而 500 那档不许跟着变短（U-15）', async () => {
  // 真机读数（§9.1r）：同一发经代理 200/932 ms，当晚复测 429 + Google 的「Sorry...」页。
  // 归进 http 就等于在屏幕上把"过一会儿自己会好"和"接口形状变了"说成同一句话，
  // 而按 24 h 冷却又把自己关一整天 —— 所以这里两头都要钉：429 短，500 不许跟着短。
  const items = [RAW, 'Another line without Chinese.'];

  const mk = async (status) => {
    const stores = createAllStores({ getFacility: () => makeFakeFacility(), now: () => NOW });
    await seedEntries(stores, items);
    const stub = makeFetch({ status });
    const r = rig({ prefs: { transEnabled: true, transChannel: 'keyless' }, fetchImpl: stub.fn, stores });
    return { stores, stub, r };
  };

  const lim = await mk(429);
  const one = await lim.r.svc.translateOne(RAW);
  assert.equal(one.ok, false, '429 却判成了成功');
  assert.equal(one.errKey, 'rate_limited', `429 归错了种类：${one.errKey}`);
  assert.match(one.note, /限流/, `界面念的那句要能看出是限流：${one.note}`);
  assert.equal(one.errText, 'HTTP 429', '原样那一格还是要留着（排障要看码）');
  const row = (await lim.stores.trans.readAll()).find((x) => x.src === RAW);
  assert.equal(row.ok, false, '失败行没落库');
  assert.equal(row.errKey, 'rate_limited', `种类没留在行上 ⇒ 冷却只能按整天关：${JSON.stringify(row)}`);
  assert.equal(TRANS_ERROR_KEYS.includes(row.errKey), true, '行上的种类必须是封闭取值');

  // 分档的效果：整轮把两句都打成 429，过 31 分钟必须回到待译清单（旧的 24 h 那一档在这里会仍然全冷）。
  const lim2 = await mk(429);
  await lim2.r.svc.runPass({ reason: 'timer' });
  const stillHot = await lim2.r.svc.missingSources(items.map((d) => ({ desc: d })), { at: NOW });
  assert.equal(stillHot.inCooldown.length, 2, '刚被限流的两句当下还是要挡住');
  lim2.r.clock.at = NOW + TRANS_RATE_LIMIT_COOLDOWN_MS + 1;
  const cooled = await lim2.r.svc.missingSources(items.map((d) => ({ desc: d })), { at: lim2.r.clock.at });
  assert.equal(cooled.inCooldown.length, 0, `限流那档过了 ${TRANS_RATE_LIMIT_COOLDOWN_MS / 60000} 分钟还没放行`);
  lim2.stub.reqs.length = 0;
  const retry = await lim2.r.svc.runPass({ reason: 'timer' });
  assert.equal(retry.requested, 2, '放行了却没重发 ⇒ 短冷却白设');

  // 对照那一半：500 走原来的整天。★ 少了这一发，把两档写成同一个数（或干脆免冷却）也测不出来。
  const srv = await mk(500);
  const srvOne = await srv.r.svc.translateOne(RAW);
  assert.equal(srvOne.errKey, 'http', `500 被判成了限流：${srvOne.errKey}`);
  const srv2 = await mk(500);
  await srv2.r.svc.runPass({ reason: 'timer' });
  srv2.r.clock.at = NOW + TRANS_RATE_LIMIT_COOLDOWN_MS + 1;
  const srvCooled = await srv2.r.svc.missingSources(items.map((d) => ({ desc: d })), { at: srv2.r.clock.at });
  assert.equal(srvCooled.inCooldown.length, 2, '500 那一档被顺手改短了：限流短一档不等于所有错都短一档');
  srv2.r.clock.at = NOW + TRANS_FAIL_COOLDOWN_MS + 1;
  assert.equal((await srv2.r.svc.missingSources(items.map((d) => ({ desc: d })), { at: srv2.r.clock.at })).inCooldown.length, 0);

  // 库里那格没有种类（换源之前那一夜的失败行）⇒ 按整天关，不给"读不出种类就免冷却"留口子。
  const legacy = createAllStores({ getFacility: () => makeFakeFacility(), now: () => NOW });
  await seedEntries(legacy, items);
  for (const src of items) await legacy.trans.put({ src, zh: undefined, at: NOW, chars: 0, channel: 'keyless', ok: false, errText: 'HTTP 429' });
  const lr = rig({ prefs: { transEnabled: true, transChannel: 'keyless' }, fetchImpl: (await mk(429)).stub.fn, stores: legacy });
  lr.clock.at = NOW + TRANS_RATE_LIMIT_COOLDOWN_MS + 1;
  const legacyCooled = await lr.svc.missingSources(items.map((d) => ({ desc: d })), { at: lr.clock.at });
  assert.equal(legacyCooled.inCooldown.length, 2, '旧行没种类就免冷却 ⇒ 每轮都会把限流那台再打一遍');
});

check('CN 真文档：原文自己写着中文的行不进待译队列，一轮只发那 12 句英文', async () => {
  // 2026-10-07 抓取源换成 llf007/public-apis-cn 的现场：1494 行里 1437 句唯一 desc 中有 1386 句本来就写着中文。
  // 没有 missingSources 里那道 `TRANS_HAN_RE` 闸门，这一轮会把它们全排进队列 —— 每轮白烧
  // TRANS_MAX_PER_ROUND 发把中文再译一遍，而界面那句"还剩几句没中文"会一直虚报 1400 多。
  // 所以这条钉的是**数量**（钉"没发中文"的措辞挡不住把闸门写成只判第一句的实现）。
  const cn = parseCatalog(await fixture('public-apis-cn-README.md'));
  assert.equal(cn.ok, true);
  assert.equal(cn.entries.length, 1494, '夹具行数变了 ⇒ 下面那几个数是换源那天的实测，要一起重测');
  const uniq = [...new Set(cn.entries.map((e) => e.desc).filter(Boolean))];
  assert.equal(uniq.length, 1437);
  assert.equal(uniq.filter((d) => TRANS_HAN_RE.test(d)).length, 1386, '中文行占比是这个判据的前提');

  const stores = createAllStores({ getFacility: () => makeFakeFacility(), now: () => NOW });
  await seedEntries(stores, cn.entries.map((e) => e.desc));
  const handle = makeLlmHandle([{ type: 'text-delta', text: '公共交通线路数据。' }, { type: 'finish' }]);
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true }, stores });

  const missing = await r.svc.missingSources(cn.entries.map((e) => ({ desc: e.desc })), { at: NOW });
  assert.equal(missing.texts.length, 12, `待译队列 ${missing.texts.length} 句：中文行没被挡住，或者内置表那一层没接住英文行`);
  assert.equal(missing.texts.some((t) => TRANS_HAN_RE.test(t)), false, '队列里混进了带汉字的原文');
  assert.equal(missing.inCooldown.length, 0);

  const pass = await r.svc.runPass({ reason: 'timer' });
  assert.equal(pass.scanned, 12);
  assert.equal(pass.requested, 12, `一轮发了 ${pass.requested} 发`);
  assert.equal(handle.calls.length, 12, '模型调用数要跟队列一致：多一发就是白烧');
  assert.equal(pass.capped, false, `队列 12 句不该撞上限（上限 ${TRANS_MAX_PER_ROUND}）`);
  assert.equal(pass.remaining, 0);
  assert.equal(pass.ok, 12);

  const after = await r.svc.missingSources(cn.entries.map((e) => ({ desc: e.desc })), { at: NOW });
  assert.equal(after.texts.length, 0, '补齐后队列还不空 ⇒ 下一轮又把同一批发一遍');
});

/* ------------------------------------------------------------------ *
 * F runPass 的上限与单飞
 * ------------------------------------------------------------------ */

check('runPass 一轮最多 TRANS_MAX_PER_ROUND 发，capped / remaining / scanned 要说得出还剩几句', async () => {
  const descs = [];
  for (let i = 0; i < TRANS_MAX_PER_ROUND + 3; i += 1) descs.push(`Unique line number ${i} with no Chinese.`);
  const stores = createAllStores({ getFacility: () => makeFakeFacility(), now: () => NOW });
  await seedEntries(stores, descs);
  const handle = makeLlmHandle();
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true }, stores });
  const pass = await r.svc.runPass({ reason: 'timer' });
  assert.equal(pass.requested, TRANS_MAX_PER_ROUND, `一轮发了 ${pass.requested} 发`);
  assert.equal(pass.capped, true);
  assert.ok(pass.remaining > 0, '截断了却没说还剩几句 ⇒ 界面的"还剩 N 句"就是 0，用户以为补齐了');
  assert.equal(pass.scanned, descs.length);
  assert.equal(handle.calls.length, TRANS_MAX_PER_ROUND);
});

check('撞车的第二轮 skipped busy，且第一发没回来之前一个请求都不插队', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handle = makeLlmHandle([{ wait: gate }, { type: 'text-delta', text: '一句中文。' }, { type: 'finish' }]);
  const stores = createAllStores({ getFacility: () => makeFakeFacility(), now: () => NOW });
  await seedEntries(stores, [RAW, 'Second line with no Chinese.']);
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true }, stores });
  const first = r.svc.runPass({ reason: 'timer' });
  for (let i = 0; i < 50 && handle.calls.length === 0; i += 1) await flush(1);
  assert.equal(handle.calls.length, 1, '第一发没挂起来，这条判据就测不到撞车');
  assert.equal(r.svc.busy, true, '第一发还挂着，busy 却没亮');
  const second = await r.svc.runPass({ reason: 'manual' });
  assert.equal(second.skipped, 'busy');
  assert.equal(handle.calls.length, 1, '撞车那一发把第二轮的活也插进来了');
  release();
  await first;
  assert.equal(r.svc.busy, false, '跑完了 busy 没落下 ⇒ 设置页永远显示"正在跑"');
});

check('onWritten 只在真写过行时叫：一句没写成不能触发"补中文并推一帧"', async () => {
  const failHandle = makeLlmHandle([{ type: 'finish', kind: 'error', failure: { code: 'X', message: 'y' } }]);
  const r1 = rig({ handle: failHandle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
  await seedEntries(r1.stores, [RAW]);
  await r1.svc.runPass({ reason: 'timer' });
  assert.equal(r1.written.length, 0, '一句都没写成却回调了 ⇒ 引擎白重建一次映射、界面白推一帧');
  const r2 = rig({ handle: makeLlmHandle(), picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true } });
  await seedEntries(r2.stores, [RAW]);
  await r2.svc.runPass({ reason: 'timer' });
  assert.ok(r2.written.length >= 1, '写成了却没回调 ⇒ 列表里的中文要等下一次读库才出现');
});

/* ------------------------------------------------------------------ *
 * G 状态 / readiness / 测试连接
 * ------------------------------------------------------------------ */

check('status 里没有凭据值：只有形状、开关与计数', async () => {
  const fetchStub = makeFetch();
  const r = rig({ prefs: { transEnabled: true, transChannel: 'baidu' }, fetchImpl: fetchStub.fn });
  await baiduCreds(r.stores);
  const json = JSON.stringify(r.svc.status());
  assert.equal(json.includes(KEY), false);
  assert.equal(json.includes(APPID), false);
  assert.equal(r.svc.status().needsKey, true);
  assert.equal(r.svc.status().implemented, true);
  assert.equal(r.svc.status().llmReady, null, '非模型档不该报模型可达性');
  assert.equal(r.svc.status().label, '百度翻译');
});

check('readiness：四档要 key 的都是"没填齐 ⇒ no_credential"，宿主没给句柄是 unavailable（五档都有发送路了）', async () => {
  const r = rig({ prefs: { transEnabled: true } });
  for (const id of ['baidu', 'tencent', 'aliyun', 'xunfei']) {
    r.holder.transChannel = id;
    assert.deepEqual(await r.svc.readiness(), { can: false, errKey: 'no_credential' }, `${id} 该报缺凭据，不是别的`);
  }
  // 腾讯的「地域」是 optional：只填两个 key 就该放行（留空由发送侧回落默认地域，见下一条真发用例）
  await credsFor(r.stores, 'tencent', { secret_id: TC_REAL.secret_id, secret_key: TC_REAL.secret_key });
  r.holder.transChannel = 'tencent';
  assert.deepEqual(await r.svc.readiness(), { can: true, errKey: '' });
  const noHandle = rig({ prefs: { transEnabled: true, transChannel: 'host_llm' } });
  assert.deepEqual(await noHandle.svc.readiness(), { can: false, errKey: 'unavailable' });
  // not_implemented 只剩登记表的护栏：没有任何一档走得到它，但话术表还得留着它（登记表加档时会用到）
  assert.equal(TRANS_CHANNELS.every((c) => c.implemented === true), true);
  assert.equal(TRANS_ERROR_KEYS.includes('not_implemented'), true);
});

check('测试连接：固定原文、不落库、不看开关（它验的就是"这一档现在能不能发"）', async () => {
  const handle = makeLlmHandle([{ type: 'text-delta', text: '英国的公共图书馆数据。' }, { type: 'finish' }]);
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }) });
  const res = await r.svc.testConnection();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(handle.calls[0].messages[0].content[0].text, TRANS_PROBE_TEXT);
  assert.equal((await r.stores.trans.counts()).rows, 0, '测试那一发把探针句子存进了译文表');
  assert.equal(r.written.length, 0);
  assert.equal(descZhView(TRANS_PROBE_TEXT).translated, false, '探针原文若在内置表里，测的就是缓存而不是渠道');
  const off = rig({});
  const offRes = await off.svc.testConnection();
  assert.equal(offRes.ok, false);
  assert.equal(offRes.errKey, 'unavailable');
});

check('失败话术表覆盖每一个 errKey，取值从同一张表派生（界面不许去 parse 中文原因）', () => {
  assert.deepEqual(Object.keys(TRANS_ERROR_LABELS).sort(), [...TRANS_ERROR_KEYS].sort());
  for (const k of TRANS_ERROR_KEYS) assert.ok(TRANS_ERROR_LABELS[k].length > 0, `${k} 没话术`);
  assert.match(transZhLabel('baidu', NOW), /^现译 · 百度翻译 · \d\d-\d\d \d\d:\d\d$/);
  assert.equal(transZhLabel('host_llm', 0), '现译 · 宿主模型');
});

check('渠道脏值回落**出厂档**（不是表里第一档）：prefs 里写了没登记的值也不许把现译整条路挡死', async () => {
  const handle = makeLlmHandle();
  const r = rig({ handle, picker: makeModelPicker({ provider: 'p', model: 'm' }), prefs: { transEnabled: true, transChannel: 'google-translate' } });
  assert.equal(r.svc.status().channel, DEFAULT_TRANS_CHANNEL);
  assert.equal((await r.svc.translateOne(RAW)).ok, true, '脏渠道值把现译这一路挡死了');
});

check('模型句柄在本文件只取一次：inject 的调用点就一条，关思考的写法不许漂', async () => {
  // 出网形状那几条结构判据（域名闸门的位置、POST 只许两档）住在 host-compat 的 hc-9c，这里不重复数。
  const src = await sourceText('lib/translate.js');
  assert.equal((src.match(/ctx\.inject\(\[[^\]]*'llm'/g) || []).length, 1, '模型句柄的取用点不止一处');
  assert.match(src, /reasoningEffort: 'off'/, '关思考的实测写法漂了 ⇒ 真机读数会回到"思考字符非零"');
});

await runAll('translate');
