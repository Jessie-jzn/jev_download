# Media Date and Location Organizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the local organizer so photos, videos, and Live Photos can be previewed and moved into `<year>/<month>/<country>/<city>/<照片|视频>` using real media metadata.

**Architecture:** A macOS Swift helper reads ImageIO/AVFoundation metadata and performs Core Location reverse geocoding; a Node.js adapter invokes it through JSON stdin/stdout. Focused JavaScript modules normalize dates and paths, cache geocodes, group Live Photos, and hand validated multi-member move plans to the existing journaled organizer. The browser edits structured media fields but never submits arbitrary destination paths.

**Tech Stack:** Node.js 22 ESM, Swift/Foundation/ImageIO/AVFoundation/CoreLocation, native HTML/CSS/JavaScript, `node:test`, Playwright with local Chrome.

**Spec:** `docs/superpowers/specs/2026-09-21-media-date-location-organizer-design.md`

## Global Constraints

- Runtime target is macOS for media metadata; non-macOS systems retain the existing generic organizer and receive an explicit unsupported status.
- Never read or upload media pixels/audio; Jev receives no thumbnail, GPS coordinate, or media content.
- Media paths are `<root>/<year>/<month>/<country>/<city>/<照片|视频>/<original name>`.
- Date priority is embedded metadata, strict filename date, filesystem birth time, then `未知日期/未知月份`.
- Missing or unresolved GPS uses `未知国家/未知城市` until the user edits it.
- Apple reverse geocoding is opt-in and may send coordinates to Apple; cache only rounded coordinate keys and place results.
- Live Photo members move and undo as one logical group; conflicts never overwrite or auto-rename.
- All destination segments are generated and validated on the server; reject traversal, separators, NUL, symlink containers, stale identities, and cross-device moves.
- Preserve existing generic Jev classification and all old journal compatibility.
- The current directory is not a Git repository, so execution uses test-backed checkpoints and cannot perform commit steps.

---

### Task 1: Native Media Metadata Boundary

**Files:**
- Create: `native/MediaMetadata/main.swift`
- Create: `scripts/build-native.js`
- Create: `src/media-native.js`
- Create: `test/media-native.test.js`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: absolute ordinary-file paths already validated by the organizer.
- Produces: `ensureMediaHelper(): Promise<string>`, `inspectMedia(paths, options?): Promise<RawMediaMetadata[]>`, `reverseGeocode(points, options?): Promise<PlaceResult[]>`.
- `RawMediaMetadata` shape: `{ path, kind, capturedAt, offsetMinutes, latitude, longitude, assetIdentifier, error }` where `kind` is `photo`, `video`, or `unsupported`.
- `PlaceResult` shape: `{ key, country, city, status }` where status is `resolved` or `unresolved`.

- [x] **Step 1: Write failing adapter tests**

Create tests that inject `runHelper` instead of launching Swift:

```js
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
});
```

- [x] **Step 2: Run the adapter test and verify RED**

Run: `node --test test/media-native.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/media-native.js`.

- [x] **Step 3: Implement the Node helper runner and build cache**

`scripts/build-native.js` must export `buildNative({ platform, execFile })`, hash `native/MediaMetadata/main.swift`, and compile to `.data/bin/media-metadata-<hash>` using:

```js
await execFile('/usr/bin/xcrun', [
  'swiftc', source,
  '-framework', 'Foundation',
  '-framework', 'ImageIO',
  '-framework', 'AVFoundation',
  '-framework', 'CoreLocation',
  '-o', binary
]);
```

On non-macOS, throw `媒体元数据功能仅支持 macOS。`. Never invoke a shell or interpolate paths into command text.

`src/media-native.js` must spawn the compiled binary with `stdio: ['pipe', 'pipe', 'pipe']`, write one JSON request, enforce a 120-second timeout and 2 MiB output limit, parse exactly one JSON response, and validate that every returned path exactly matches one requested absolute path. Provider stderr is logged only in development and never returned to the browser.

- [x] **Step 4: Implement the Swift JSON protocol and metadata reads**

Define Codable request/response types and dispatch only these operations:

