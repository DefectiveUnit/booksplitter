// EPUB parsing: unzip, resolve OPF/spine, produce ordered flow HTML + asset URLs.
// Depends on window.JSZip (vendor/jszip.min.js) and browser DOMParser.

const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * @param {File|Blob} file the .epub file from an <input type="file">
 * @returns {Promise<{title:string, author:string, flowHtml:string,
 *   chapters:{idref:string, html:string, number:string, name:string}[]}>}
 *   `chapters` keeps the book addressable per-spine-item (lab.html paginates a
 *   slice of it); `flowHtml` is every chapter concatenated, for the real app.
 */
async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file);

  const containerXml = await readZipText(zip, "META-INF/container.xml");
  if (!containerXml) {
    throw new Error("Not a valid EPUB: missing META-INF/container.xml");
  }
  const containerDoc = new DOMParser().parseFromString(containerXml, "application/xml");
  const rootfileEl = containerDoc.querySelector("rootfile");
  const opfPath = rootfileEl && rootfileEl.getAttribute("full-path");
  if (!opfPath) {
    throw new Error("Not a valid EPUB: container.xml has no rootfile");
  }

  const opfXml = await readZipText(zip, opfPath);
  if (!opfXml) {
    throw new Error(`Not a valid EPUB: missing OPF at ${opfPath}`);
  }
  const opfDoc = new DOMParser().parseFromString(opfXml, "application/xml");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const title = textOf(opfDoc, "metadata title") || file.name;
  const author = textOf(opfDoc, "metadata creator") || "";
  // Feeds the `lang` attribute on every page box, which is what enables Chrome's
  // hyphenation dictionary. Normalised to a bare tag ("en-GB" -> "en-GB", "EN" -> "en").
  const language = (textOf(opfDoc, "metadata language") || "en").trim().toLowerCase() || "en";

  const manifest = {};
  opfDoc.querySelectorAll("manifest > item").forEach((item) => {
    manifest[item.getAttribute("id")] = {
      href: item.getAttribute("href"),
      mediaType: item.getAttribute("media-type") || "",
    };
  });

  const spineIdrefs = Array.from(opfDoc.querySelectorAll("spine > itemref")).map((el) =>
    el.getAttribute("idref")
  );
  if (spineIdrefs.length === 0) {
    throw new Error("Not a valid EPUB: spine has no items");
  }

  // Resolve every image reference in the zip up front to Blob URLs, keyed by
  // the zip-relative path, so we can rewrite <img src> in each chapter.
  const assetUrlCache = new Map();
  async function resolveAssetUrl(zipRelativePath) {
    if (assetUrlCache.has(zipRelativePath)) return assetUrlCache.get(zipRelativePath);
    const entry = zip.file(zipRelativePath);
    if (!entry) return null;
    const blob = await entry.async("blob");
    const url = URL.createObjectURL(blob);
    assetUrlCache.set(zipRelativePath, url);
    return url;
  }

  const chapters = [];
  for (const idref of spineIdrefs) {
    const item = manifest[idref];
    if (!item) continue; // spine references a manifest id that doesn't exist; skip
    const chapterPath = resolvePath(opfDir, item.href);
    const chapterXml = await readZipText(zip, chapterPath);
    if (!chapterXml) continue;

    let chapterDoc = new DOMParser().parseFromString(chapterXml, "application/xhtml+xml");
    if (chapterDoc.querySelector("parsererror")) {
      // Many real-world EPUBs contain HTML entities (&nbsp; etc.) or other
      // not-quite-XML markup that fails strict XHTML parsing — fall back to
      // lenient HTML parsing rather than dropping the chapter.
      chapterDoc = new DOMParser().parseFromString(chapterXml, "text/html");
    }
    const body = chapterDoc.querySelector("body");
    if (!body) continue;

    const chapterDir = chapterPath.includes("/")
      ? chapterPath.slice(0, chapterPath.lastIndexOf("/") + 1)
      : "";

    const imgs = Array.from(body.querySelectorAll("img, image"));
    for (const img of imgs) {
      const isSvgImage = img.tagName.toLowerCase() === "image";
      const src =
        img.getAttribute("src") ||
        img.getAttribute("xlink:href") ||
        img.getAttributeNS(XLINK_NS, "href") ||
        img.getAttribute("href");
      if (!src || /^(https?:|data:)/.test(src)) continue;
      const assetPath = resolvePath(chapterDir, src);
      const url = await resolveAssetUrl(assetPath);
      if (!url) continue;
      if (isSvgImage) {
        // An SVG <image> takes href/xlink:href — setting `src` on it does nothing,
        // which is why cover pages built as <svg><image xlink:href="cover.jpeg">
        // came through as a broken image. Set both: xlink for older readers' markup,
        // plain href for SVG 2.
        img.setAttributeNS(XLINK_NS, "xlink:href", url);
        img.setAttribute("href", url);
      } else {
        img.setAttribute("src", url);
      }
    }

    stripRetailerJunk(body);
    // Order matters: the opener is extracted while its wrapper divs are still
    // intact (that nesting is what identifies it), and only then is the rest of
    // the container scaffolding flattened.
    const opener = extractChapterOpener(body);
    unwrapBlockContainers(body);
    markSemantics(body, !!(opener && opener.isChapter));

    const openerHtml = opener ? buildOpenerHtml(opener) : "";

    chapters.push({
      idref,
      number: opener ? opener.number : "",
      name: opener ? opener.name : "",
      html:
        `<div class="chapter-break" data-spine-idref="${idref}"></div>\n` +
        openerHtml +
        body.innerHTML,
    });
  }

  return {
    title,
    author,
    language,
    chapters,
    flowHtml: chapters.map((c) => c.html).join("\n"),
  };
}

