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
  paragraphStyle: "indent", // "block" (spaced, no indent) | "indent" (first-line indent, no
                            // indent on the paragraph opening a chapter)
  indentEm: 1.2,

  // --- Chapter opener ---
  // The opener occupies the top `chapterOpenerSpacePercent` of the text block, with
  // the title group centred in that space — the classic trade-paperback "sink".
  chapterOpenerSpacePercent: 40,
  chapterLabelText: "Chapter", // "" to omit the word entirely
  chapterLabelSizePt: 8.5,
  chapterNumberSizePt: 30,
  chapterNameSizePt: 13,
  chapterRuleStyle: "ornament", // "none" | "line" | "ornament" (line with a centre diamond)
  chapterDisplayFontFamily: "'Palatino Linotype', Palatino, Georgia, Garamond, serif",

  // --- Opening paragraph ---
  dropCap: true,
  dropCapLines: 3,
  // How far the capital rises above the first line's cap-top, as a percentage of
  // the body cap height. Its bottom stays pinned to the Nth baseline, so this
  // grows the letter slightly rather than shifting it. A capital that aligns
  // *exactly* with the line beside it reads as sitting a touch low — the eye
  // wants a round or pointed letter to overshoot, the way O and A do at text
  // size. 0 is flush alignment; much above ~10 starts to look detached.
  dropCapRisePercent: 6,

  // --- Folios / running heads ---
  runningHeaders: false, // chapter/book title in the top margin
  // Where the running head sits in the space between the top of the page and the
  // first line of text, as a fraction of that distance. Sitting it just below the
  // midpoint looks settled; hard against the top edge looks like a browser header.
  runningHeaderDepthFraction: 0.55,
  pageNumbers: true,
  pageNumberPosition: "bottom-center", // "bottom-center" | "bottom-outside"

  // Widow/orphan control: the fewest lines of a split paragraph allowed to sit on
  // either side of a page break. 2 is the standard rule — a single stranded line is
  // the most conspicuous fault in an otherwise well-set page.
  minLinesPerFragment: 2,

  justify: true,
  // Drives `hyphens: auto` — Chrome won't hyphenate without a language tag it has
  // a dictionary for, and justified text badly needs hyphenation at this measure.
  language: "en",
  duplexFlipEdge: "long", // "long" | "short"
  chapterStartNewPage: true,
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
    /* Ink is set explicitly rather than inherited: a page box is dropped into
       whatever host page is previewing it, and must print near-black regardless.
       Not pure black — a touch of warmth reads better on cream stock. */
    color: #17130f;
    line-height: ${s.lineHeight};
    text-align: ${s.justify ? "justify" : "left"};
    hyphens: ${s.justify ? "auto" : "manual"};
    word-wrap: break-word;
  `;
}

// Paragraphs that must NOT take a first-line indent: the one opening a chapter and
// the one resuming after a scene break. (Indenting the first line of a block of
// prose only makes sense to separate it from the line above — there isn't one here.)
const UNINDENTED_PARAGRAPH_SELECTOR =
  "p.chapter-opening, .chapter-opener + p, .scene-break + p, p:first-child";

// Cap height as a fraction of the em, for the serif faces in the built-in stack.
// (Garamond/Palatino/Georgia all sit close to this; it's the one number the whole
// drop-cap geometry is calibrated against.)
const CAP_HEIGHT_RATIO = 0.7;

/**
 * Geometry for a drop cap that spans exactly `lines` lines of body text.
 *
 * Two things have to be true, and they pull in different directions:
 *  1. The capital must *be* `lines * lineHeight` ems tall — that fixes font-size,
 *     since the visible cap is only CAP_HEIGHT_RATIO of the font size.
 *  2. Its float box must also be exactly `lines * lineHeight` ems tall, or the
 *     float intrudes into one more line than it should and the text wraps around
 *     four lines for a three-line cap. The float box is
 *     fontSize * (lineHeight + paddingTop), so those two must sum to
 *     CAP_HEIGHT_RATIO.
 *
 * Within that budget, paddingTop buys the optical alignment: a line box is taller
 * than the text in it, so the first line's capital starts partway down its box, and
 * the drop cap has to be pushed down by the same amount to sit flush with it.
 */
function dropCapGeometry(lines, lineHeight, risePercent = DEFAULT_SETTINGS.dropCapRisePercent) {
  // How far below the top of its line box the first line's capital begins:
  // half the leading, plus the gap between the em-box top and the cap.
  const flushNudgeEm = (lineHeight - 1) / 2 + (1 - CAP_HEIGHT_RATIO) / 2.4;
  // The rise lifts the cap-top without moving the bottom, so the span the capital
  // has to cover grows by the same amount that the padding above it shrinks.
  const riseEm = Math.max(0, risePercent / 100) * CAP_HEIGHT_RATIO;
  const nudgeBodyEm = Math.max(0, flushNudgeEm - riseEm);
  const fontSizeEm = (lines * lineHeight + (flushNudgeEm - nudgeBodyEm)) / CAP_HEIGHT_RATIO;
  const paddingTopEm = nudgeBodyEm / fontSizeEm; // re-expressed in the cap's own em
  return {
    fontSizeEm,
    paddingTopEm,
    // The float box still has to measure exactly N lines, or the text wraps
    // around one line too many.
    lineHeight: (lines * lineHeight) / fontSizeEm - paddingTopEm,
  };
}

// Kept as the simple public form; the full geometry is what the CSS uses.
function dropCapFontSizeEm(lines, lineHeight, risePercent) {
  return dropCapGeometry(lines, lineHeight, risePercent).fontSizeEm;
}

function buildParagraphSpacingCss(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const indentMode = s.paragraphStyle === "indent";

  const paragraphRule = indentMode
    ? `
      p { margin: 0; text-indent: ${s.indentEm}em; }
      ${UNINDENTED_PARAGRAPH_SELECTOR} { text-indent: 0; }
    `
    : `
      p { margin: 0 0 ${s.paragraphSpacingEm}em 0; text-indent: 0; }
    `;

  const cap = dropCapGeometry(s.dropCapLines, s.lineHeight, s.dropCapRisePercent);
  const dropCapRule = s.dropCap
    ? `
      /* The initial is wrapped in its own span by epub.js rather than selected
         with ::first-letter, which would also enlarge the punctuation after it
         (a three-line apostrophe on a chapter opening "I'd walked…"). */
      p.chapter-opening .dropcap {
        float: left;
        font-family: ${s.chapterDisplayFontFamily};
        /* The custom properties are set per paragraph by applyDropCaps(), which
           measures the chapter's own initial in the real font. These literals are
           only the fallback for when that measurement isn't available. */
        font-size: var(--dropcap-size, ${cap.fontSizeEm.toFixed(3)}em);
        line-height: var(--dropcap-line-height, ${cap.lineHeight.toFixed(4)});
        padding-top: var(--dropcap-padding-top, ${cap.paddingTopEm.toFixed(4)}em);
        /* Tight: the letters after the cap are the rest of its own word ("Oh…"),
           so anything like a word-space here reads as a gap in the word. */
        padding-right: 0.02em;
        font-weight: normal;
      }
      /* The source markup often wraps the initial in its own <span> carrying the
         EPUB's own float/size drop-cap styling. Neutralise it so our .dropcap is
         the only thing making a drop cap — and exclude .dropcap itself, which is
         also a first-child span and would otherwise be flattened by its own rule. */
      p.chapter-opening > span:first-child:not(.dropcap),
      p.chapter-opening > span:first-child:not(.dropcap) > span:first-child {
        float: none !important;
        font-size: inherit !important;
        line-height: inherit !important;
        margin: 0 !important;
      }
    `
    : "";

  const ruleMarkup =
    s.chapterRuleStyle === "none"
      ? `.chapter-rule { display: none; }`
      : s.chapterRuleStyle === "line"
      ? `
        .chapter-rule {
          width: 2.2em;
          height: 1px;
          background: currentColor;
          opacity: 0.5;
          margin: 0.85em auto;
        }
      `
      : `
        /* A hairline rule interrupted by a small diamond — drawn in CSS so it needs
           no font or image, and scales with the chapter-name size. */
        .chapter-rule {
          position: relative;
          width: 5em;
          height: 1px;
          background: currentColor;
          opacity: 0.55;
          margin: 0.95em auto;
        }
        .chapter-rule::after {
          content: "";
          position: absolute;
          left: 50%;
          top: 50%;
          width: 0.34em;
          height: 0.34em;
          background: currentColor;
          transform: translate(-50%, -50%) rotate(45deg);
        }
      `;

  return `
    ${paragraphRule}
    li, blockquote {
      margin: 0 0 ${s.paragraphSpacingEm}em 0;
    }
    blockquote {
      margin-left: ${s.indentEm}em;
      margin-right: ${s.indentEm}em;
      text-indent: 0;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 0 0 ${s.paragraphSpacingEm}em 0;
      line-height: 1.2;
      text-indent: 0;
    }
    img { max-width: 100%; height: auto; }
    /* Cover/plate pages are often an <svg> wrapping an <image>, sized in percent —
       which resolves against nothing useful in a flowed page box. Pin it to the
       measure so it lays out instead of collapsing. */
    svg { max-width: 100%; height: auto; }
    .chapter-break { display: none; }

    /* Internal EPUB links (tables of contents, footnote markers) are still <a>
       elements. On paper there is nothing to click, and browser-blue underlined
       text in the middle of a book page is the single most obvious tell that this
       was printed from a web page. */
    a { color: inherit; text-decoration: none; }

    /* Front and back matter: a heading, not a chapter opener. */
    .section-title {
      font-family: ${s.chapterDisplayFontFamily};
      font-size: ${s.chapterNameSizePt}pt;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      text-indent: 0.2em;
      text-align: center;
      font-weight: normal;
      margin: 0 0 2em;
      break-after: avoid;
    }

    /* --- Chapter opener --------------------------------------------------- */
    /* The sink: the opener reserves the top slice of the text block and centres
       the title group within it, so every chapter starts at the same depth. */
    .chapter-opener {
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      text-indent: 0;
      box-sizing: border-box;
      font-family: ${s.chapterDisplayFontFamily};
      /* No margin below: the sink's own height is the whole of the reserved space,
         so the text block starts exactly at chapterOpenerSpacePercent down. */
      margin: 0;
      break-inside: avoid;
    }
    .chapter-opener-inner { width: 100%; }
    .chapter-label {
      font-size: ${s.chapterLabelSizePt}pt;
      text-transform: uppercase;
      letter-spacing: 0.32em;
      /* letter-spacing adds a trailing space after the last letter, which throws
         a centred line off by half that much — pull it back. */
      text-indent: 0.32em;
      opacity: 0.7;
      margin-bottom: 0.5em;
      line-height: 1.2;
    }
    .chapter-number {
      font-size: ${s.chapterNumberSizePt}pt;
      line-height: 1;
      font-weight: normal;
    }
    .chapter-name {
      font-size: ${s.chapterNameSizePt}pt;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      text-indent: 0.2em;
      font-weight: normal;
      line-height: 1.3;
      margin: 0;
    }
    ${ruleMarkup}
    ${dropCapRule}

    /* --- Scene break ------------------------------------------------------ */
    .scene-break {
      text-align: center;
      text-indent: 0;
      margin: 1.1em 0;
      break-inside: avoid;
    }
    .scene-break img {
      display: inline-block;
      width: auto;
      max-width: 32%;
      max-height: 1.1em;
      opacity: 0.75;
    }

    /* --- Folios and running heads ----------------------------------------- */
    .running-header, .folio {
      font-family: ${s.chapterDisplayFontFamily};
      text-indent: 0;
      text-align: center;
    }
    .running-header {
      display: flex;
      justify-content: center;
      align-items: baseline;
      font-size: 8.5pt;
      color: #444;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      text-indent: 0.16em;
      /* The header band is a fixed height that pagination has already budgeted for;
         a title that wrapped to two lines would spill into the text block. */
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    .folio {
      font-size: 9.5pt;
      color: #333;
      letter-spacing: 0.08em;
    }
    .folio.outside-recto { text-align: right; }
    .folio.outside-verso { text-align: left; }
  `;
}

if (typeof window !== "undefined") {
  window.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  window.PAPER_SIZES_IN = PAPER_SIZES_IN;
  window.getTrimSizeIn = getTrimSizeIn;
  window.getTrimSizeLabel = getTrimSizeLabel;
  window.buildTypographyCss = buildTypographyCss;
  window.buildParagraphSpacingCss = buildParagraphSpacingCss;
  window.dropCapFontSizeEm = dropCapFontSizeEm;
  window.dropCapGeometry = dropCapGeometry;
}
