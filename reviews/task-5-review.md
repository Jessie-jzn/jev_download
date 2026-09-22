# Task 5 Review

## Spec compliance verdict

**Partial, with the core media safety path implemented.** The handler tests pass for consent gating, scan redaction, media classification exclusion, structured move validation, and Live Photo move/undo behavior. The browser state tests pass for structured media payloads, ordinary-only classification, filters, independent review state, and failed-item editing.

The acceptance verdict remains conditional because the real HTTP suite cannot bind a loopback socket in this sandbox (`listen EPERM`), and Chrome E2E did not start because the browser process is blocked by the sandbox. Those are verification limitations, not standalone implementation failures. The static contract and UI findings below still need attention.

## Findings

### P2: Most POST routes do not enforce their declared request whitelist

- **Location:** [src/server.js](/Users/jessie/work/jev_download/src/server.js:69), [src/server.js](/Users/jessie/work/jev_download/src/server.js:75), [src/server.js](/Users/jessie/work/jev_download/src/server.js:92), [src/server.js](/Users/jessie/work/jev_download/src/server.js:111)
- **Trigger:** Send an otherwise valid `/api/pick-folder`, `/api/scan`, `/api/classify`, or `/api/undo` request with an unknown field, for example `{ root, resolveLocations, target: "/tmp/escape" }` or `{ id, extra: true }`.
- **Impact:** The fields are silently ignored and the request succeeds. `/api/move` correctly rejects envelope and selection extras, but the other declared DTOs are not strict. This leaves stale or misrouted client data accepted at the HTTP boundary and makes the contract inconsistent. The current omission does not bypass the move path checks.
- **Recommendation:** Add a route-level exact-key validator before dispatch: `pick-folder: root`, `scan: root/resolveLocations`, `classify: scanId/itemIds`, and `undo: id`; reject unknown keys with 400. Add regression cases alongside the existing move-envelope tests.

### P2: Active media filters are not exposed as a toggle state

- **Location:** [public/index.html](/Users/jessie/work/jev_download/public/index.html:39), [public/app.js](/Users/jessie/work/jev_download/public/app.js:191)
- **Trigger:** Use the photo/video/Live Photo/review filter buttons with a screen reader or other accessibility tooling.
- **Impact:** The selected filter is represented only by the CSS `active` class. The buttons have no `aria-pressed` (or equivalent tab semantics), so assistive technology cannot tell which view is active even though the filtering behavior works.
- **Recommendation:** Render `aria-pressed="true|false"` for every filter and update it when `state.filter` changes. Keep the CSS class for visual styling.

### P2: The media destination is only fully available in a tooltip

- **Location:** [public/app.js](/Users/jessie/work/jev_download/public/app.js:28)
- **Trigger:** Inspect a media row on a narrow viewport or without hovering the destination cell.
- **Impact:** The visible cell renders the directory segments and a separate `member1 + member2` line; the complete destination (including the root and filename) is placed only in the `title` attribute. This falls short of the design requirement that the preview show the complete target path and is difficult to inspect on touch devices.
- **Recommendation:** Render an explicit, wrapped relative target such as `2026 / 09 / 中国 / 杭州 / 照片 / live.heic + live.mov` (with a visible `目标` label if desired), while retaining the tooltip for the canonical absolute path.

## Contract checks that passed

