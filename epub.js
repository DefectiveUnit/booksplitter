// EPUB parsing: unzip, resolve OPF/spine, produce ordered flow HTML + asset URLs.
// Depends on window.JSZip (vendor/jszip.min.js) and browser DOMParser.

/**
 * @param {File} file the .epub file from an <input type="file">
 * @returns {Promise<{title:string, author:string, flowHtml:string}>}
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

  const chapterHtmlParts = [];
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
      const srcAttr = img.tagName.toLowerCase() === "image" ? "xlink:href" : "src";
      const src = img.getAttribute(srcAttr) || img.getAttribute("src") || img.getAttribute("href");
      if (!src || /^(https?:|data:)/.test(src)) continue;
      const assetPath = resolvePath(chapterDir, src);
      const url = await resolveAssetUrl(assetPath);
      if (url) img.setAttribute("src", url);
    }

    // Tag the chapter's opening heading (if it has one) so it can get its own
    // font/vertical position when the chapter starts a fresh page.
    const firstHeading = body.querySelector(":scope > h1, :scope > h2, :scope > h3");
    if (firstHeading) firstHeading.classList.add("chapter-title");

    chapterHtmlParts.push(`<div class="chapter-break" data-spine-idref="${idref}"></div>`);
    chapterHtmlParts.push(body.innerHTML);
  }

  return { title, author, flowHtml: chapterHtmlParts.join("\n") };
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
