import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { pickFolder } from '../src/folder-picker.js';

test('native picker passes the starting path as an argument and resolves the chosen folder', async () => {
  const root = await fs.realpath(os.tmpdir());
  const result = await pickFolder(root, { platform: 'darwin', run: async (file, args) => {
    assert.equal(file, '/usr/bin/osascript');
    assert.equal(args.at(-1), root);
    assert.match(args[1], /choose folder/);
    return { stdout: root + '/\n' };
  } });
  assert.equal(result, root);
});

test('cancelled native picker returns null without changing the folder', async () => {
  assert.equal(await pickFolder('', { platform: 'darwin', run: async () => ({ stdout: '\n' }) }), null);
});

test('unsupported platforms receive a manual-path fallback message', async () => {
  await assert.rejects(pickFolder('', { platform: 'linux' }), /手动输入/);
});
