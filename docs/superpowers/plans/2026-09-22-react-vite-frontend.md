# React + Vite Frontend Migration Plan

**Goal:** Replace the native DOM frontend with React while retaining the current local Node backend and user workflows.

**Architecture:** Vite builds `ui/` into static `dist/`; Node serves this output with an asset allowlist. React holds transient UI state and calls the existing JSON endpoints. `public/media-paths.js` remains the single path rule implementation shared with Node.

**Spec:** `docs/superpowers/specs/2026-09-22-react-vite-frontend-design.md`

## Steps

1. Add an HTTP regression proving the Node server serves a Vite-built entry and asset files. Extend Playwright to assert the React root while retaining real ordinary and media workflows. Confirm the new checks fail against the native DOM page.
2. Add React, ReactDOM, Vite and its React plugin; configure the build, dev API proxy and start/build scripts. Keep the existing app running from a single localhost Node service in production.
3. Move page markup and interactions to focused React components under `ui/`. Preserve input IDs and accessible names, consent gating, classification confidence, structured media edits, export, and batch undo. Retain existing stylesheet and responsive behavior.
4. Serve only the built index and generated assets from `dist/`; preserve existing API and the public shared path module. Update README and static-route tests. Remove unused imperative frontend code.
5. Run `npm run build`, `npm test`, `npm run check`, and `npm run test:e2e`. Inspect desktop/mobile screenshots, ensure no horizontal document overflow, then start `npm start` and provide the local URL.
