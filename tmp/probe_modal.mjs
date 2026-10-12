import { booted, byCls, detailOf, maskOf, tbodyRows, tap, textOf, findAll } from '../test/_client-harness.mjs';
const t = await booted();
try {
  console.log('booted ok, rows', tbodyRows(t.tree()).length);
  await tap(t, tbodyRows(t.tree())[0]);
  console.log('tapped, mask?', !!maskOf(t.tree()), 'modal?', !!detailOf(t.tree()));
  console.log('modal text:', textOf(detailOf(t.tree())).slice(0, 60));
  console.log('purposeBox?', !!findAll(t.tree(), (n) => n.tag === 'textarea')[0]);
  console.log('ops', t.sandbox.document.ops.join(','));
  console.log('listeners keydown count', (t.sandbox.document.listeners.keydown || []).length);
} catch (e) {
  console.log('THROWN:', e.stack.split('\n').slice(0, 6).join('\n'));
} finally { await t.close(); }
