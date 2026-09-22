# Smart Inbox Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with tests before production code.

**Goal:** Extend the local organizer into a persistent smart inbox system with per-inbox taxonomies, explainable suggestions, and review-before-move behavior.

**Architecture:** Keep the existing Organizer as the filesystem transaction boundary. Add small JSON-backed stores for inbox definitions and pending review items. The Node API owns persistence and validation; React renders the selected inbox and pending review state. Existing media scanning, TypeSafe classification, journaling, and undo remain the execution primitives.

**Tech Stack:** Node.js 22, native HTTP, React 19, Vite, Node test runner, existing TypeSafe SDK.

**Spec:** `docs/architecture-flow.md`, `CONTEXT.md`, and ADRs 0001-0007.

## Global Constraints

- New files default to suggestion and review; no implicit move.
- Each inbox owns its taxonomy and rules.
- Taxonomies support flat or maximum three-level paths.
- Category paths map to destinations by default, with safe custom destinations.
- Pending items persist across restart and are invalidated when source identity changes.
- Manual correction outranks rules, history, media rules, AI, and fallback.
- Media content stays local; TypeSafe receives only ordinary project metadata already documented by the app.
- Existing move, rollback, recovery, and undo guarantees must remain intact.

### Task 1: Persist inbox definitions

**Files:** Create `src/inbox-store.js`; test `test/inbox-store.test.js`.

- [ ] Write tests for creating an inbox with a private taxonomy, rejecting paths outside the root, and reloading definitions after a new store instance.
- [ ] Run `node --test test/inbox-store.test.js` and confirm the missing-module failure.
- [ ] Implement atomic JSON persistence with mode `0600`, taxonomy depth validation, category path validation, and per-inbox root resolution.
- [ ] Run the focused test until green.

### Task 2: Persist pending review items

**Files:** Create `src/pending-store.js`; test `test/pending-store.test.js`.

- [ ] Write tests for save/list/update/remove, restart persistence, and source identity invalidation.
- [ ] Run the focused test and verify the expected failure.
- [ ] Implement an atomic per-inbox pending journal containing scan identity, recommendation source, category, destination, and review status.
- [ ] Run the focused test until green.

### Task 3: Expose inbox and pending APIs

**Files:** Modify `src/server.js`; test `test/server-inbox.test.js`.

- [ ] Add failing HTTP tests for `GET /api/inboxes`, `POST /api/inboxes`, and `GET /api/inboxes/:id/pending` with session protection.
- [ ] Implement strict request schemas and connect the stores to `createApp`.
- [ ] Add scan/classify persistence hooks without changing the existing `/api/move` contract.
- [ ] Run focused HTTP tests, then existing server tests.

### Task 4: React inbox and review UI

**Files:** Modify `ui/App.jsx`, `ui/Rows.jsx`, `ui/item-model.js`, `ui/style.css`; test with existing Playwright workflow plus a new review test.

- [ ] Add a failing browser assertion for inbox selection, pending count, recommendation source, and explicit review before move.
- [ ] Add inbox selector/configuration, pending review state, per-item source/status display, and batch confirmation.
- [ ] Keep existing manual scan and history views working when no inbox is configured.
- [ ] Run the focused browser test and existing model tests.

### Task 5: Rules and learning suggestions

**Files:** Create `src/rule-engine.js`; test `test/rule-engine.test.js`; integrate with stores and API.

- [ ] Test priority ordering: manual override, explicit rule, history, media rule, AI, fallback.
- [ ] Implement explainable rule matches and learning suggestions that require confirmation before activation.
- [ ] Add UI for accepting or rejecting learned rule suggestions.
- [ ] Run all unit and browser tests.

### Task 6: Verification and documentation

- [ ] Run `npm run build` and `npm run check`.
- [ ] Run `npm test` and `npm run test:e2e` outside the restricted sandbox if local port/browser permissions are required.
- [ ] Update README with inbox setup, review lifecycle, taxonomy editing, and persistence behavior.
- [ ] Review the implementation against `CONTEXT.md` and ADRs 0001-0007.
