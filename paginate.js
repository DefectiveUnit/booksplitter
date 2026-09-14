// "Measure and cut" pagination: splits flowed HTML into fixed-size page divs
// matching the trim content box, so pages can be fed into imposition/printing.
//
// Known limitations (see plan): no widow/orphan control; word-boundary splitting
// walks text nodes directly, so a split that lands inside a deeply-nested inline
// element (e.g. <em><strong>...</strong></em> spanning the break) may produce a
// slightly imperfect but still readable front/remainder pair.

const PX_PER_IN = 96;
const SPLITTABLE_TAGS = new Set(["P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
// Fixed vertical band reserved at the top of the content box for the running
// header (page number + chapter/book title), so it doesn't disturb pagination
// as the actual header text (which varies per page) is filled in afterwards.
const RUNNING_HEADER_BAND_PX = 34;
// Same idea at the foot of the page, for the folio (page number).
const FOLIO_BAND_PX = 30;
// An image at least this many times wider than it is tall is a rule/ornament
// (a scene-break flourish), not a figure — it gets set small and centred rather
// than filling the measure.
const ORNAMENT_ASPECT_RATIO = 4;

/**
 * @param {string} flowHtml concatenated chapter HTML from parseEpub()
 * @param {object} settings see reflow.js DEFAULT_SETTINGS
 * @param {string} [bookTitle] shown in the running header on verso pages, if enabled
 * @returns {Promise<HTMLDivElement[]>} array of page divs (class="page"), detached from DOM,
 *   each sized to the trim content box and ready to be moved into imposed sheet slots.
 */
async function paginateContent(flowHtml, settings, bookTitle) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const trim = getTrimSizeIn(s.paperSize);
  const trimWidthPx = Math.round(trim.width * PX_PER_IN);
  const trimHeightPx = Math.round(trim.height * PX_PER_IN);
  const marginTopPx = Math.round(s.marginTopIn * PX_PER_IN);
  const marginBottomPx = Math.round(s.marginBottomIn * PX_PER_IN);
  const marginGutterPx = Math.round(s.marginGutterIn * PX_PER_IN);
  const marginOutsidePx = Math.round(s.marginOutsideIn * PX_PER_IN);
  const headerBandPx = s.runningHeaders ? RUNNING_HEADER_BAND_PX : 0;
  const folioBandPx = s.pageNumbers ? FOLIO_BAND_PX : 0;
  // Content box = trim size minus the gutter+outside margins (width) and
  // top+bottom margins plus any reserved running-header / folio bands (height).
  const targetWidthPx = trimWidthPx - marginGutterPx - marginOutsidePx;
  const targetHeightPx =
    trimHeightPx - marginTopPx - marginBottomPx - headerBandPx - folioBandPx;

  // Measurements are only valid for one settings pass — a re-generate at a
  // different font size or line height must not reuse them.
  lineHeightCache.clear();

  const ruler = document.createElement("div");
  ruler.style.position = "fixed";
  ruler.style.left = "-99999px";
  ruler.style.top = "0";
  ruler.style.width = targetWidthPx + "px";
  ruler.style.height = "auto";
  ruler.style.visibility = "hidden";
  // `hyphens: auto` is a no-op in Chrome unless the element declares a language it
  // has a hyphenation dictionary for. Without this, justified text can't break
  // words and opens rivers of white space — and the ruler must carry it too, or it
  // measures different line counts than the page it's measuring for.
  ruler.lang = s.language;
  ruler.setAttribute("style", ruler.getAttribute("style") + ";" + buildTypographyCss(s));
  const styleTag = document.createElement("style");
  styleTag.textContent = buildParagraphSpacingCss(s);
  ruler.appendChild(styleTag);
  document.body.appendChild(ruler);

  try {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    const container = document.createElement("div");
    container.innerHTML = flowHtml;

    // Give each chapter opener its fixed "sink" — a block of reserved height at the
    // top of the chapter's first page, with the title group centred inside it — so
    // every chapter begins at exactly the same depth and pagination accounts for it.
    const sinkPx = Math.round((targetHeightPx * s.chapterOpenerSpacePercent) / 100);
    container.querySelectorAll(".chapter-opener").forEach((el) => {
      el.style.height = sinkPx + "px";
      // The word "Chapter" is a typographic choice, not part of the book, so the
      // parser leaves the slot empty and the setting fills it (or removes it).
      const label = el.querySelector(".chapter-label");
      if (label) {
        if (s.chapterLabelText) label.textContent = s.chapterLabelText;
        else label.remove();
      }
    });

    if (s.dropCap) applyDropCaps(container, s);
    await sizeImages(container, targetWidthPx, targetHeightPx);

    const blocks = Array.from(container.childNodes).filter(
      (n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim())
    );

    const { pageBlockLists, pageChapterTitles } = paginateBlocks(
      blocks, ruler, targetHeightPx, s.chapterStartNewPage, Math.max(1, s.minLinesPerFragment)
    );

    const pages = pageBlockLists.map((blockList, i) => {
      const pageNum = i + 1;
      const isRecto = pageNum % 2 === 1; // odd = recto (right-hand page)
      const page = document.createElement("div");
      page.className = "page";
      page.lang = s.language;
      page.dataset.pageIndex = String(pageNum);
      page.style.boxSizing = "border-box";
      page.style.position = "relative";
      page.style.width = trimWidthPx + "px";
      page.style.height = trimHeightPx + "px";
      page.style.paddingTop = (marginTopPx + headerBandPx) + "px";
      page.style.paddingBottom = (marginBottomPx + folioBandPx) + "px";
      page.style.paddingLeft = (isRecto ? marginGutterPx : marginOutsidePx) + "px";
      page.style.paddingRight = (isRecto ? marginOutsidePx : marginGutterPx) + "px";
      page.setAttribute("style", page.getAttribute("style") + ";" + buildTypographyCss(s));
      const pageStyle = document.createElement("style");
      pageStyle.textContent = buildParagraphSpacingCss(s);
      page.appendChild(pageStyle);

      const opensChapter = blockList.some(
        (b) => b.classList && b.classList.contains("chapter-opener")
      );
      const isBlank = blockList.length === 0;

      // Convention, and the reason this isn't just "print it on every page": a page
      // that opens a chapter carries no running head (the sink is the display
      // element there), and a page with nothing on it carries no folio either.
      if (s.runningHeaders && !opensChapter && !isBlank) {
        page.appendChild(
          buildRunningHeader(
            isRecto,
            pageChapterTitles[i],
            shortenForRunningHead(bookTitle),
            marginGutterPx,
            marginOutsidePx,
            (marginTopPx + headerBandPx) * s.runningHeaderDepthFraction
          )
        );
      }

      blockList.forEach((b) => page.appendChild(b));

      if (s.pageNumbers && !isBlank) {
        page.appendChild(
          buildFolio(pageNum, isRecto, s.pageNumberPosition, marginGutterPx, marginOutsidePx, marginBottomPx, folioBandPx)
        );
      }
      return page;
    });

    return pages;
  } finally {
    document.body.removeChild(ruler);
  }
}

// Builds the running-header line (page number + chapter/book title), absolutely
// positioned inside the reserved top-margin band so it doesn't affect the
// content flow that was already paginated against a fixed-height band.
/**
 * A running head has one line in a narrow measure, set in letterspaced caps. EPUB
 * metadata titles are routinely far too long for that ("Burn of the Everflame: The
 * Kindred's Curse Saga, Book Four"), so keep only the main title — the part before
 * a subtitle colon or series comma.
 */
function shortenForRunningHead(title) {
  if (!title) return "";
  let t = String(title).split(":")[0];
  if (t.length > 42) t = t.split(",")[0];
  return t.trim();
}

function buildRunningHeader(isRecto, chapterTitle, bookTitle, gutterPx, outsidePx, centerPx) {
  const header = document.createElement("div");
  header.className = "running-header" + (isRecto ? " recto" : " verso");
  header.style.position = "absolute";
  // `centerPx` is where the head's optical centre should land. Translating by half
  // its own height centres it exactly, without having to predict its line height.
  header.style.top = Math.max(0, centerPx) + "px";
  header.style.transform = "translateY(-50%)";
  header.style.left = (isRecto ? gutterPx : outsidePx) + "px";
  header.style.right = (isRecto ? outsidePx : gutterPx) + "px";
  // Convention: recto (right-hand) pages show the current chapter title,
  // verso (left-hand) pages show the book title.
  header.textContent = (isRecto ? chapterTitle : bookTitle) || "";
  return header;
}

// The folio sits in its own reserved band below the text block, so it never
// collides with the last line however full the page is.
function buildFolio(pageNum, isRecto, position, gutterPx, outsidePx, marginBottomPx, folioBandPx) {
  const folio = document.createElement("div");
  folio.className = "folio";
  if (position === "bottom-outside") {
    folio.classList.add(isRecto ? "outside-recto" : "outside-verso");
  }
  folio.style.position = "absolute";
  folio.style.bottom = Math.max(0, marginBottomPx + folioBandPx / 2 - 12) + "px";
  folio.style.left = (isRecto ? gutterPx : outsidePx) + "px";
  folio.style.right = (isRecto ? outsidePx : gutterPx) + "px";
  folio.textContent = String(pageNum);
  return folio;
}

// --- Drop caps ------------------------------------------------------------
//
// A drop cap has to line up with the text twice over: its cap-top with the first
// line's cap-top, and its baseline with the Nth line's baseline. Both depend on the
// cap height of the *actual glyph in the actual font* — and that varies enough
// between faces (and between an "O", which overshoots, and a flat-topped "T") that
// a single hardcoded ratio visibly collides with the line below. So measure it.

const PT_PER_IN = 72;
const METRICS_FONT_SIZE = 100; // measure at a large size, then work in ratios
const glyphMetricsCache = new Map();

function glyphMetrics(text, fontFamily) {
  const key = text + "|" + fontFamily;
  if (glyphMetricsCache.has(key)) return glyphMetricsCache.get(key);

  const ctx = (glyphMetrics.ctx ||= document.createElement("canvas").getContext("2d"));
  ctx.font = `${METRICS_FONT_SIZE}px ${fontFamily}`;
  const m = ctx.measureText(text);
  const metrics = {
    // Height of the glyph above the baseline (for "H" or "O", the cap height).
    ascent: m.actualBoundingBoxAscent / METRICS_FONT_SIZE,
    descent: m.actualBoundingBoxDescent / METRICS_FONT_SIZE,
    // Where the baseline sits below the top of the font's content box.
    fontAscent: m.fontBoundingBoxAscent / METRICS_FONT_SIZE,
    fontDescent: m.fontBoundingBoxDescent / METRICS_FONT_SIZE,
  };
  glyphMetricsCache.set(key, metrics);
  return metrics;
}

/**
 * Size each chapter's drop cap individually, from that chapter's own initial, and
 * hand the numbers to the stylesheet as custom properties — which `::first-letter`
 * inherits, and which is the only way to vary it per paragraph without generating
 * a stylesheet rule per chapter.
 */
function applyDropCaps(container, s) {
  const bodyPx = (s.fontSizePt / PT_PER_IN) * PX_PER_IN;
  const linePx = bodyPx * s.lineHeight;
  const bodyMetrics = glyphMetrics("H", s.fontFamily);

  container.querySelectorAll("p.chapter-opening").forEach((p) => {
    const initial = firstLetterOf(p.textContent);
    if (!initial) return;
    const capMetrics = glyphMetrics(initial, s.chapterDisplayFontFamily);
    if (!capMetrics.ascent) return; // font unavailable — leave the CSS fallback

    // Distance from the top of the first line's box down to its cap-top: half the
    // leading, then the gap between the content-box top and the cap.
    const flushTopPx = (linePx - bodyPx) / 2 + (bodyMetrics.fontAscent - bodyMetrics.ascent) * bodyPx;

    // A capital aligned flush with the line beside it reads as sitting low, so the
    // top is lifted a little while the bottom stays pinned to the Nth baseline —
    // the letter grows rather than moves. Clamped at the line box top, since the
    // cap can't rise out of its own float box.
    const risePx = Math.max(0, s.dropCapRisePercent / 100) * bodyMetrics.ascent * bodyPx;
    const capTopPx = Math.max(0, flushTopPx - risePx);

    // The cap must reach from its own top down to the Nth line's baseline.
    const spanPx = (s.dropCapLines - 1) * linePx + bodyMetrics.ascent * bodyPx + (flushTopPx - capTopPx);
    let fontSizePx = spanPx / capMetrics.ascent;

    // If the glyph has a descender (a "Q" tail, say), it would hang into the line
    // below the cap's own block — shrink until the whole glyph fits the N lines.
    const totalPx = capTopPx + fontSizePx * (capMetrics.ascent + capMetrics.descent);
    const budgetPx = s.dropCapLines * linePx;
    if (totalPx > budgetPx) {
      fontSizePx *= (budgetPx - capTopPx) / (fontSizePx * (capMetrics.ascent + capMetrics.descent));
    }

    // Float box = padding-top + line-height, pinned to exactly N lines so the text
    // wraps around the cap for N lines and no more. Solve for the padding that puts
    // the *glyph's* cap-top at capTopPx, which is not the same as the padding: the
    // capital is a single line box of height `lineHeightPx`, so it is centred in
    // that box (half-leading) and then sits its own font's ascent-to-cap gap below
    // the content-box top. Skipping those two terms drops the whole cap by several
    // points, which is what made it look like it was sitting low.
    //   padding + (lineHeight - contentHeight)/2 + gapToCap = capTopPx,
    //   padding + lineHeight = budgetPx
    // gives the closed form below.
    const contentPx = (capMetrics.fontAscent + capMetrics.fontDescent) * fontSizePx;
    const gapToCapPx = (capMetrics.fontAscent - capMetrics.ascent) * fontSizePx;
    const paddingTopPx = Math.max(0, 2 * (capTopPx - gapToCapPx) - (budgetPx - contentPx));

    p.style.setProperty("--dropcap-size", fontSizePx.toFixed(2) + "px");
    p.style.setProperty("--dropcap-padding-top", paddingTopPx.toFixed(2) + "px");
    p.style.setProperty("--dropcap-line-height", (budgetPx - paddingTopPx).toFixed(2) + "px");
  });
}

/**
 * The letter the drop cap is sized against. `::first-letter` also renders any
 * opening punctuation in front of it, but that punctuation must not drive the
 * sizing: a quote mark sits above cap height, so measuring `“O` instead of `O`
 * would shrink the capital to fit a mark that's meant to hang above the line.
 */
function firstLetterOf(text) {
  const m = (text || "").trim().match(/[\p{L}\p{N}]/u);
  return m ? m[0] : "";
}

/**
 * Decide how each image should be sized, which needs its intrinsic dimensions and
 * therefore has to wait for a decode. Wide-and-thin images are ornaments (handled
 * by the `.scene-break` CSS); everything else is a figure, capped so it can never
 * exceed the page it has to fit on.
 */
async function sizeImages(container, targetWidthPx, targetHeightPx) {
  const imgs = Array.from(container.querySelectorAll("img"));
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise((resolve) => {
          if (img.complete && img.naturalWidth) return resolve();
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        })
    )
  );

  for (const img of imgs) {
    const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
    const block = img.closest(".scene-break");
    if (block && ratio >= ORNAMENT_ASPECT_RATIO) continue; // ornament: CSS handles it
    if (block) block.classList.remove("scene-break"); // a real figure, mis-tagged at parse time
    img.style.display = "block";
    img.style.margin = "0.8em auto";
    img.style.maxWidth = "100%";
    // Leave room for the caption-free figure to sit on a page by itself.
    img.style.maxHeight = Math.floor(targetHeightPx * 0.92) + "px";
    img.style.width = "auto";
    img.style.height = "auto";
  }
}

