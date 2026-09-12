// Applies user typographic settings as CSS to a flow container.
// Deliberately ignores/strips any CSS the EPUB shipped with (see plan: the source
// styling targets reflowable e-reader screens, not a fixed print trim size).

const DEFAULT_SETTINGS = {
  paperSize: "a4", // "letter" | "a4" | "trade6x9" — the sheet fed into the printer; folded in
                    // half it yields "letter" -> half-letter pages, "a4" -> A5 pages,
                    // "trade6x9" -> 6x9 trade paperback pages (needs custom 9x12in paper).
  signatureSheetCount: 4,
  // Margins are independent per edge. Gutter = inner/spine edge, outside = outer edge —
  // which physical side (left/right) each maps to flips between recto (odd) and verso
  // (even) pages, handled in paginate.js.
  marginTopIn: 0.875,
  marginBottomIn: 0.875,
  marginGutterIn: 0.875,
  marginOutsideIn: 0.875,
  fontFamily: "Garamond, Baskerville, 'Palatino Linotype', Palatino, Georgia, serif",
  fontSizePt: 11.5,
  lineHeight: 1.4,
  paragraphSpacingEm: 0.5,
  paragraphStyle: "block", // "block" (spaced, no indent) | "indent" (first-line indent, no
                            // indent on the paragraph opening a chapter)
  indentEm: 1.5,
  chapterOpenerStyle: "none", // "none" | "dropcap" | "smallcaps"
  runningHeaders: false, // page number + chapter/book title in the top margin
  justify: true,
  duplexFlipEdge: "long", // "long" | "short"
  chapterStartNewPage: true,
  chapterTitleOffsetPercent: 35, // how far down the page a chapter title sits
  chapterTitleFontFamily: "Garamond, Baskerville, 'Palatino Linotype', Palatino, Georgia, serif",
};

// Paper sizes in inches (portrait, full sheet). Trim size = half of this, split
// along the long axis (so folding in half down the middle produces the trim page).
const PAPER_SIZES_IN = {
  letter: { width: 8.5, height: 11 },
  a4: { width: 8.2677, height: 11.6929 }, // 210mm x 297mm
  trade6x9: { width: 9, height: 12 }, // custom sheet — folds to a 6"x9" trade trim
};

function getTrimSizeIn(paperSize) {
  const sheet = PAPER_SIZES_IN[paperSize] || PAPER_SIZES_IN.a4;
  // The sheet is printed in landscape (two half-pages side by side) and folded
  // down the vertical center line, so trim width = half the sheet's long edge,
  // trim height = the sheet's short edge.
  return { width: sheet.height / 2, height: sheet.width };
}

// Human-readable label for the page size you end up with after folding, e.g.
// "A5" for an A4 sheet or "Half-Letter (5.5\" x 8.5\")" for a Letter sheet.
function getTrimSizeLabel(paperSize) {
  if (paperSize === "a4") return "A5";
  if (paperSize === "trade6x9") return `Trade 6" × 9" (needs custom 9"×12" paper in your printer)`;
  const t = getTrimSizeIn(paperSize);
  return `Half-Letter (${t.width}" × ${t.height}")`;
}

/**
 * Build the CSS text applied to both the offscreen pagination ruler and the
 * final print page boxes, so measurement and print use identical typography.
 */
function buildTypographyCss(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return `
    font-family: ${s.fontFamily};
    font-size: ${s.fontSizePt}pt;
    line-height: ${s.lineHeight};
    text-align: ${s.justify ? "justify" : "left"};
    hyphens: ${s.justify ? "auto" : "manual"};
    word-wrap: break-word;
  `;
}

// Selector matching the paragraph that opens a chapter (immediately after the
// chapter's heading, or after the chapter-break marker when there's no heading).
const CHAPTER_OPENER_SELECTOR =
  ".chapter-title + p, .chapter-break + p, " +
  "h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p";

function buildParagraphSpacingCss(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const indentMode = s.paragraphStyle === "indent";

  const paragraphRule = indentMode
    ? `
      p { margin: 0; text-indent: ${s.indentEm}em; }
      ${CHAPTER_OPENER_SELECTOR}, p:first-child { text-indent: 0; }
    `
    : `
      p { margin: 0 0 ${s.paragraphSpacingEm}em 0; text-indent: 0; }
    `;

  const chapterOpenerRule =
    s.chapterOpenerStyle === "dropcap"
      ? `
        ${CHAPTER_OPENER_SELECTOR}::first-letter {
          float: left;
          font-family: ${s.chapterTitleFontFamily};
          font-size: 3.2em;
          line-height: 0.8;
          padding-right: 0.08em;
          padding-top: 0.05em;
        }
      `
      : s.chapterOpenerStyle === "smallcaps"
      ? `
        ${CHAPTER_OPENER_SELECTOR}::first-line {
          font-variant: small-caps;
          letter-spacing: 0.03em;
        }
      `
      : "";

  return `
    ${paragraphRule}
    li, blockquote, .chapter-break + * {
      margin: 0 0 ${s.paragraphSpacingEm}em 0;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 0 0 ${s.paragraphSpacingEm}em 0;
      line-height: 1.2;
    }
    img { max-width: 100%; height: auto; display: block; }
    .chapter-break { display: none; }
    .chapter-title { font-family: ${s.chapterTitleFontFamily}; }
    ${chapterOpenerRule}
    .running-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-family: ${s.chapterTitleFontFamily};
      font-size: 8.5pt;
      color: #444;
      font-variant: small-caps;
      letter-spacing: 0.02em;
    }
    .running-header.verso { flex-direction: row-reverse; }
  `;
}

if (typeof window !== "undefined") {
  window.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  window.PAPER_SIZES_IN = PAPER_SIZES_IN;
  window.getTrimSizeIn = getTrimSizeIn;
  window.getTrimSizeLabel = getTrimSizeLabel;
  window.buildTypographyCss = buildTypographyCss;
  window.buildParagraphSpacingCss = buildParagraphSpacingCss;
}