```swift
enum Operation: String, Codable { case inspect, reverseGeocode }

struct Request: Codable {
    let operation: Operation
    let paths: [String]?
    let points: [GeoPoint]?
}

struct RawMediaMetadata: Codable {
    let path: String
    let kind: String
    let capturedAt: String?
    let offsetMinutes: Int?
    let latitude: Double?
    let longitude: Double?
    let assetIdentifier: String?
    let error: String?
}
```

For images, create `CGImageSource` without decoding the image and inspect EXIF/TIFF/GPS dictionaries plus `kCGImagePropertyMakerAppleDictionary` key `17` for the asset identifier. For video, use `AVURLAsset.load(.metadata)` and inspect common creation date, location ISO6709, and QuickTime metadata key `com.apple.quicktime.content.identifier`. Normalize dates to ISO 8601 but retain a separate offset when present. Reject non-file URLs and return `unsupported` rather than throwing for unknown extensions.

For reverse geocoding, call `CLGeocoder.reverseGeocodeLocation` sequentially, set locale to `zh_CN`, and return `country` plus `locality`; fall back to `administrativeArea` when locality is absent. Validate latitude `[-90, 90]` and longitude `[-180, 180]` before making a request.

- [x] **Step 5: Add a native smoke test and scripts**

Add scripts:

```json
{
  "build:native": "node scripts/build-native.js",
  "test:native": "npm run build:native && node --test test/media-native.test.js"
}
```

Extend `.gitignore` with `.data/bin/`. Test an unsupported text file through the real binary and assert `kind === 'unsupported'`; adapter unit tests remain injected and do not require network.

Run: `npm run test:native`

Expected: PASS on macOS, with no GUI prompt and no network call.

---

### Task 2: Deterministic Date, Location, and Path Rules

**Files:**
- Create: `src/media-rules.js`
- Create: `src/geocode-cache.js`
- Create: `test/media-rules.test.js`
- Create: `test/geocode-cache.test.js`

**Interfaces:**
- Consumes: `RawMediaMetadata`, file `birthtime`, filename, user timezone, and optional resolved place.
- Produces: `resolveMediaFacts(input): MediaFacts`, `sanitizeSegment(value, fallback): string`, `buildMediaSegments(facts, overrides?): string[]`.
- `MediaFacts`: `{ mediaType, capturedAt, dateSource, inferredDate, year, month, latitude, longitude, country, city, locationStatus, assetIdentifier }`.
- Cache: `new GeocodeCache(file).resolve(points, geocoder): Promise<Map<string, PlaceResult>>`.

- [x] **Step 1: Write failing date and path tests**

Cover embedded timestamps, filename formats, invalid dates, birthtime, unknown date, timezone month boundaries, and safe path segments:

```js
test('embedded timezone decides the target month', () => {
  const facts = resolveMediaFacts({
    metadata: { kind: 'photo', capturedAt: '2026-10-01T00:30:00+08:00' },
    name: 'IMG_1.jpg', birthtime: new Date('2020-01-01T00:00:00Z'), timeZone: 'Asia/Shanghai'
  });
  assert.equal(facts.dateSource, 'embedded');
  assert.deepEqual(buildMediaSegments({ ...facts, country: '中国', city: '上海' }),
    ['2026', '10', '中国', '上海', '照片']);
});

test('filename and birthtime are explicit fallbacks', () => {
  assert.equal(resolveMediaFacts({ metadata: { kind: 'photo' }, name: 'IMG_20260921_143000.jpg', birthtime: null, timeZone: 'Asia/Shanghai' }).dateSource, 'filename');
  assert.equal(resolveMediaFacts({ metadata: { kind: 'video' }, name: 'clip.mp4', birthtime: new Date('2025-04-03T00:00:00Z'), timeZone: 'Asia/Shanghai' }).dateSource, 'filesystem');
});

test('path segments cannot carry separators or traversal', () => {
  assert.equal(sanitizeSegment('../上/海\0', '未知城市'), '上_海');
  assert.throws(() => buildMediaSegments({ year: '..', month: '09', country: '中国', city: '上海', mediaType: 'photo' }), /invalid year/);
});
```

- [x] **Step 2: Run rule tests and verify RED**

Run: `node --test test/media-rules.test.js test/geocode-cache.test.js`

Expected: FAIL because both modules are missing.

- [x] **Step 3: Implement strict date resolution**

