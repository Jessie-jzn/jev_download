# React + Vite frontend migration

## Decision

Use React and Vite for the existing local browser UI. Keep the Node HTTP server, TypeSafe classifier, organizer, native Swift helper and JSON API unchanged. Next.js would duplicate the existing server and introduce SSR and deployment concerns without helping this local tool.

## Runtime boundary

Vite builds a static `dist/` containing `index.html`, JS and CSS assets. `npm start` builds first and serves those files through the existing loopback-only Node server. The server accepts only generated, extension-limited static asset paths and retains its Host, Origin and token checks for APIs. `npm run dev:ui` runs Vite with `/api` proxied to the independently running Node server for frontend development.

## UI behavior

React owns navigation, scan session, filters, row edits, classification, selection, notices, confirmation, history and undo. Preserve visible copy, element identifiers and the existing layout where practical. Plain JSX text replaces HTML string templates. Keep media path validation shared with `public/media-paths.js`; React must never submit a free-form destination. Location lookup remains an explicit unchecked opt-in requiring a scan. Ordinary items retain provider confidence; media do not call Jev.

## Acceptance

Browser and API regressions must cover local folder picking, scan, mock Jev retry and confidence, media filters and edits, opt-in geocoding, paired Live Photo move and undo, mobile overflow and no browser errors. A clean build and `npm start` must serve the Vite bundle without starting a second server. Existing filesystem/native tests must remain green. No file data or credentials enter the frontend bundle.
