# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Booksplitter is a static, no-build, no-dependency web app that turns an EPUB
into a hand-bound, signature-stitched printable booklet. Everything runs
client-side in the browser; the only vendored dependency is JSZip
(`vendor/jszip.min.js`, used to unzip the EPUB).

## Status (as of 2026-09-09)

Working end-to-end v1. Pipeline: pick `.epub` → parse (`epub.js`) → reflow
into a single flowable HTML stream (`reflow.js`) → paginate into page-sized
divs (`paginate.js`) → impose pages onto sheets/signatures for saddle-stitch
duplex printing (`impose.js`) → render preview (`render.js`) → print
(`app.js` orchestrates all of it, wired to the settings form in
`index.html`).

Settings exposed in the UI: paper size (A4/Letter), sheets per signature,
margin, duplex flip edge (long/short), chapter-start-new-page + chapter
title position/font, and typography (font family, size, line height,
paragraph spacing, justify).

`impose.js` has self-checks runnable via `node impose.js` — the saddle-stitch
math is the trickiest part of this app and is verified there.

## Run

```bash
python -m http.server 8000
```
Open http://localhost:8000, choose an `.epub` file.

## Known limitations / outstanding work (from README v1 notes)

- EPUB's own embedded CSS is ignored — typography is fully controlled by the
  app's own settings, not the source book's styling.
- No widow/orphan control or hyphenation-aware splitting.
- Embedded/custom fonts in the EPUB aren't loaded — only the app's built-in
  font list is available.
- DRM-protected EPUBs aren't supported.
- Short-edge duplex flip doesn't rotate content — untested beyond a
  scratch-paper check; verify before trusting a real book.
- No automated test/lint tooling beyond `node impose.js`'s self-checks —
  changes to pagination/imposition should be verified with a small
  (2-8 page) scratch print before trusting a real book.

## Notes for future work

- Not currently a git repository — consider `git init` if version history
  becomes valuable.
- No test framework wired up beyond the imposition self-checks; if adding
  automated tests for reflow/pagination, keep them dependency-free to match
  the rest of the project.