Accept embedded ISO 8601 first. Recognize only these filename forms with calendar validation: `YYYYMMDD_HHMMSS`, `YYYY-MM-DD HH-MM-SS`, and `YYYY-MM-DD`; require boundaries so arbitrary long numbers do not match. Use `Intl.DateTimeFormat(..., { timeZone, year: 'numeric', month: '2-digit' })` for timestamps without an embedded offset and filesystem dates. Return `未知日期` and `未知月份` only when all sources are absent or invalid.

Media type mapping is `photo -> 照片`, `video -> 视频`; Live Photo callers override the directory to `照片`.

- [x] **Step 4: Implement validated segments and geocode cache**

`sanitizeSegment` must normalize Unicode NFC, trim, replace `/`, `:`, and control characters with `_`, collapse repeated `_`, reject `.`/`..`, and cap to 80 Unicode code points. Year accepts exactly four digits or `未知日期`; month accepts `01`-`12` or `未知月份`.

Round coordinates to two decimals for cache keys:

```js
export const coordinateKey = ({ latitude, longitude }) =>
  `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
```

Persist `{ version: 1, entries: { [key]: { country, city, status, updatedAt } } }` atomically with mode `0600`. Reuse resolved entries indefinitely. Retry unresolved entries after 24 hours. Serialize writes through an internal promise queue so concurrent scans cannot corrupt JSON.

- [x] **Step 5: Verify deterministic rules**

Run: `node --test test/media-rules.test.js test/geocode-cache.test.js`

Expected: PASS, including a test proving cache files contain neither media path nor filename.

---

### Task 3: Scan Media and Group Live Photos

**Files:**
- Create: `src/media-scanner.js`
- Create: `test/media-scanner.test.js`
- Modify: `src/organizer.js`
- Modify: `test/organizer.test.js`

**Interfaces:**
- Consumes: validated top-level file candidates and injected `inspectMedia`, `reverseGeocode`, cache, timezone, and `resolveLocations` flag.
- Produces: `scanMedia(files, options): Promise<{ mediaItems, ordinaryPaths }>` and `toPublicScan(scan, options): PublicScan`.
- Extends `Organizer.scan(root, options?)`, where `options = { resolveLocations?: boolean }`.
- Media item shape follows the spec and adds `id`, `members[]`, `identity` per member, `facts`, and server-owned `targetSegments`.

- [x] **Step 1: Write failing mixed-scan tests**

Use injected metadata instead of parsing real media:

```js
test('groups matching photo and video asset identifiers as one Live Photo', async () => {
  const result = await scanMedia([photo, motion], {
    inspectMedia: async () => [
      { path: photo.path, kind: 'photo', assetIdentifier: 'asset-1', capturedAt: '2026-09-21T10:00:00+08:00' },
      { path: motion.path, kind: 'video', assetIdentifier: 'asset-1', capturedAt: '2026-09-21T10:00:00+08:00' }
    ],
    resolveLocations: false,
    timeZone: 'Asia/Shanghai'
  });
  assert.equal(result.mediaItems.length, 1);
  assert.equal(result.mediaItems[0].mediaType, 'live-photo');
  assert.deepEqual(result.mediaItems[0].members.map(m => m.name), ['IMG_1.HEIC', 'IMG_1.MOV']);
});
```

Also assert unsupported extensions remain ordinary files, malformed matching identifiers do not group, and an identifier with two photos or two videos remains separate with a warning.

- [x] **Step 2: Run scanner tests and verify RED**

Run: `node --test test/media-scanner.test.js test/organizer.test.js`

Expected: FAIL because `scanMedia` and scan options do not exist.

- [x] **Step 3: Implement candidate detection and metadata batching**

Use a case-insensitive extension allowlist for candidate detection, but let the helper make the final supported/unsupported decision. Batch at most 100 paths per helper request. Convert helper errors into per-item `metadataStatus: 'failed'`; do not abort the rest of the scan.

For `resolveLocations: false`, retain coordinates only in the organizer's private in-memory scan but expose only a boolean `hasCoordinates` through `toPublicScan`. For `true`, resolve unique rounded points through `GeocodeCache` and attach country/city/status. The public conversion must always omit file identities, absolute member paths, raw asset identifiers, and full-precision coordinates.

- [x] **Step 4: Group Live Photos and integrate Organizer.scan**

Group only one photo plus one video sharing the same non-empty asset identifier. Set `mediaType: 'live-photo'`, `mediaDirectory: '照片'`, and compute facts from the photo; if the photo lacks a date/location, use the paired video value. Keep both member identities from `lstat`.

Change the scan loop to collect top-level ordinary files/directories first, call `scanMedia` once, and merge media logical items with ordinary items. Store the full private scan in `this.scans`, then return `toPublicScan(privateScan, { exposeCoordinates: resolveLocations })` instead of the private object. Preserve IDs, names, editable metadata, warnings, and member display names in the public object; omit identities and private paths. Preserve hidden item, symlink, category-container, root/data-directory, and 500-item protections. `.photoslibrary` directories must be skipped and listed in `skipped`.

- [x] **Step 5: Verify scan behavior and existing classification compatibility**

Run: `node --test test/media-scanner.test.js test/organizer.test.js test/classifier.test.js`

Expected: PASS. Existing ordinary file/folder items still expose `type: 'file'|'folder'`; media exposes `type: 'media'` and is not sent to Jev.

---

### Task 4: Journaled Multi-Segment and Live Photo Moves

**Files:**
- Create: `test/media-move.test.js`
- Modify: `src/organizer.js`

**Interfaces:**
- Consumes: ordinary selection `{ id, category }` or media selection `{ id, media: { year, month, country, city, mediaType } }`.
- Produces: journal entries with `kind: 'single'|'group'` and `members: Array<{ name, source, target, identity, status }>`; old entries without `members` remain readable.
- Adds internal `prepareSelection(scan, selection)` and `recoverEntry(entry)` functions.

- [x] **Step 1: Write failing grouped-move tests**

Cover normal media path creation, rejected traversal, group preflight conflict, successful group move/undo, runtime failure rollback, and restart recovery:

```js
test('a Live Photo conflict skips both members', async t => {
  const { organizer, root, livePhoto } = await mediaFixture(t);
  await fs.mkdir(path.join(root, '2026/09/中国/上海/照片'), { recursive: true });
  await fs.writeFile(path.join(root, '2026/09/中国/上海/照片', livePhoto.videoName), 'occupied');
  const result = await organizer.move(livePhoto.scanId, [{
    id: livePhoto.id,
    media: { year: '2026', month: '09', country: '中国', city: '上海', mediaType: 'photo' }
  }]);
  assert.equal(result.entries[0].status, 'skipped');
  assert.equal(await fs.readFile(livePhoto.photoSource, 'utf8'), 'photo');
  assert.equal(await fs.readFile(livePhoto.videoSource, 'utf8'), 'video');
});
```

- [x] **Step 2: Run grouped-move tests and verify RED**

Run: `node --test test/media-move.test.js`

Expected: FAIL because the organizer accepts only ordinary category selections.

- [x] **Step 3: Implement server-owned media target construction**

Look up selection IDs only in the retained scan. For media, pass overrides through `buildMediaSegments`; allow mediaType changes only for single media items and force Live Photos to `照片`. Join validated segments beneath the scanned root, then verify `path.relative(root, target)` neither starts with `..` nor is absolute.

Create and validate every target container one segment at a time. Reject an existing symlink or non-directory at any level. Record each container identity used for the move.

- [x] **Step 4: Implement group preflight, write-ahead move, rollback, and undo**

Preflight all source identities and all targets before changing anything. Persist the group with status `pending`, then rename members in stable filename order. After every rename, update the in-memory member status; persist after the group reaches `moved`.

If a normal runtime error occurs after a partial group move, rename moved members back in reverse order after revalidating identities and vacant source paths. Set entry status `skipped` after successful rollback or `uncertain` when rollback cannot prove safety.

On startup recovery:

- all identities at source and none at target -> `skipped` or `undone` according to the interrupted action;
- all identities at target and none at source -> `moved`;
- a mixed group -> attempt the same safe rollback, otherwise `uncertain`.

Undo a moved group only after all targets match and all original source paths are empty. Rename in reverse order. On a runtime failure, roll already-restored members forward to their targets when safe; otherwise mark `uncertain`.

Normalize old single-entry journals into one-member views in memory without rewriting their schema merely by reading history.

- [x] **Step 5: Verify file integrity and recovery**

Run: `node --test test/media-move.test.js test/organizer.test.js`

Expected: PASS. Assert SHA-256 before move, after move, and after undo for every member.

---

### Task 5: HTTP Contract and Media Preview UI

**Files:**
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `test/server.test.js`
- Modify: `e2e/organizer.spec.js`

**Interfaces:**
- `GET /api/session` adds `{ mediaSupported: boolean }`.
- `POST /api/scan` accepts `{ root, resolveLocations }`.
- `POST /api/move` keeps `{ scanId, selections }`; media selections use the Task 4 structured shape.
- The browser keeps separate render paths for ordinary and media rows but one selection/execution flow.

- [x] **Step 1: Write failing HTTP and browser tests**

Server tests inject `scanOptions` dependencies and assert `resolveLocations` must be boolean. Assert `/api/scan` never includes `identity`, `latitude`, `longitude`, `assetIdentifier`, or absolute member paths when location resolution is off. Reject arbitrary `target`, `targetSegments`, extra media keys, invalid months, and media overrides for ordinary items.

Extend Playwright fixtures with one photo, one video, one paired Live Photo, one ordinary file, and one folder. Assert:

```js
await expect(page.getByText('2026 / 09 / 中国 / 上海 / 照片')).toBeVisible();
await expect(page.getByText('Live Photo · 2 个文件')).toBeVisible();
await page.getByLabel('允许 Apple 根据 GPS 查询国家和城市').check();
```

After editing a city to `杭州`, execute and assert both Live Photo files move beneath `2026/09/中国/杭州/照片`, then undo and assert both return.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test test/server.test.js && npm run test:e2e`