- `resolveLocations` is accepted only when it is a boolean, and only `true` reaches the scanner/geocoder ([src/server.js](/Users/jessie/work/jev_download/src/server.js:75)).
- Session capability is platform/helper gated ([src/server.js](/Users/jessie/work/jev_download/src/server.js:35)).
- Public scan media rows remove identity, GPS numbers, asset identifiers, and member paths; failed opt-in location resolution adds only a four-decimal `displayCoordinates` string ([src/media-scanner.js](/Users/jessie/work/jev_download/src/media-scanner.js:188), [src/server.js](/Users/jessie/work/jev_download/src/server.js:81)).
- `/api/classify` rejects any media ID before invoking the provider ([src/server.js](/Users/jessie/work/jev_download/src/server.js:94)).
- Move selections are structured and reject arbitrary `target`, `targetSegments`, extra media fields, invalid months, and media fields on ordinary items ([src/server.js](/Users/jessie/work/jev_download/src/server.js:124)).
- Live Photo overrides are forced back to `live-photo`, so a client cannot change the group to video ([src/organizer.js](/Users/jessie/work/jev_download/src/organizer.js:318)).
- Browser move payloads are built from year/month/country/city/media type and never submit a free-form target ([public/app.js](/Users/jessie/work/jev_download/public/app.js:13)).
- Consent changes update guidance only; they do not trigger a request ([public/app.js](/Users/jessie/work/jev_download/public/app.js:254)).
- The mobile CSS provides a horizontal table scroller and wraps media controls ([public/style.css](/Users/jessie/work/jev_download/public/style.css:6)); actual 390x844 overflow and console behavior still need a browser-capable run.

## Code quality verdict

**Good with minor contract and UI hardening needed.** The server keeps private scan data internal, derives targets from validated structured fields, and preserves a single selection/move flow for ordinary and media items. The focused in-process tests are useful and cover the highest-risk media paths. Tightening the remaining route schemas and exposing filter/path state in the UI would make the implementation align more closely with the written contract.

## Verification

Command run:

```text
node --test --test-timeout=30000 test/server.test.js test/server-handler.test.js test/browser-state.test.js
```

Result: 7 passed (3 browser-state/server-handler tests), 4 failed before assertions because the sandbox denied `listen(127.0.0.1, ...)` in `test/server.test.js`. The existing Task 5 report records the same Chrome E2E startup limitation (`SIGABRT`/`kill EPERM`); no conclusion about the implementation is drawn from that environment failure. Static mobile overflow, browser console errors, and real HTTP behavior therefore remain unverified here.

## Fix Round 1 Re-review (2026-09-22)

### Spec compliance: APPROVED

All three prior findings are resolved.

- Exact POST DTOs are defined centrally for `/api/pick-folder`, `/api/scan`, `/api/classify`, `/api/move`, and `/api/undo`, and unexpected keys are rejected before route side effects ([src/server.js](/Users/jessie/work/jev_download/src/server.js:14), [src/server.js](/Users/jessie/work/jev_download/src/server.js:76)). The new handler coverage confirms this for pick-folder, scan, classify, and undo, including that a rejected request does not call the picker, inspect media, geocode, classify, or undo ([test/server-handler.test.js](/Users/jessie/work/jev_download/test/server-handler.test.js:102)).
- Filters start with an explicit pressed state and every render synchronizes visual `active` state and `aria-pressed` from `state.filter` ([public/index.html](/Users/jessie/work/jev_download/public/index.html:39), [public/app.js](/Users/jessie/work/jev_download/public/app.js:65)). The browser-state test covers initial, clicked, and programmatic state changes ([test/browser-state.test.js](/Users/jessie/work/jev_download/test/browser-state.test.js:64)).
- Media rows now visibly show a complete relative target for each member. Live Photos therefore expose both the photo and paired MOV destinations, while preserving the absolute-path tooltip ([public/app.js](/Users/jessie/work/jev_download/public/app.js:28)); the target lines wrap rather than inherit ellipsis clipping ([public/style.css](/Users/jessie/work/jev_download/public/style.css:6)).

### Code quality: APPROVED

The small centralized request-key map removes duplicated whitelist logic while preserving existing field validation. The UI state is derived in `render()`, so programmatic and user-driven filter changes cannot diverge. Tests cover the corrected behavior at the route and browser-script boundaries.

### Verification

Ran without opening a port:

```text
node --test --test-timeout=30000 test/server-handler.test.js test/browser-state.test.js
```

Result: **13 passed, 0 failed**. `node --check src/server.js && node --check public/app.js` also passed.

The parent agent independently ran the real loopback suite outside the sandbox: `node --test test/server.test.js` passed **4/4**. E2E browser/layout assertions remain unexecuted in this sandbox because Chrome cannot launch; this is the existing environment limitation, not a reason to withhold approval for the three scoped fixes.
