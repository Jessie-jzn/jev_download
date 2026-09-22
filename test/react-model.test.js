import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMove, mediaDestinationPaths, matchesFilter, selectionFor } from '../ui/item-model.js';

const live = { id: 'live', type: 'media', name: 'live.heic', mediaType: 'live-photo',
  members: [{ name: 'live.heic' }, { name: 'live.mov' }], year: '2026', month: '09',
  country: '中国', city: '杭州:', locationStatus: 'resolved', dateSource: 'embedded' };

test('React media preview and structured selection follow the shared server path rules', () => {
  assert.deepEqual(mediaDestinationPaths(live), [
    '2026 / 09 / 中国 / 杭州 / 照片 / live.heic',
    '2026 / 09 / 中国 / 杭州 / 照片 / live.mov'
  ]);
  assert.deepEqual(selectionFor(live), { id: 'live', media: { year: '2026', month: '09', country: '中国', city: '杭州:' } });
  assert.equal(canMove({ ...live, city: '../escape' }), false);
  assert.equal(matchesFilter(live, 'live-photo'), true);
  assert.equal(matchesFilter(live, 'video'), false);
});

test('React retains ordinary provider confidence review and filter semantics', () => {
  const ordinary = { id: 'doc', type: 'file', name: 'doc.txt', category: '学习', confidence: 0.42, manual: false };
  assert.equal(matchesFilter(ordinary, 'review'), true);
  assert.equal(matchesFilter({ ...ordinary, confidence: 0.9 }, 'review'), false);
  assert.deepEqual(selectionFor(ordinary), { id: 'doc', category: '学习' });
});