Expected: FAIL because the HTTP options and media row controls do not exist.

- [x] **Step 3: Extend HTTP validation and privacy consent**

Expose media support based on `process.platform === 'darwin'` and helper availability. Accept `resolveLocations` only as explicit `true`; absent/false means no Core Location call. Never return raw GPS coordinates unless location resolution failed and the user explicitly enabled it; then return a display-only coordinate rounded to four decimals.

Classification must filter to ordinary item IDs. If media IDs are submitted to `/api/classify`, return 400 rather than sending them to Jev.

- [x] **Step 4: Add media rows and structured editing**

Add filters for photos, videos, Live Photos, location review, and date review. A media row displays:

```text
IMG_2048.HEIC
照片 · 2026-09-21 14:30 · 元数据
中国 / 上海
目标：2026 / 09 / 中国 / 上海 / 照片
```

Use compact inputs/selects for year, month, country, city, and photo/video. Live Photo type is read-only. Ordinary rows retain category and Jev confidence. Build move payloads from those structured fields; do not store or submit a free-form path.

Add an unchecked toggle labeled `允许 Apple 根据 GPS 查询国家和城市`. Its helper text states that media stays local while coordinates may be sent to Apple. Turning it on requires rescanning or a dedicated “解析地点” action; it must never silently trigger from page load.

