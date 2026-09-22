import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanMedia, toPublicScan } from '../src/media-scanner.js';

const candidate = (name, index) => ({
  name,
  path: `/private/media/${name}`,
  identity: { dev: 1, ino: index, birthtimeMs: 1, type: 'file' },
  birthtime: new Date('2024-01-02T03:04:05Z')
});

test('candidate extensions agree with native formats including HEIF and excluding unsupported RAW types', async () => {
  const supported = ['jpg', 'jpeg', 'heic', 'heif', 'png', 'tif', 'tiff', 'dng', 'cr2', 'nef', 'arw', 'raf', 'mov', 'mp4', 'm4v'];
  const names = [...supported, 'orf', 'rw2', 'gif'].map(extension => `fixture.${extension.toUpperCase()}`);
  let inspected;
  const result = await scanMedia(names.map(candidate), { inspectMedia: async paths => {
    inspected = paths;
    return paths.map(file => ({ path: file, kind: 'photo' }));
  } });
  assert.deepEqual(inspected.map(file => file.split('.').at(-1).toLowerCase()), supported);
  assert.deepEqual(result.ordinaryPaths.map(item => item.name), ['fixture.ORF', 'fixture.RW2', 'fixture.GIF']);
});

test('groups matching photo and video asset identifiers as one Live Photo', async () => {
  const photo = candidate('IMG_1.HEIC', 1);
  const motion = candidate('IMG_1.MOV', 2);
  const result = await scanMedia([photo, motion], {
    inspectMedia: async paths => {
      assert.deepEqual(paths, [photo.path, motion.path]);
      return [
        { path: photo.path, kind: 'photo', assetIdentifier: 'asset-1', capturedAt: '2026-09-21T10:00:00+08:00' },
        { path: motion.path, kind: 'video', assetIdentifier: 'asset-1', capturedAt: '2026-09-21T10:00:00+08:00' }
      ];
    },
    resolveLocations: false,
    timeZone: 'Asia/Shanghai'
  });
  assert.equal(result.mediaItems.length, 1);
  assert.equal(result.mediaItems[0].mediaType, 'live-photo');
  assert.deepEqual(result.mediaItems[0].members.map(member => member.name), ['IMG_1.HEIC', 'IMG_1.MOV']);
  assert.equal(result.mediaItems[0].mediaDirectory, '照片');
});

test('leaves unsupported extensions and helper-rejected candidates for ordinary classification', async () => {
  const text = candidate('notes.txt', 1);
  const image = candidate('not-really-media.JPG', 2);
  const result = await scanMedia([text, image], {
    inspectMedia: async paths => {
      assert.deepEqual(paths, [image.path]);
      return [{ path: image.path, kind: 'unsupported', assetIdentifier: null }];
    }
  });
  assert.deepEqual(result.ordinaryPaths.map(item => item.name), ['notes.txt', 'not-really-media.JPG']);
  assert.equal(result.mediaItems.length, 0);
});

test('does not group malformed matching identifiers and warns on ambiguous pairs', async () => {
  const malformedPhoto = candidate('bad.jpg', 1);
  const malformedVideo = candidate('bad.mov', 2);
  const first = candidate('one.jpg', 3);
  const second = candidate('two.jpg', 4);
  const motion = candidate('two.mov', 5);
  const result = await scanMedia([malformedPhoto, malformedVideo, first, second, motion], {
    inspectMedia: async paths => paths.map(file => ({
      path: file,
      kind: file.endsWith('.mov') ? 'video' : 'photo',
      assetIdentifier: file.includes('bad') ? 'asset\u0000bad' : 'duplicate-asset'
    }))
  });
  assert.equal(result.mediaItems.length, 5);
  assert.ok(result.mediaItems.every(item => item.mediaType !== 'live-photo'));
  assert.ok(result.mediaItems.filter(item => item.members[0].name !== 'bad.jpg' && item.members[0].name !== 'bad.mov')
    .every(item => /配对标识/.test(item.warning)));
});

test('batches metadata reads, isolates helper failures, and never exposes private media data', async () => {
  const files = Array.from({ length: 101 }, (_, index) => candidate(`IMG_${index}.JPG`, index));
  const calls = [];
  const result = await scanMedia(files, {
    inspectMedia: async paths => {
      calls.push(paths);
      if (paths.length === 1) throw new Error('helper unavailable');
      return paths.map(file => ({ path: file, kind: 'photo', latitude: 31.2304, longitude: 121.4737 }));
    },
    resolveLocations: false
  });
  assert.deepEqual(calls.map(paths => paths.length), [100, 1]);
  assert.equal(result.mediaItems.length, 101);
  assert.equal(result.mediaItems.find(item => item.members[0].name === 'IMG_100.JPG').metadataStatus, 'failed');
  const publicScan = toPublicScan({
    id: 'scan', root: '/private/media', rootIdentity: { ino: 9 }, items: result.mediaItems, skipped: []
  }, { exposeCoordinates: true });
  assert.equal(JSON.stringify(publicScan).includes('/private/media'), false);
  assert.equal(JSON.stringify(publicScan).includes('identity'), false);
  assert.equal(JSON.stringify(publicScan).includes('assetIdentifier'), false);
  assert.equal(JSON.stringify(publicScan).includes('31.2304'), false);
  assert.equal(publicScan.items[0].hasCoordinates, true);
});

test('resolves one rounded location for duplicate points only when enabled', async () => {
  const first = candidate('one.JPG', 1);
  const second = candidate('two.JPG', 2);
  const cache = {
    resolve: async (points, geocoder) => {
      assert.equal(points.length, 1);
      assert.equal(points[0].key, '31.23,121.47');
      const places = await geocoder(points);
      return new Map(places.map(place => [place.key, place]));
    }
  };
  const result = await scanMedia([first, second], {
    inspectMedia: async paths => paths.map(file => ({
      path: file, kind: 'photo', latitude: 31.2304, longitude: 121.4737
    })),
    resolveLocations: true,
    geocodeCache: cache,
    reverseGeocode: async points => points.map(point => ({
      key: point.key, country: '中国', city: '上海', status: 'resolved'
    }))
  });
  assert.deepEqual(result.mediaItems.map(item => [item.facts.country, item.facts.city, item.facts.locationStatus]),
    [['中国', '上海', 'resolved'], ['中国', '上海', 'resolved']]);
  const publicScan = toPublicScan({ id: 'scan', items: result.mediaItems, skipped: [] });
  assert.equal(JSON.stringify(publicScan).includes('31.2304'), false);
});

test('requires explicit boolean true before using location services', async () => {
  const file = candidate('coordinate.JPG', 1);
  for (const resolveLocations of [undefined, false, 'false', 1]) {
    let cacheCalls = 0;
    let geocoderCalls = 0;
    await scanMedia([file], {
      ...(resolveLocations === undefined ? {} : { resolveLocations }),
      inspectMedia: async paths => paths.map(mediaPath => ({
        path: mediaPath, kind: 'photo', latitude: 31.2304, longitude: 121.4737
      })),
      geocodeCache: { resolve: async () => { cacheCalls++; return new Map(); } },
      reverseGeocode: async () => { geocoderCalls++; return []; }
    });
    assert.equal(cacheCalls, 0, `cache called for ${String(resolveLocations)}`);
    assert.equal(geocoderCalls, 0, `geocoder called for ${String(resolveLocations)}`);
  }
});