function fitsInRuler(ruler, targetHeightPx) {
  return ruler.scrollHeight <= targetHeightPx;
}

function paginateBlocks(blocks, ruler, targetHeightPx, chapterStartNewPage, minLines) {
  const pages = [];
  const pageChapterTitles = [];
  let currentPageBlocks = [];
  let currentChapterTitle = "";
  const preservedChildren = Array.from(ruler.children); // keep <style> tags etc.

  function resetRuler() {
    ruler.innerHTML = "";
    preservedChildren.forEach((c) => ruler.appendChild(c.cloneNode(true)));
  }
  resetRuler();

  function startNewPage() {
    pages.push(currentPageBlocks);
    pageChapterTitles.push(currentChapterTitle);
    currentPageBlocks = [];
    resetRuler();
  }

  const queue = blocks.slice();
  let guard = 0;
  const guardLimit = blocks.length * 20 + 1000; // avoid infinite loops on pathological content

  while (queue.length) {
    if (++guard > guardLimit) {
      console.error("paginateBlocks: guard limit hit, aborting pagination early");
      break;
    }
    const block = queue.shift();
    if (block.nodeType === Node.TEXT_NODE) {
      // Bare text at the top level (rare) — wrap in a paragraph so it's splittable.
      const wrapper = document.createElement("p");
      wrapper.appendChild(block);
      queue.unshift(wrapper);
      continue;
    }

    if (block.classList && block.classList.contains("chapter-opener")) {
      const name = block.querySelector(".chapter-name");
      const num = block.querySelector(".chapter-number");
      currentChapterTitle = (name || num ? (name || num).textContent : "").trim();
    }

    if (chapterStartNewPage && block.classList && block.classList.contains("chapter-break")) {
      if (currentPageBlocks.length > 0) startNewPage();
      continue; // marker only (display:none) — doesn't need to occupy a page
    }

    ruler.appendChild(block);
    if (fitsInRuler(ruler, targetHeightPx)) {
      currentPageBlocks.push(block);
      continue;
    }

    ruler.removeChild(block);
    const { front, remainder } = trySplitBlock(
      block, ruler, targetHeightPx, minLines
    );

    if (front) {
      ruler.appendChild(front);
      currentPageBlocks.push(front);
    }

    if (currentPageBlocks.length === 0 && !front) {
      // Nothing fits even on an empty page (e.g. oversized image) — force it through
      // rather than looping forever.
      currentPageBlocks.push(block);
      startNewPage();
      continue;
    }

    startNewPage();
    if (remainder) {
      queue.unshift(remainder);
    } else if (!front) {
      queue.unshift(block);
    }
  }

  if (currentPageBlocks.length) {
    pages.push(currentPageBlocks);
    pageChapterTitles.push(currentChapterTitle);
  }
  return { pageBlockLists: pages, pageChapterTitles };
}