- [x] **Step 5: Handle loading, partial results, and responsive layout**

Show independent statuses for metadata extraction and place lookup. A failed item remains editable. Preserve stable table dimensions, allow horizontal table scrolling on narrow devices, and ensure input labels remain visible. Do not place implementation jargon such as ImageIO or Core Location in the primary workflow.

- [x] **Step 6: Verify HTTP and UI flows**

Run: `node --test test/server.test.js && npm run test:e2e`

Expected: PASS on desktop and 390x844 mobile viewport with no horizontal document overflow, no browser console error, and actual temporary-directory move/undo.

---

### Task 6: Native Fixtures, Full Regression, and Documentation

**Files:**
- Create: `test/native/create-media-fixtures.swift`
- Create: `test/media-integration.test.js`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/superpowers/plans/2026-09-21-media-date-location-organizer.md`

**Interfaces:**
- Fixture generator outputs a manifest with paths and expected metadata under a caller-provided temporary directory.
- Integration test exercises the real compiled helper without calling Apple geocoding; geocoding remains covered through injected tests.

- [x] **Step 1: Create local synthetic media fixtures**

The Swift fixture generator must create:

- a tiny JPEG with `DateTimeOriginal=2026:09:21 14:30:00`, `OffsetTimeOriginal=+08:00`, and Shanghai GPS;
- a tiny HEIC and MOV sharing asset identifier `test-live-photo-1`;
- a tiny MP4/MOV with a QuickTime creation timestamp;
- a media file without date or GPS.

Generate all pixel/audio content procedurally in the temporary test directory. Do not add personal media or binary fixtures to the repository. Emit JSON containing expected hashes and metadata.

- [x] **Step 2: Write and run real-helper integration tests**

Run the fixture generator, call `inspectMedia`, and assert the embedded timestamps, GPS tolerance, kinds, and Live Photo identifier. Then scan, move, and undo the fixture directory while comparing SHA-256 hashes.

Run: `node --test test/media-integration.test.js`

Expected: PASS without network access.

- [x] **Step 3: Update user documentation and configuration**

Document:

- the final directory structure and fallback paths;
- supported formats and the Photos library exclusion;
- local metadata behavior and Apple geocoding consent;
- Live Photo grouping;
- manual correction of date/country/city;
- build prerequisite `xcrun --find swiftc`;
- service remains useful for generic organization when native media support is unavailable.

Add optional `.env.example` values with exact defaults:

```dotenv
MEDIA_GEOCODE_CACHE_TTL_HOURS=24
MEDIA_HELPER_TIMEOUT_MS=120000
```

- [x] **Step 4: Run final verification**

Run, in order:

```sh
npm run build:native
npm test
npm run check
npm run test:e2e
```

Expected: all tests pass; syntax checks are clean; browser screenshots show ordinary and media items together; tests perform writes only in temporary directories.

- [x] **Step 5: Update plan status and record the real-service limitation**

Mark every completed checkbox in this plan. Record that no real Apple reverse-geocoding request was made during automated tests; the first manual acceptance run requires user opt-in and network availability. Record whether the configured TypeSafe key was used only for the existing generic classifier or left uncalled during media testing.


## Verification status — 2026-09-22

Tasks 1–6 are complete; prior RED/GREEN and review evidence is recorded in `.superpowers/sdd/2026-09-21-media-date-location-organizer/progress.md`. The final `npm run test:e2e` run passed 3/3 outside the restricted sandbox. It produced `media-desktop.png` and `media-mobile.png` under `test-results/`, and the desktop, 390x844 document-overflow, browser-console, Live Photo move, and undo assertions all passed.

Task 6 verification: `npm run build:native` passed; `node --test test/media-integration.test.js` passed on real macOS media (1/1, no skips); after configuration, format-list, and Photos library root protection changes, `npm test` passed 123/123 with zero failures/skips; `npm run check` and explicit syntax checks of media modules and integration test passed. The full suite requires permission to bind localhost and use macOS HEIC encoding services in restricted environments. The sandbox-only run failed specifically at HEIC IOSurface/CoreVideo encoding and four localhost HTTP listeners; the approved unrestricted run passed.

The synthetic generator emits JPEG EXIF date/offset/Shanghai GPS, HEIC+MOV with `test-live-photo-1`, a QuickTime-dated MOV, and an undated/ungeotagged PNG, plus SHA-256 and expected metadata manifest. HEIC's ImageIO writer uses a fixed-size Apple MakerNote identifier field: the fixture validates the exact generated header and corrects its ASCII count/padding for the deliberately short test ID. No production metadata parser normalization or test skip was added. MOV uses a single procedural JPEG-coded frame. All fixture files and generator binaries live in temporary directories; production helper build artifacts stay in `.data/`.

The optional settings now actually take effect: helper timeout defaults to 120000 ms, failed-place cache expiry to 24 hours; invalid values fall back safely. Scanner formats now agree with the native helper (HEIF included; ORF/RW2 ordinary). Direct selection of a `.photoslibrary` root or descendant, including aliases into the library, is rejected before scanning; parent scans still skip library packages.

No real Apple reverse-geocoding request was made. Manual Apple acceptance still requires explicit user opt-in and working network. No configured TypeSafe/Jev key was called during media testing or this automated regression; generic classifier tests use local mock responses. Real Jev classification and Apple place quality remain manual acceptance items.
