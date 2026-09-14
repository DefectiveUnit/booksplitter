# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Booksplitter turns an EPUB into a hand-bound, signature-stitched printable
book. It is driven by the `booksplitter` skill
(`.claude/skills/booksplitter/SKILL.md`): the user asks for changes in chat,
Claude edits `book.config.json`, rebuilds, and looks at the result.

No build step and no package dependencies. The typesetting engine runs in a
real browser — pagination needs a real layout engine, since where a line
breaks, how tall a paragraph is, and what a font's cap height measures are
not things worth reimplementing. The only vendored dependency is JSZip
(`vendor/jszip.min.js`, used to unzip the EPUB).

## Status (as of 2026-09-13)

Working end-to-end. Pipeline: `book.config.json` → parse (`epub.js`) →
typography CSS + settings schema (`reflow.js`) → measure and cut into page
boxes (`paginate.js`) → saddle-stitch sheet math (`impose.js`) → build sheet
DOM (`render.js`) → `render.html` ties it together, driven by `build.mjs`.

The reference book (*Burn of the Everflame*, 87 chapters) paginates to 1161
pages in about 6 seconds, imposing to 73 signatures / 292 sheets / 584
printed sides.

`impose.js` has self-checks runnable via `node impose.js` — the saddle-stitch
math is the trickiest part of this app and is verified there.

## How it's driven

`book.config.json` is the single source of truth. `build.mjs` drives headless
Chrome over `render.html` and writes everything to `out/` (gitignored):

```bash
node build.mjs preview   # preview images only — seconds
node build.mjs           # preview images + reading.pdf + imposed.pdf
node build.mjs pdf       # PDFs only
```

`build.mjs` has no dependencies: it serves the directory with `node:http`
(render.html fetches the epub and config over HTTP, which `file://` can't do)
and shells out to Chrome. It retries captures, because Chrome intermittently
exits early against a cold profile and leaves a stub file.

`render.html` is both the headless target and the thing to open in a browser:

```
http://localhost:8000/render.html?mode=preview   # facing-page spreads
http://localhost:8000/render.html?mode=reading   # every page, reading order
http://localhost:8000/render.html?mode=imposed   # duplex sheets
```

Query params `?from= &to= &zoom=` override the config's preview range. The
spread layout of `mode=preview` matters: a drop cap or a chapter sink judged
on a single page in isolation is misleading.

The pipeline scripts are loaded with a cache-buster, because
`python -m http.server` sends no `Cache-Control` and the browser will happily
run yesterday's `epub.js` against today's `render.html`.

**`index.html` / `app.js` / `style.css` are unmaintained** — the old
settings-form app, kept for reference. They duplicate the settings schema and
are not kept in sync with `DEFAULT_SETTINGS`. Add settings to
`book.config.json`, not to the form.

## Typesetting decisions worth knowing

These are load-bearing and easy to undo by accident:

- **Real EPUBs nest their chapter headings arbitrarily deep.** This book uses
  `<div><div><h1>7</h1><h2>LUTHER</h2></div></div>`, so a `:scope > h1`
  lookup finds nothing. `extractChapterOpener()` takes the first heading and
  climbs to the outermost ancestor containing *only* headings.
- **Chapter number and name are extracted separately** and re-typeset into
  our own markup, so they can be sized and styled independently.
- **Drop caps are measured, not guessed.** `applyDropCaps()` measures the
  chapter's actual initial in the actual font via canvas `TextMetrics`, then
  passes the geometry to `::first-letter` through CSS custom properties (the
  only way to vary it per paragraph). A hardcoded cap-height ratio was out by
  enough to collide with the line below.
- **`::first-letter` needs a contiguous text run.** EPUBs wrap the opening
  character in their own spans; `flattenOpeningInitial()` unwraps just that
  prefix, so `“O` drop-caps together instead of the quote mark alone.
- **Chapters parse as XHTML, where `tagName` is lower-case.** Anything
  matching on tag names must normalise case.
- **Nested block containers are flattened** (`unwrapBlockContainers()`).
  Pagination only splits top-level blocks, so a wrapper div is one atomic
  block — that silently clipped 54 entries off the table of contents.
- **Only numbered chapters (plus Prologue/Epilogue) get the full opener.**
  Front matter gets a plain `.section-title`; giving the copyright page a
  drop cap and a 40% sink looks broken, not deluxe.
- **`hyphens: auto` does nothing in Chrome without a `lang`**, so the page
  boxes *and the measuring ruler* both carry it, from the EPUB's metadata.

## Known limitations / outstanding work

- EPUB's own embedded CSS is ignored — typography is fully controlled by the
  app's own settings, not the source book's styling.
- Embedded/custom fonts in the EPUB aren't loaded — only the app's built-in
  font list is available. (This book's display face is Cinzel; we substitute
  letterspaced caps in the built-in serif, which needs no network.)
- Widow/orphan control is in (`minLinesPerFragment`), but its cost is that a
  page may run 1-2 lines short. Facing pages are therefore not always equal
  depth — a real typesetter would fix this by tracking a paragraph tighter,
  which we can't do.
- Chapters start on the next available page, not necessarily a recto. Recto
  starts are the traditional choice but would add ~43 blank pages to an
  87-chapter book.
- The table of contents has no page numbers (it lists chapter names only).
  These could now be generated post-pagination, but aren't.
- DRM-protected EPUBs aren't supported.
- Short-edge duplex flip doesn't rotate content — untested beyond a
  scratch-paper check; verify before trusting a real book.
- No automated test/lint tooling beyond `node impose.js`'s self-checks —
  changes to pagination/imposition should be verified with a small
  (2-8 page) scratch print before trusting a real book.

## Notes for future work

- No test framework wired up beyond the imposition self-checks; if adding
  automated tests for reflow/pagination, keep them dependency-free to match
  the rest of the project.
- A useful cheap check after any pagination/imposition change: build the PDFs
  and count `/MediaBox` occurrences against the expected page count (see
  "Print-mode gotcha" below).

## Print-mode gotcha

@page size must match what is being printed, or Chrome silently scales the
output and the trim size stops being the trim size. `applyPageRule()` in
render.html sets it per mode. The print stylesheet must also beat every
flex-layout selector by specificity (`#out.reading` outranks `#out`) — a
surviving flex `gap` overflows each sheet and emits a stray blank page after
it. Verify by counting `/MediaBox` occurrences in the PDF against the
expected page count.
