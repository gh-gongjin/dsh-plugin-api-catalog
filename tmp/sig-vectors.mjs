/* tmp/sig-vectors.mjs —— 把三家官方算例逐层跑一遍，确认本仓的实现能复现官方读数。
 * 先把复现结果拿到手，再把它写成 test/translate.test.mjs 里的断言（反过来做就是把"我猜的形状"钉成规矩）。
 * 跑法：node tmp/sig-vectors.mjs */
import fs from 'node:fs';
import {
  tencentTc3Sign, aliyunSign, aliyunPercentEncode, aliyunCanonicalQuery, aliyunUrl,
  xunfeiAuth, xunfeiBody,
} from '../lib/translate.js';

let bad = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

/* ---------- 1) 腾讯云 API 3.0 签名 v3（文档：cloud.tencent.com/document/api/213/30654） ---------- */
const TC = {
  secretId: `AKID${'*'.repeat(32)}`,
  secretKey: '*'.repeat(32),
  ts: 1551113065,
  service: 'cvm',
  host: 'cvm.tencentcloudapi.com',
  action: 'DescribeInstances',
  contentType: 'application/json; charset=utf-8',
  payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
};
const tc = tencentTc3Sign({
  secretId: TC.secretId, secretKey: TC.secretKey, timestampSeconds: TC.ts, service: TC.service,
  host: TC.host, action: TC.action, contentType: TC.contentType, payload: TC.payload,
});
eq('腾讯 HashedRequestPayload', tc.hashedPayload, '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064');
eq('腾讯 SignedHeaders', tc.signedHeaders, 'content-type;host;x-tc-action');
eq('腾讯 HashedCanonicalRequest', tc.hashedCanonicalRequest, '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84');
eq('腾讯 CredentialScope', tc.credentialScope, '2019-02-25/cvm/tc3_request');
eq('腾讯 StringToSign', tc.stringToSign,
  'TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84');
eq('腾讯 SecretDate', tc.secretDate, 'da98fb70dcf6b112dc21038d1eeeb3a95c74b4dcb12c1131f864f6066bd02be0');
eq('腾讯 SecretService', tc.secretService, '8d70cbefb03939f929db64d32dc2ba89b1095620119fe3e050e2b18c5bd2752f');
eq('腾讯 SecretSigning', tc.secretSigning, 'b596b923aad85185e2d1f6659d2a062e0a86731226e021e61bfe06f7ed05f5af');
eq('腾讯 Signature', tc.signature, '10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f');
eq('腾讯 Authorization', tc.authorization,
  'TC3-HMAC-SHA256 Credential=AKID********************************/2019-02-25/cvm/tc3_request, '
  + 'SignedHeaders=content-type;host;x-tc-action, '
  + 'Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f');
console.log('     CanonicalRequest 实际形状：\n' + tc.canonicalRequest.split('\n').map((l, i) => `       ${i}|${l}`).join('\n'));

/* ---------- 2) 阿里 RPC 签名（文档：help.aliyun.com/document_detail/25489.html 的假设参数） ---------- */
const ALI_PARAMS = {
  Action: 'DescribeDedicatedHosts',
  Version: '2014-05-26',
  Format: 'JSON',
  AccessKeyId: 'testid',
  SignatureMethod: 'HMAC-SHA1',
  SignatureVersion: '1.0',
  SignatureNonce: 'edb2b34af0af9a6d14deaf7c1a5315eb',
  Timestamp: '2023-03-13T08:34:30Z',
  RegionId: 'cn-beijing',
};
const ali = aliyunSign({ params: ALI_PARAMS, accessKeySecret: 'testsecret' });
eq('阿里 CanonicalizedQueryString', ali.canonicalQuery,
  'AccessKeyId=testid&Action=DescribeDedicatedHosts&Format=JSON&RegionId=cn-beijing'
  + '&SignatureMethod=HMAC-SHA1&SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb&SignatureVersion=1.0'
  + '&Timestamp=2023-03-13T08%3A34%3A30Z&Version=2014-05-26');
eq('阿里 StringToSign', ali.stringToSign,
  'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeDedicatedHosts%26Format%3DJSON%26RegionId%3Dcn-beijing'
  + '%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3Dedb2b34af0af9a6d14deaf7c1a5315eb%26SignatureVersion%3D1.0'
  + '%26Timestamp%3D2023-03-13T08%253A34%253A30Z%26Version%3D2014-05-26');
eq('阿里 Signature', ali.signature, '9NaGiOspFP5UPcwX8Iwt2YJXXuk=');
eq('阿里 百分号编码吃掉 RFC3986 那五个字符', aliyunPercentEncode("a!b'c(d)e*f g~h"),
  'a%21b%27c%28d%29e%2Af%20g~h');

/* ---------- 3) 讯飞 机器翻译（新）（文档：xfyun.cn/doc/nlp/xftrans_new/API.html 的示例值） ---------- */
const xfDoc = fs.readFileSync(new URL('./sigdocs/xftrans_new.txt', import.meta.url), 'utf8');
const apiKey = (xfDoc.match(/api_key="([a-zA-ZX]+)"/) || [])[1];
const apiSecret = (xfDoc.match(/APISecret = "([a-zA-ZX]+)"/) || [])[1];
console.log(`     文档示例 apiKey=${apiKey}（${apiKey.length} 位）· apiSecret=${apiSecret}（${apiSecret.length} 位）`);
const XF_DATE = 'Thu, 18 Nov 2021 03:05:18 GMT';
const xf = xunfeiAuth({ apiKey, apiSecret, endpoint: 'https://itrans.xf-yun.com/v1/its', date: XF_DATE });
eq('讯飞 signature_origin', xf.signatureOrigin,
  `host: itrans.xf-yun.com\ndate: ${XF_DATE}\nPOST /v1/its HTTP/1.1`);
eq('讯飞 signature', xf.signature, 'f1JArA6ktheNPofP4WX8264qNFNBA8HZB31O/deJcuc=');
eq('讯飞 authorization', xf.authorization,
  'YXBpX2tleT0iYXBpa2V5WFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFgiLCBhbGdvcml0aG09ImhtYWMtc2hhMjU2Iiwg'
  + 'aGVhZGVycz0iaG9zdCBkYXRlIHJlcXVlc3QtbGluZSIsIHNpZ25hdHVyZT0iZjFKQXJBNmt0aGVOUG9mUDRXWDgyNj'
  + 'RxTkZOQkE4SFpCMzFPL2RlSmN1Yz0i');
const xfUrl = new URL(xf.url);
eq('讯飞 查询串里 date 的编码形状', xfUrl.searchParams.get('date'), XF_DATE);
eq('讯飞 查询串里 host', xfUrl.searchParams.get('host'), 'itrans.xf-yun.com');
console.log('     正文形状：', xunfeiBody({ appId: 'app123', text: 'hello' }));

console.log(bad ? `\n★ ${bad} 层复现不上官方读数` : '\n[三家官方算例逐层复现一致]');
process.exitCode = bad ? 1 : 0;
