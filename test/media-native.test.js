import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inspectMedia, reverseGeocode } from '../src/media-native.js';
import * as nativeConfig from '../src/media-native.js';
import { buildNative } from '../scripts/build-native.js';
import { Organizer } from '../src/organizer.js';

const execFile = promisify(execFileCallback);

test('an early native helper exit rejects a large stdin write without killing the caller and later scans work', { timeout: 20_000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jev-helper-epipe-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const helper = path.join(directory, 'working-helper');
  await fs.writeFile(helper, `#!${process.execPath}\nlet input = ''; process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => {
    const request = JSON.parse(input);
    process.stdout.end(JSON.stringify({ results: request.paths.map(path => ({ path, kind: 'photo',
      capturedAt: '2026-09-21T10:00:00+08:00', offsetMinutes: 480, latitude: null, longitude: null, assetIdentifier: null, error: null })) }));
  });\n`, { mode: 0o700 });
  const root = path.join(directory, 'items');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'photo.jpg'), 'synthetic photo');
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    let binary = '/usr/bin/false';
    mock.module(${JSON.stringify(new URL('../scripts/build-native.js', import.meta.url).href)}, { namedExports: { buildNative: async () => binary } });
    const { inspectMedia } = await import(${JSON.stringify(new URL('../src/media-native.js', import.meta.url).href)});
    const paths = Array.from({ length: 100 }, (_, i) => '/tmp/' + 'x'.repeat(950) + i + '.jpg');
    await assert.rejects(inspectMedia(paths), /media metadata helper failed/);
    binary = ${JSON.stringify(helper)};
    const { Organizer } = await import(${JSON.stringify(new URL('../src/organizer.js', import.meta.url).href)});
    const scan = await new Organizer(${JSON.stringify(path.join(directory, 'data'))}).scan(${JSON.stringify(root)});
    assert.equal(scan.items.length, 1);
    assert.equal(scan.items[0].metadataStatus, 'ok');
    process.stdout.write('caller survived; later scan completed');
  `;
  const { stdout } = await execFile(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { timeout: 15_000 });
  assert.equal(stdout, 'caller survived; later scan completed');
});

test('helper timeout reads the configured milliseconds with a safe default for invalid values', () => {
  assert.equal(typeof nativeConfig.mediaHelperTimeoutMs, 'function');
  assert.equal(nativeConfig.mediaHelperTimeoutMs({ MEDIA_HELPER_TIMEOUT_MS: '5000' }), 5000);
  for (const value of [undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '2147483648', 'garbage']) {
    assert.equal(nativeConfig.mediaHelperTimeoutMs({ MEDIA_HELPER_TIMEOUT_MS: value }), 120000, String(value));
  }
});

test('inspectMedia sends paths over JSON stdin and validates output', async () => {
  const runHelper = async request => {
    assert.deepEqual(request, { operation: 'inspect', paths: ['/tmp/a.jpg'] });
    return { results: [{
      path: '/tmp/a.jpg', kind: 'photo', capturedAt: '2026-09-21T14:30:00+08:00',
      offsetMinutes: 480, latitude: 31.2304, longitude: 121.4737,
      assetIdentifier: null, error: null
    }] };
  };

  assert.equal((await inspectMedia(['/tmp/a.jpg'], { runHelper }))[0].kind, 'photo');
});

test('inspectMedia rejects extra, missing, or relative paths', async () => {
  await assert.rejects(
    inspectMedia(['/tmp/a.jpg'], { runHelper: async () => ({ results: [] }) }),
    /invalid helper response/
  );
  await assert.rejects(
    inspectMedia(['/tmp/a.jpg'], { runHelper: async () => ({ results: [{
      path: '/tmp/other.jpg', kind: 'photo', capturedAt: null, offsetMinutes: null,
      latitude: null, longitude: null, assetIdentifier: null, error: null
    }] }) }),
    /invalid helper response/
  );
  await assert.rejects(
    inspectMedia(['a.jpg'], { runHelper: async () => ({ results: [] }) }),
    /absolute paths/
  );
});

test('reverseGeocode sends points and validates response keys', async () => {
  const points = [{ key: '31.23,121.47', latitude: 31.23, longitude: 121.47 }];
  const places = await reverseGeocode(points, {
    runHelper: async request => {
      assert.deepEqual(request, { operation: 'reverseGeocode', points });
      return { results: [{ key: '31.23,121.47', country: '中国', city: '上海', status: 'resolved' }] };
    }
  });
  assert.deepEqual(places, [{ key: '31.23,121.47', country: '中国', city: '上海', status: 'resolved' }]);
  await assert.rejects(
    reverseGeocode(points, { runHelper: async () => ({ results: [{
      key: 'wrong', country: null, city: null, status: 'unresolved'
    }] }) }),
    /invalid helper response/
  );
});

test('buildNative refuses non-macOS platforms before compiling', async () => {
  await assert.rejects(
    buildNative({ platform: 'linux', execFile: async () => assert.fail('should not compile') }),
    /媒体元数据功能仅支持 macOS。/
  );
});

test('real helper marks a text file unsupported', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-native-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'notes.txt');
  await fs.writeFile(file, 'metadata helper smoke test');
  assert.equal((await inspectMedia([file]))[0].kind, 'unsupported');
});

test('real offset-free EXIF keeps local month and year boundaries in positive and negative scan zones', {
  skip: process.platform !== 'darwin', timeout: 120_000
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jev-local-exif-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'photos'), binary = path.join(directory, 'create-photos');
  await execFile('/usr/bin/xcrun', ['swiftc', path.resolve('test/native/create-offset-free-photos.swift'),
    '-module-cache-path', path.join(directory, 'swift-module-cache'), '-o', binary]);
  await execFile(binary, [root]);
  const expected = new Map([
    ['month-end.jpg', '2026-09-30T16:30:00'], ['year-end.jpg', '2026-12-31T23:30:00'],
    ['month-start.jpg', '2026-10-01T00:30:00'], ['year-start.jpg', '2026-01-01T00:30:00']
  ]);
  const metadata = await inspectMedia([...expected.keys()].map(name => path.join(root, name)));
  for (const item of metadata) {
    assert.equal(item.capturedAt, expected.get(path.basename(item.path)));
    assert.equal(item.offsetMinutes, null);
  }
  for (const timeZone of ['Asia/Shanghai', 'America/Los_Angeles']) {
    const scan = await new Organizer(path.join(directory, 'journal'), { timeZone }).scan(root);
    for (const item of scan.items) {
      assert.equal(item.year, expected.get(item.name).slice(0, 4), `${timeZone} ${item.name}`);
      assert.equal(item.month, expected.get(item.name).slice(5, 7), `${timeZone} ${item.name}`);
      assert.equal(item.inferredDate, true);
      assert.equal(item.dateSource, 'embedded');
    }
  }
});

test('native helper extracts a typed QuickTime Live Photo content identifier', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-live-photo-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const driver = path.join(directory, 'quicktime-identifier-test.swift');
  const binary = path.join(directory, 'quicktime-identifier-test');
  const moduleCache = path.join(directory, 'swift-module-cache');
  await fs.writeFile(driver, `
import AVFoundation
import Foundation

@main
struct QuickTimeIdentifierTest {
    static func main() {
        let item = AVMutableMetadataItem()
        item.identifier = .quickTimeMetadataContentIdentifier
        item.value = "live-photo-content-id" as NSString
        guard quickTimeContentIdentifier([item]) == "live-photo-content-id" else { exit(1) }
    }
}
`);
  await execFile('/usr/bin/xcrun', [
    'swiftc', '-parse-as-library', path.resolve('native/MediaMetadata/quicktime-identifier.swift'), driver,
    '-framework', 'Foundation', '-framework', 'AVFoundation',
    '-module-cache-path', moduleCache, '-o', binary
  ]);
  await execFile(binary);
});