// Pirate-site EPUB rips append a promo link to the end of every chapter. It's not
// part of the book, and left in it lands as a stray line on ~87 pages.
function stripRetailerJunk(body) {
  Array.from(body.querySelectorAll("a[href]")).forEach((a) => {
    if (!/oceanofpdf|z-lib|libgen|anna-?archive/i.test(a.getAttribute("href") || "")) return;
    // Remove the smallest enclosing block that exists only to hold this link.
    let node = a;
    while (
      node.parentElement &&
      node.parentElement !== body &&
      node.parentElement.textContent.trim() === a.textContent.trim()
    ) {
      node = node.parentElement;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
  });
}

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "table", "section", "article",
  "figure", "header", "footer", "pre", "hr",
]);
const CONTAINER_SELECTOR = "div, section, article, main, header, footer, figure";

/**
 * Flatten wrapper elements so that every block of prose becomes a top-level child
 * of the chapter.
 *
 * Pagination walks the flow's top-level children and can only split the tags it
 * recognises as text-bearing, so anything left nested inside a wrapper is one
 * indivisible block. That's how this book's table of contents — 87 paragraphs
 * inside a single <div> — ended up as one block far taller than a page, placed
 * whole and then silently clipped at "Chapter 33".
 *
 * Wrappers holding no block-level children are left alone: those are meaningful
 * units (the <div> around a scene-break ornament), not scaffolding.
 */
function unwrapBlockContainers(body) {
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const el of Array.from(body.querySelectorAll(CONTAINER_SELECTOR))) {
      if (!el.parentNode) continue; // already removed as part of an outer unwrap
      const hasBlockChild = Array.from(el.children).some((c) =>
        BLOCK_TAGS.has(c.tagName.toLowerCase())
      );
      if (!hasBlockChild) continue;
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.parentNode.removeChild(el);
      changed = true;
    }
    if (!changed) break;
  }
}

const ORDINAL_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|" +
  "sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";

// Does this heading read as a chapter *number* ("7", "VII", "Chapter Seven") rather
// than a chapter *name* ("Luther", "The Long Road Home")?
function looksLikeChapterNumber(text) {
  const t = text.trim().replace(/^chapter\s+/i, "");
  if (!t) return false;
  if (/^\d+$/.test(t)) return true;
  if (/^[ivxlcdm]+$/i.test(t)) return true;
  return new RegExp(`^(${ORDINAL_WORDS})([\\s-]+(${ORDINAL_WORDS}))*$`, "i").test(t);
}

/**
 * Pull the chapter's number/name out of the source markup and delete the original
 * heading block from `body`, so it can be re-typeset from scratch.
 *
 * Real EPUBs nest the heading arbitrarily deep — this book wraps it as
 * `<div><div><h1>7</h1><h2>LUTHER</h2></div></div>`, which is why a
 * `:scope > h1` lookup found nothing. So: take the first heading in document
 * order, climb to the outermost ancestor that still contains *only* headings,
 * and treat that whole subtree as the opener.
 */
