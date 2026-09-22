import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InboxStore } from '../src/inbox-store.js';

async function tempStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-inbox-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: new InboxStore(path.join(dir, 'inboxes.json')) };
}

test('persists an inbox with its private taxonomy and reloads it', async t => {
  const { dir, store } = await tempStore(t);
  const created = await store.save({
    name: '下载',
    root: path.join(dir, 'Downloads'),
    taxonomy: [
      { name: '工作' },
      { name: '学习', children: [{ name: '课程' }] }
    ]
  });
  assert.match(created.id, /^[a-f0-9-]{36}$/);
  assert.equal(created.taxonomy[1].children[0].path, '学习/课程');
  const reloaded = await new InboxStore(path.join(dir, 'inboxes.json')).list();
  assert.deepEqual(reloaded, [created]);
  const stat = await fs.stat(path.join(dir, 'inboxes.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('rejects an inbox root that is not absolute and taxonomy deeper than three levels', async t => {
  const { store } = await tempStore(t);
  await assert.rejects(() => store.save({ name: '坏目录', root: 'Downloads', taxonomy: [] }), /绝对路径/);
  await assert.rejects(() => store.save({ name: '坏分类', root: '/tmp/items', taxonomy: [
    { name: '一', children: [{ name: '二', children: [{ name: '三', children: [{ name: '四' }] }] }] }
  ] }), /最多三级/);
});

test('updates an existing inbox without changing its id', async t => {
  const { store } = await tempStore(t);
  const created = await store.save({ name: '下载', root: '/tmp/downloads', taxonomy: [{ name: '工作' }] });
  const updated = await store.save({ id: created.id, name: '下载目录', root: '/tmp/downloads', taxonomy: [{ name: '财务' }] });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, '下载目录');
  assert.equal((await store.get(created.id)).taxonomy[0].name, '财务');
});
