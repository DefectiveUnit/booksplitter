# Booksplitter

Turn an EPUB into a hand-bound, signature-stitched printable booklet.

Splits the book into signatures (groups of nested/folded sheets), imposes each
signature so pages come out in the correct order after duplex printing and
folding, and lets you tune margins, font size, line height, and paragraph
spacing before printing.

## Run

No build step, no dependencies to install (JSZip is vendored in `vendor/`).

```bash
python -m http.server 8000
```

Then open http://localhost:8000 and choose an `.epub` file.

## Printing

1. Set paper size, sheets-per-signature, margin, chapter options, and typography.
2. Click **Generate**.
3. Click **Print / Save as PDF**.
4. In the print dialog: margins = **None**, scale = **100% / Actual size**,
   duplex = **double-sided**, flip edge = whatever you selected in the app
   (default: long edge / "book style" — the common default for most printers'
   booklet/duplex modes).
5. After printing, assemble each signature separately: fold its sheets in half
   together (nested), then stack the signatures in order and bind along the
   spine.

## How imposition works

See `impose.js` for the saddle-stitch imposition formula and self-checks
(`node impose.js`). Each signature of S sheets holds 4·S pages; the book is
padded with trailing blank pages to a multiple of that, split into consecutive
signature-sized chunks, and each chunk is imposed independently.

## Known limitations (v1)

- EPUB's own embedded CSS is ignored — typography is fully controlled by this
  app's settings, not the source book's styling.
- No widow/orphan control or hyphenation-aware splitting.
- Embedded/custom fonts in the EPUB aren't loaded — pick from the app's font
  list instead.
- DRM-protected EPUBs aren't supported.
- Assumes duplex long-edge flip unless you choose short edge; short-edge
  support doesn't rotate content, so verify with a scratch-paper test first.

## Verifying changes to the imposition math

Before trusting a real book to it, print a small test (2-8 pages) on scratch
paper, fold, and check the page order reads correctly — this is far more
reliable than reasoning about the formula on paper.
