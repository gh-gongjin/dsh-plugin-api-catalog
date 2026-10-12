/** 只读取证：跑一轮 sync（假设施 + 假 fetch），打印落库形状。不碰真机、不写任何插件数据。 */
import { createAllStores } from '../lib/stores.js';
import { createSync } from '../lib/sync.js';
import { makeFakeFacility, makeFakeFetch, fixture } from '../test/_helpers.mjs';
import { SOURCES, DOMAIN_NAME, TABLES, META_KEY } from '../lib/domain.js';
import { parseCatalog } from '../lib/parse.js';

const README = await fixture('public-apis-README.md');
const url = SOURCES[0].url;
const f = makeFakeFacility();
const fetchImpl = makeFakeFetch({ [url]: { text: README } });
const stores = createAllStores({ getFacility: () => f, logger: { warn: (m) => console.log('WARN', m) } });
const sync = createSync({ stores, fetchImpl, now: () => 1777000000000 });

const r1 = await sync.run();
console.log('round1', { ok: r1.ok, status: r1.status, code: r1.code, baseline: r1.baseline, total: r1.total, stats: r1.stats, nextDelayMs: r1.nextDelayMs });
console.log('rows', { entries: f.rowCount(DOMAIN_NAME, TABLES.entries), meta: f.rowCount(DOMAIN_NAME, TABLES.meta), changes: f.rowCount(DOMAIN_NAME, TABLES.changes), notes: f.rowCount(DOMAIN_NAME, TABLES.notes), prefs: f.rowCount(DOMAIN_NAME, TABLES.prefs) });
console.log('meta', f.rawRow(DOMAIN_NAME, TABLES.meta, META_KEY));

const putsBefore = f.calls.puts;
const r2 = await sync.run();
console.log('round2(hash gate)', { ok: r2.ok, status: r2.status, code: r2.code, puts: f.calls.puts - putsBefore, requests: fetchImpl.seen.length });

// 改一条再跑：用解析台账里的 1 起行号，保证动的确实是 Index 区里的一条
const parsed0 = parseCatalog(README);
console.log('parsed entries', parsed0.entries.length, 'categories', parsed0.report.categories.length);
const lineNo = parsed0.entries[0].line - 1;
const origLine = README.split('\n')[lineNo];
console.log('mutating line:', origLine.slice(0, 80));
const lines = README.split('\n');
const cells = origLine.split('|');
cells[4] = ' apiKey ';
lines[lineNo] = cells.join('|');
const mutated = lines.join('\n');
console.log('mutation applied:', mutated !== README, 'target=', parsed0.entries[0].name, '→', lines[lineNo].slice(-40));
const fetch2 = makeFakeFetch({ [url]: { text: mutated } });
const sync2 = createSync({ stores, fetchImpl: fetch2, now: () => 1777000111000 });
const puts2 = f.calls.puts;
const r3 = await sync2.run();
console.log('round3(one line changed)', { ok: r3.ok, status: r3.status, stats: r3.stats, puts: f.calls.puts - puts2 });
console.log('ledger tail', (await stores.changes.list(5)).map((r) => `${r.kind} ${r.slug} ${r.detail}`));

const parsed = parseCatalog(README);
console.log('parsed entries', parsed.entries.length, 'categories', parsed.report.categories.length);
await stores.closeAll();
console.log('open calls', f.calls.open);
