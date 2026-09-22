import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PendingStore } from '../src/pending-store.js';

async function tempStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-pending-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: new PendingStore(path.join(dir, 'pending.json')) };
}

test('persists pending recommendations and reloads them after restart', async t => {
  const { dir, store } = await tempStore(t);
  const item = await store.upsert({
    id: 'item-1', inboxId: 'inbox-1', name: '发票.pdf', source: '/tmp/发票.pdf',
    identity: { dev: 1, ino: 2, birthtimeMs: 3, type: 'file' },
    category: '财务/待报销', destination: '财务/待报销/发票.pdf', status: 'pending'
  });
  assert.equal(item.status, 'pending');
  const reloaded = await new PendingStore(path.join(dir, 'pending.json')).list('inbox-1');
  assert.deepEqual(reloaded, [item]);
});

test('invalidates a pending item when its source identity changes or disappears', async t => {
  const { store } = await tempStore(t);
  await store.upsert({ id: 'same', inboxId: 'inbox-1', source: '/tmp/same', identity: { ino: 1 }, status: 'pending' });
  await store.upsert({ id: 'changed', inboxId: 'inbox-1', source: '/tmp/changed', identity: { ino: 2 }, status: 'pending' });
  const updated = await store.invalidate('inbox-1', [{ id: 'same', identity: { ino: 1 } }, { id: 'changed', identity: { ino: 9 } }]);
  assert.equal(updated.find(item => item.id === 'same').status, 'pending');
  assert.equal(updated.find(item => item.id === 'changed').status, 'stale');
  assert.match(updated.find(item => item.id === 'changed').error, /发生变化/);
});

test('updates and removes pending items by id', async t => {
  const { store } = await tempStore(t);
  await store.upsert({ id: 'item-1', inboxId: 'inbox-1', source: '/tmp/item-1', identity: { ino: 1 }, status: 'pending' });
  await store.update('item-1', { category: '学习', status: 'approved' });
  assert.equal((await store.list('inbox-1'))[0].category, '学习');
  await store.remove(['item-1']);
  assert.deepEqual(await store.list('inbox-1'), []);
});