/**
 * Try to split a block into a "front" part that fits the remaining ruler space
 * and a "remainder" part to carry to the next page. Returns {front: null, remainder: null}
 * for non-splittable (atomic) blocks like images/tables, and for splits that would
 * leave a widow or an orphan — the caller moves the whole block to a fresh page.
 */
function trySplitBlock(block, ruler, targetHeightPx, minLines) {
  if (!SPLITTABLE_TAGS.has(block.tagName)) {
    return { front: null, remainder: null };
  }

  const words = collectWordBoundaries(block);
  if (words.length < 2) {
    return { front: null, remainder: null };
  }

  // Max words that fit the space left on the page.
  const bestFit = searchWords(block, words.length, (candidate) => {
    ruler.appendChild(candidate);
    const ok = fitsInRuler(ruler, targetHeightPx);
    ruler.removeChild(candidate);
    return ok;
  });

  if (bestFit === 0) {
    return { front: null, remainder: null }; // doesn't even fit one word — treat as atomic
  }
  if (bestFit === words.length) {
    // Whole block actually fits now (shouldn't normally happen since caller already
    // tried appending it whole, but guard against it).
    return { front: cloneWithWordRange(block, 0, words.length), remainder: null };
  }

  const linePx = lineHeightOf(block, ruler);
  const totalLines = measureLines(block, ruler, linePx);
  const availableLines = measureLines(cloneWithWordRange(block, 0, bestFit), ruler, linePx);

  // Widow/orphan control. A paragraph must never leave a single line stranded on
  // either side of a page break, so the split has to keep at least `minLines` lines
  // on each page. If the paragraph is too short to give that to both, don't split it
  // at all — push it whole onto the next page.
  if (totalLines < minLines * 2) {
    return { front: null, remainder: null };
  }
  const frontLines = Math.min(availableLines, totalLines - minLines);
  if (frontLines < minLines) {
    return { front: null, remainder: null };
  }

  // Re-fit to that line budget rather than to the raw remaining height.
  const budgetPx = frontLines * linePx + linePx * 0.25; // tolerance for rounding
  const splitAt =
    frontLines === availableLines
      ? bestFit
      : searchWords(block, bestFit, (candidate) => measureHeight(candidate, ruler) <= budgetPx);

  if (splitAt === 0 || splitAt >= words.length) {
    return { front: null, remainder: null };
  }

  const front = cloneWithWordRange(block, 0, splitAt);
  const remainder = cloneWithWordRange(block, splitAt, words.length);
  return { front, remainder };
}

