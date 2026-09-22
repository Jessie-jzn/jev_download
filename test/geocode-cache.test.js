import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coordinateKey, GeocodeCache } from '../src/geocode-cache.js';

async function cacheFixture(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-geocode-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { file: path.join(directory, 'geocode.json'), cache: new GeocodeCache(path.join(directory, 'geocode.json'), options) };
}

test('rounds valid coordinates to two decimal cache keys', () => {
  assert.equal(coordinateKey({ latitude: 31.2304, longitude: 121.4737 }), '31.23,121.47');
  assert.equal(coordinateKey({ latitude: -0.001, longitude: 0.001 }), '0.00,0.00');
  assert.throws(() => coordinateKey({ latitude: -90.1, longitude: 0 }), /invalid coordinates/);
  assert.throws(() => coordinateKey({ latitude: 0, longitude: 180.1 }), /invalid coordinates/);
});

test('persists resolved places without media paths or filenames', async t => {
  const { file, cache } = await cacheFixture(t);
  const results = await cache.resolve([{ latitude: 31.2304, longitude: 121.4737, path: '/private/photo.jpg', name: 'photo.jpg' }], async points => {
    assert.equal(points.length, 1);
    return [{ key: '31.23,121.47', country: '中国', city: '上海', status: 'resolved' }];
  });

  assert.deepEqual(results.get('31.23,121.47'), { country: '中国', city: '上海', status: 'resolved' });
  const raw = await fs.readFile(file, 'utf8');
  assert.match(raw, /31\.23,121\.47/);
  assert.doesNotMatch(raw, /private|photo\.jpg/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('reuses a resolved entry indefinitely without calling the geocoder', async t => {
  const { file, cache } = await cacheFixture(t, { now: () => new Date('2026-01-01T00:00:00Z') });
  await cache.resolve([{ latitude: 31.23, longitude: 121.47 }], async () => [{ key: '31.23,121.47', country: '中国', city: '上海', status: 'resolved' }]);
  const later = new GeocodeCache(file, { now: () => new Date('2046-01-01T00:00:00Z') });
  const result = await later.resolve([{ latitude: 31.23, longitude: 121.47 }], async () => assert.fail('resolved entries should be reused'));

  assert.equal(result.get('31.23,121.47').city, '上海');
});

test('retries unresolved entries after 24 hours', async t => {
  let now = new Date('2026-01-01T00:00:00Z');
  const { cache } = await cacheFixture(t, { now: () => now });
  let calls = 0;
  const geocoder = async () => {
    calls++;
    return [{ key: '31.23,121.47', country: null, city: null, status: 'unresolved' }];
  };
  await cache.resolve([{ latitude: 31.23, longitude: 121.47 }], geocoder);
  now = new Date('2026-01-01T23:59:59Z');
  await cache.resolve([{ latitude: 31.23, longitude: 121.47 }], geocoder);
  now = new Date('2026-01-02T00:00:00Z');
  await cache.resolve([{ latitude: 31.23, longitude: 121.47 }], geocoder);

  assert.equal(calls, 2);
});

test('configured unresolved TTL retries at the requested hour while invalid values retain 24 hours', async t => {
  for (const [value, hours] of [['2', 2], [undefined, 24], ['', 24], ['0', 24], ['-1', 24], ['1.5', 24], ['Infinity', 24], ['bad', 24], ['999999999999999999', 24]]) {
    let now = new Date('2026-01-01T00:00:00Z');
    const { cache } = await cacheFixture(t, { now: () => now, env: { MEDIA_GEOCODE_CACHE_TTL_HOURS: value } });
    let calls = 0;
    const lookup = async () => { calls++; return []; };
    const points = [{ latitude: 31.23, longitude: 121.47 }];
    await cache.resolve(points, lookup);
    now = new Date(now.getTime() + hours * 3600000 - 1);
    await cache.resolve(points, lookup);
    assert.equal(calls, 1, `${value} before expiry`);
    now = new Date(now.getTime() + 1);
    await cache.resolve(points, lookup);
    assert.equal(calls, 2, `${value} at expiry`);
  }
});

test('serializes concurrent cache writes into valid combined JSON', async t => {
  const { file, cache } = await cacheFixture(t);
  await Promise.all([
    cache.resolve([{ latitude: 31.23, longitude: 121.47 }], async () => [{ key: '31.23,121.47', country: '中国', city: '上海', status: 'resolved' }]),
    cache.resolve([{ latitude: 22.54, longitude: 114.06 }], async () => [{ key: '22.54,114.06', country: '中国', city: '深圳', status: 'resolved' }])
  ]);

  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(persisted.entries).sort(), ['22.54,114.06', '31.23,121.47']);
});

test('serializes concurrent cache instances by canonical file path and merges entries', async t => {
  const { file } = await cacheFixture(t);
  const firstCache = new GeocodeCache(file);
  const secondCache = new GeocodeCache(path.join(path.dirname(file), 'child', '..', path.basename(file)));
  let releaseFirst;
  let startFirst;
  const firstStarted = new Promise(resolve => { startFirst = resolve; });
  const first = firstCache.resolve([{ latitude: 31.23, longitude: 121.47 }], async () => {
    startFirst();
    await new Promise(resolve => { releaseFirst = resolve; });
    return [{ key: '31.23,121.47', country: '中国', city: '上海', status: 'resolved' }];
  });
  await firstStarted;
  const second = secondCache.resolve([{ latitude: 22.54, longitude: 114.06 }], async () =>
    [{ key: '22.54,114.06', country: '中国', city: '深圳', status: 'resolved' }]);
  releaseFirst();
  await Promise.all([first, second]);

  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(persisted.entries).sort(), ['22.54,114.06', '31.23,121.47']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