function extractChapterOpener(body) {
  const firstHeading = body.querySelector("h1, h2, h3, h4, h5, h6");
  if (!firstHeading) return null;

  // Bail out if there's real prose before the heading — then it isn't an opener.
  const precedingText = textBefore(body, firstHeading);
  if (precedingText.length > 40) return null;

  let block = firstHeading;
  while (
    block.parentElement &&
    block.parentElement !== body &&
    containsOnlyHeadings(block.parentElement)
  ) {
    block = block.parentElement;
  }

  const headings = block.matches("h1, h2, h3, h4, h5, h6")
    ? [block]
    : Array.from(block.querySelectorAll("h1, h2, h3, h4, h5, h6"));

  let number = "";
  let name = "";
  for (const h of headings) {
    const text = squashWhitespace(h.textContent);
    if (!text) continue;
    if (!number && looksLikeChapterNumber(text)) number = text.replace(/^chapter\s+/i, "");
    else if (!name) name = text;
  }
  // A single heading like "Chapter 7: Luther" — split it.
  if (number && !name) {
    const m = squashWhitespace(headings[0] && headings[0].textContent).match(
      /^(?:chapter\s+)?\S+\s*[:.—-]\s*(.+)$/i
    );
    if (m) name = m[1];
  }
  if (!number && !name) return null;

  if (block.parentNode) block.parentNode.removeChild(block);
  return { number, name, isChapter: !!number || CHAPTER_LIKE_NAMES.test(name) };
}

// Unnumbered sections that are still real chapters and deserve the full opener —
// the sink, the drop cap. Everything else unnumbered (Contents, Copyright,
// Acknowledgements, About the Author) is front or back matter, and giving it a
// drop cap and 40% of a blank page makes the book look broken rather than deluxe.
const CHAPTER_LIKE_NAMES = /^(prologue|epilogue|interlude|prelude)\b/i;

function containsOnlyHeadings(el) {
  const headings = el.querySelectorAll("h1, h2, h3, h4, h5, h6");
  if (headings.length === 0) return false;
  let headingText = "";
  headings.forEach((h) => (headingText += squashWhitespace(h.textContent)));
  return squashWhitespace(el.textContent) === headingText;
}

function textBefore(body, target) {
  let text = "";
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (target.contains(node)) break;
    text += node.textContent;
  }
  return text.trim();
}

function squashWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function buildOpenerHtml({ number, name, isChapter }) {
  if (!isChapter) {
    // Front/back matter: a plain centred heading, set in the display face but with
    // none of the chapter-opener machinery.
    return `<h2 class="section-title">${escapeHtml(name || number)}</h2>`;
  }
  const parts = ['<header class="chapter-opener">'];
  parts.push('<div class="chapter-opener-inner">');
  if (number) {
    parts.push('<div class="chapter-label"></div>');
    parts.push(`<div class="chapter-number">${escapeHtml(number)}</div>`);
  }
  if (number && name) parts.push('<div class="chapter-rule"></div>');
  if (name) parts.push(`<h2 class="chapter-name">${escapeHtml(name)}</h2>`);
  parts.push("</div></header>");
  return parts.join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * Tag the structural roles the typography cares about, since the source class
 * names (`class_s9w`, `class_s9y`, …) are obfuscated and get stripped anyway:
 *  - the chapter's first paragraph (takes the drop cap, no indent)
 *  - scene-break ornaments (a block whose only content is a small decorative image)
 */
/**
 * Unwrap the tiny inline spans EPUBs put around a chapter's opening character(s)
 * to build their own drop cap.
 *
 * This matters more than it looks. `::first-letter` includes any punctuation that
 * precedes the first letter — so a chapter opening `“Oh, Dessies…` should drop-cap
 * `“O` together. But it only reaches across a contiguous text run: when the source
 * marks up the quote and the letter as two separate spans
 * (`<span>“</span><span>O</span>h, Dessies…`), the selector stops at the element
 * boundary and drop-caps a lone, floating quotation mark. Flattening the prefix to
 * plain text puts `“O` back in one run, where `::first-letter` can take both.
 */
function flattenOpeningInitial(p) {
  const MAX_PREFIX = 3; // an initial plus its punctuation — never a whole word
  const INLINE = /^(SPAN|B|I|EM|STRONG|FONT)$/;

  for (let guard = 0; guard < 8; guard++) {
    // Skip past whatever plain text already sits at the start of the paragraph.
    let leadingLength = 0;
    let node = p.firstChild;
    while (node && node.nodeType === Node.TEXT_NODE) {
      leadingLength += node.textContent.length;
      node = node.nextSibling;
    }
    if (leadingLength >= MAX_PREFIX) break; // the initial is already in plain text
    // tagName is only upper-cased in HTML documents; chapters usually parse as
    // XHTML, where it stays exactly as authored. Normalise before matching.
    if (!node || node.nodeType !== Node.ELEMENT_NODE) break;
    if (!INLINE.test(node.tagName.toUpperCase())) break;
    // Only unwrap a span that holds an initial's worth of text. Stop at the first
    // substantial one — that's real emphasis (an italicised opening clause), and
    // unwrapping it would silently drop the styling from the sentence.
    if (squashWhitespace(node.textContent).length > MAX_PREFIX) break;

    while (node.firstChild) p.insertBefore(node.firstChild, node);
    p.removeChild(node);
    p.normalize(); // merge the freed text into one contiguous run
  }
  p.normalize();
}

/**
 * Wrap the chapter's initial in its own element, so the drop cap can be exactly
 * the letter.
 *
 * `::first-letter` can't express this: the spec has it swallow the punctuation on
 * *both* sides of the initial, so a chapter opening "I'd walked…" drop-caps "I’"
 * — a three-line-high apostrophe — and no amount of CSS on the pseudo-element
 * changes what it selects. An explicit span is the only way to draw the boundary.
 *
 * Punctuation *before* the letter is kept inside the cap: a chapter opening on
 * dialogue reads as "“O", with the quote hanging at cap size, which is the
 * conventional setting. Punctuation after it is left in the body text.
 */
function wrapDropCapInitial(p) {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) return;

  // Leading whitespace, then any opening punctuation, then the initial itself.
  const m = node.textContent.match(/^(\s*)([^\p{L}\p{N}\s]*)([\p{L}\p{N}])/u);
  if (!m) return;
  const [matched, leadingSpace, openingPunctuation, initial] = m;

  const span = p.ownerDocument.createElement("span");
  span.className = "dropcap";
  span.textContent = openingPunctuation + initial;

  const frag = p.ownerDocument.createDocumentFragment();
  if (leadingSpace) frag.appendChild(p.ownerDocument.createTextNode(leadingSpace));
  frag.appendChild(span);
  const rest = node.textContent.slice(matched.length);
  if (rest) frag.appendChild(p.ownerDocument.createTextNode(rest));

  node.parentNode.replaceChild(frag, node);
}

function markSemantics(body, isChapter) {
  const firstPara = body.querySelector("p");
  if (isChapter && firstPara && squashWhitespace(firstPara.textContent)) {
    firstPara.classList.add("chapter-opening");
    flattenOpeningInitial(firstPara);
    wrapDropCapInitial(firstPara);
  }

  Array.from(body.querySelectorAll("img")).forEach((img) => {
    let block = img;
    while (
      block.parentElement &&
      block.parentElement !== body &&
      !squashWhitespace(block.parentElement.textContent)
    ) {
      block = block.parentElement;
    }
    if (squashWhitespace(block.textContent)) return; // image sits inside prose
    // The EPUB's own CSS stretched these to width:100%; at a 5x8 trim that turns a
    // hairline ornament into a full-bleed band. Mark it so the print CSS can size it.
    block.classList.add("scene-break");
    img.removeAttribute("width");
    img.removeAttribute("height");
  });
}

async function readZipText(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async("text");
}

function textOf(doc, selector) {
  const el = doc.querySelector(selector);
  return el ? el.textContent.trim() : "";
}

// Resolve a relative href against a directory path, both zip-internal (POSIX-style).
function resolvePath(dir, href) {
  if (!href) return href;
  const cleanHref = href.split("#")[0];
  const combined = dir + cleanHref;
  const parts = combined.split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

if (typeof window !== "undefined") {
  window.parseEpub = parseEpub;
}