// Binary search for the largest word count in [0, maxWords] that `fits` accepts.
function searchWords(block, maxWords, fits) {
  let lo = 0;
  let hi = maxWords;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(cloneWithWordRange(block, 0, mid))) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// Height of an element rendered at the ruler's measure, independent of whatever
// else the ruler currently holds.
function measureHeight(el, ruler) {
  ruler.appendChild(el);
  const h = el.offsetHeight;
  ruler.removeChild(el);
  return h;
}

function measureLines(el, ruler, linePx) {
  if (!linePx) return 1;
  return Math.max(1, Math.round(measureHeight(el, ruler) / linePx));
}

// The block's own line height — headings and body text differ, and using the body's
// value for a heading would miscount its lines.
//
// Cached by tag + class, because that's what the line height actually depends on
// once the EPUB's own CSS is stripped, and this is called on every page break of a
// thousand-page book.
const lineHeightCache = new Map();

function lineHeightOf(block, ruler) {
  const key = block.tagName + "|" + block.className;
  if (lineHeightCache.has(key)) return lineHeightCache.get(key);

  const probe = block.cloneNode(false);
  probe.textContent = "Hg";
  ruler.appendChild(probe);
  const h = probe.offsetHeight || 0;
  ruler.removeChild(probe);

  lineHeightCache.set(key, h);
  return h;
}

