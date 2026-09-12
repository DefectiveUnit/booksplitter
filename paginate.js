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
  // Content box = trim size minus the gutter+outside margins (width) and
  // top+bottom margins plus any reserved running-header band (height).
  const targetWidthPx = trimWidthPx - marginGutterPx - marginOutsidePx;
  const targetHeightPx = trimHeightPx - marginTopPx - marginBottomPx - headerBandPx;

  const ruler = document.createElement("div");
  ruler.style.position = "fixed";
  ruler.style.left = "-99999px";
  ruler.style.top = "0";
  ruler.style.width = targetWidthPx + "px";
  ruler.style.height = "auto";
  ruler.style.visibility = "hidden";
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

    // Push each chapter's opening heading down the page by the configured
    // amount before measuring, so pagination accounts for the extra space.
    const titleOffsetPx = Math.round((targetHeightPx * s.chapterTitleOffsetPercent) / 100);
    container.querySelectorAll(".chapter-title").forEach((el) => {
      el.style.marginTop = titleOffsetPx + "px";
    });

    const blocks = Array.from(container.childNodes).filter(
      (n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim())
    );

    const { pageBlockLists, pageChapterTitles } = paginateBlocks(
      blocks, ruler, targetHeightPx, s.chapterStartNewPage
    );

    const pages = pageBlockLists.map((blockList, i) => {
      const pageNum = i + 1;
      const isRecto = pageNum % 2 === 1; // odd = recto (right-hand page)
      const page = document.createElement("div");
      page.className = "page";
      page.dataset.pageIndex = String(pageNum);
      page.style.boxSizing = "border-box";
      page.style.position = "relative";
      page.style.width = trimWidthPx + "px";
      page.style.height = trimHeightPx + "px";
      page.style.paddingTop = (marginTopPx + headerBandPx) + "px";
      page.style.paddingBottom = marginBottomPx + "px";
      page.style.paddingLeft = (isRecto ? marginGutterPx : marginOutsidePx) + "px";
      page.style.paddingRight = (isRecto ? marginOutsidePx : marginGutterPx) + "px";
      page.setAttribute("style", page.getAttribute("style") + ";" + buildTypographyCss(s));
      const pageStyle = document.createElement("style");
      pageStyle.textContent = buildParagraphSpacingCss(s);
      page.appendChild(pageStyle);

      if (s.runningHeaders) {
        page.appendChild(buildRunningHeader(pageNum, isRecto, pageChapterTitles[i], bookTitle, marginGutterPx, marginOutsidePx, headerBandPx));
      }

      blockList.forEach((b) => page.appendChild(b));
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
function buildRunningHeader(pageNum, isRecto, chapterTitle, bookTitle, gutterPx, outsidePx, headerBandPx) {
  const header = document.createElement("div");
  header.className = "running-header" + (isRecto ? " recto" : " verso");
  header.style.position = "absolute";
  header.style.top = Math.max(0, headerBandPx - 16) + "px";
  header.style.left = (isRecto ? gutterPx : outsidePx) + "px";
  header.style.right = (isRecto ? outsidePx : gutterPx) + "px";

  const titleSpan = document.createElement("span");
  titleSpan.className = "running-header-title";
  // Convention: recto (right-hand) pages show the current chapter title,
  // verso (left-hand) pages show the book title.
  titleSpan.textContent = (isRecto ? chapterTitle : bookTitle) || "";

  const numSpan = document.createElement("span");
  numSpan.className = "running-header-num";
  numSpan.textContent = String(pageNum);

  header.appendChild(titleSpan);
  header.appendChild(numSpan);
  return header;
}

function fitsInRuler(ruler, targetHeightPx) {
  return ruler.scrollHeight <= targetHeightPx;
}

function paginateBlocks(blocks, ruler, targetHeightPx, chapterStartNewPage) {
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

    if (block.classList && block.classList.contains("chapter-title")) {
      currentChapterTitle = (block.textContent || "").trim();
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
    const { front, remainder } = trySplitBlock(block, ruler, targetHeightPx, currentPageBlocks.length === 0);

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
 * for non-splittable (atomic) blocks like images/tables — caller places the whole
 * block on a fresh page instead.
 */
function trySplitBlock(block, ruler, targetHeightPx, pageIsEmpty) {
  if (!SPLITTABLE_TAGS.has(block.tagName)) {
    return { front: null, remainder: null };
  }

  const words = collectWordBoundaries(block);
  if (words.length < 2) {
    return { front: null, remainder: null };
  }

  // Binary search the max word count that still fits.
  let lo = 0; // 0 words fits (trivially, nothing added yet)
  let hi = words.length;
  let bestFit = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = cloneWithWordRange(block, 0, mid);
    ruler.appendChild(candidate);
    const ok = fitsInRuler(ruler, targetHeightPx);
    ruler.removeChild(candidate);
    if (ok) {
      bestFit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestFit === 0) {
    return { front: null, remainder: null }; // doesn't even fit one word — treat as atomic
  }
  if (bestFit === words.length) {
    // Whole block actually fits now (shouldn't normally happen since caller already
    // tried appending it whole, but guard against it).
    return { front: cloneWithWordRange(block, 0, words.length), remainder: null };
  }

  const front = cloneWithWordRange(block, 0, bestFit);
  const remainder = cloneWithWordRange(block, bestFit, words.length);
  return { front, remainder };
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
