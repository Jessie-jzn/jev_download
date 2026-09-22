import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Organizer } from '../../src/organizer.js';

export async function interruptedLivePhoto(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jev-restart-live-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'items'), dataDir = path.join(base, 'data');
  await fs.mkdir(root);
  for (const name of ['A.HEIC', 'B.MOV']) await fs.writeFile(path.join(root, name), `original:${name}`);
  const scanOptions = { inspectMedia: async paths => paths.map(file => ({ path: file,
    kind: file.endsWith('.MOV') ? 'video' : 'photo', assetIdentifier: 'restart-pair',
    capturedAt: '2026-09-21T10:00:00+08:00' })) };
  const organizer = new Organizer(dataDir, scanOptions);
  const scan = await organizer.scan(root);
  const media = { year: '2026', month: '09', country: '中国', city: '上海' };
  const batch = await organizer.move(scan.id, [{ id: scan.items[0].id, media }]);
  const motion = batch.entries[0].members.find(member => member.name === 'B.MOV');
  await fs.rename(motion.target, motion.source);
  batch.entries[0].status = 'pending';
  await organizer.save(batch);
  return { root, dataDir, scanOptions, media, batchId: batch.id };
}
