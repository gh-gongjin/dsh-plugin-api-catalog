/**
 * tmp/probe-shapes.mjs —— S1 形状探针：把真 README 里各类脏形状的原行挖出来，
 * 供 test/make-fixtures.mjs 切片用（夹具必须是真实存在过的行，不许手编理想样例）。
 * 读数落 tmp/probe-shapes.txt 再回读，别在控制台打中文（cp936 会花）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCatalog } from '../lib/parse.js';

const md = fs.readFileSync(path.resolve('test/fixtures/public-apis-README.md'), 'utf8');
const r = parseCatalog(md);

const lines = md.split('\n');
const find = (needle) => {
  const i = lines.findIndex((l) => l.includes(needle));
  return i < 0 ? null : { line: i + 1, text: lines[i] };
};

const out = {
  ok: r.ok,
  fatal: r.fatal ?? '',
  rows: r.report.rows,
  parsed: r.report.parsed,
  parseRatio: Number(r.report.parseRatio.toFixed(4)),
  categories: r.report.categories.length,
  catMax: [...r.report.categories].sort((a, b) => b.count - a.count)[0],
  catMin: [...r.report.categories].sort((a, b) => a.count - b.count)[0],
  headerRows: r.report.headerRows,
  separatorRows: r.report.separatorRows,
  endAnchor: r.report.endAnchor,
  endAnchorUnexpected: r.report.endAnchorUnexpected,
  counts: r.report.counts,
  skipped: r.report.skipped,
  dupSlugN: r.report.dupSlugs.length,
  dupSlugFirst: r.report.dupSlugs[0] || null,
  exactDups: r.report.exactDups,
  overLongDescN: r.report.overLongDesc.length,
  overLongMax: r.report.overLongDesc.reduce((a, b) => (a && a.len >= b.len ? a : b), null),
  emptyDesc: r.report.emptyDesc,
  unknownFields: r.report.unknownFields,
  dupSlugs: r.report.dupSlugs,
  dupUrls: r.report.dupUrls,
  hostsTop: r.report.hosts.slice(0, 8),
  jsonKB: Math.round(JSON.stringify(r.entries).length / 1024),
  presetNoKey: r.entries.filter((e) => e.auth === 'No').length,
  presetBrowser: r.entries.filter((e) => e.auth === 'No' && e.cors === 'Yes' && e.https === 'Yes').length,
};

// 原行取样（夹具要用）
const samples = {
  trailingSpaceUrl: find('reqres.in/ ') || find('clockify.me/developers-api '),
  nonLinkTitle: null,
  shortRow: null,
  dashCors: find('| – |') || null,
  backtickYes: lines.find((l) => l.includes('| `Yes` |')) || null,
  transportRow: lines.find((l) => l.startsWith('| [') && l.includes('glama.ai')) || null,
  adRow: lines.find((l) => l.startsWith('| [IPstack]')) || null,
};
const badTitleLine = lines.findIndex((l) => l.startsWith('| ') && !l.startsWith('| [') && l.includes('---') === false && /^\|\s+[A-Za-z]/.test(l) && l.split('|').length > 3);
samples.headerRowExample = badTitleLine < 0 ? null : lines[badTitleLine];

// 重音字符名称取样
const accented = r.entries.filter((e) => /[^\x00-\x7F]/.test(e.name)).slice(0, 12).map((e) => ({ name: e.name, slug: e.slug, line: 0 }));
const nonAsciiDesc = r.entries.filter((e) => /[^\x00-\x7F]/.test(e.desc)).length;

out.samplesKeys = Object.keys(samples);
out.accentedNames = accented;
out.nonAsciiDesc = nonAsciiDesc;

fs.writeFileSync(path.resolve('tmp/probe-shapes.txt'), JSON.stringify(out, null, 1) + '\n' + JSON.stringify(samples, null, 1), 'utf8');
console.log('written tmp/probe-shapes.txt');