// Returns an array of word "tokens" in document order for a block, used only to
// count how many words to keep — actual splitting re-walks by word count.
function collectWordBoundaries(block) {
  const text = block.textContent || "";
  const matches = text.match(/\S+/g);
  return matches || [];
}

// Clone `block`, keeping only the [startWord, endWord) slice of its words, walking
// text nodes in document order and preserving surrounding inline element structure.
function cloneWithWordRange(block, startWord, endWord) {
  const clone = block.cloneNode(true);
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  let wordIndex = 0;
  const toRemove = [];
  let node;
  while ((node = walker.nextNode())) {
    const parts = node.textContent.split(/(\s+)/); // keep separators
    let rebuilt = "";
    for (const part of parts) {
      if (/^\s+$/.test(part) || part === "") {
        rebuilt += part;
        continue;
      }
      // part is a word
      if (wordIndex >= startWord && wordIndex < endWord) {
        rebuilt += part;
      }
      wordIndex++;
    }
    if (rebuilt.trim() === "") {
      toRemove.push(node);
    } else {
      node.textContent = rebuilt;
    }
  }
  toRemove.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
  pruneEmptyInlineElements(clone);
  return clone;
}

function pruneEmptyInlineElements(root) {
  const all = Array.from(root.querySelectorAll("*"));
  for (const el of all) {
    if (el.tagName === "IMG" || el.tagName === "BR") continue;
    if (!el.textContent || el.textContent.trim() === "") {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }
}

if (typeof window !== "undefined") {
  window.paginateContent = paginateContent;
}
