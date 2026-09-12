// Orchestration: wires the settings UI to the epub -> reflow -> paginate -> impose -> render pipeline.

const state = {
  epub: null, // { title, author, flowHtml }
  pages: null, // paginated page divs
};

const els = {};
window.addEventListener("DOMContentLoaded", () => {
  [
    "fileInput", "bookInfo",
    "paperSize", "paperSizeInfo", "signatureSheetCount", "signatureSheetCountInfo",
    "marginIn",
    "fontFamily", "fontSizePt", "lineHeight", "paragraphSpacingEm", "justify",
    "duplexFlipEdge",
    "chapterStartNewPage", "chapterTitleOffsetPercent", "chapterTitleFontFamily",
    "generateBtn", "printBtn", "status", "preview", "pageSizeStyle",
  ].forEach((id) => (els[id] = document.getElementById(id)));

  els.fileInput.addEventListener("change", onFileChosen);
  els.generateBtn.addEventListener("click", onGenerate);
  els.printBtn.addEventListener("click", () => window.print());
  els.paperSize.addEventListener("change", updatePaperSizeInfo);
  els.signatureSheetCount.addEventListener("input", updateSignatureInfo);

  updatePaperSizeInfo();
  updateSignatureInfo();
});

function updatePaperSizeInfo() {
  els.paperSizeInfo.textContent = `Folds into ${getTrimSizeLabel(els.paperSize.value)} booklet pages.`;
}

function updateSignatureInfo() {
  const sheets = parseInt(els.signatureSheetCount.value, 10) || 1;
  els.signatureSheetCountInfo.textContent = `= ${sheets * 4} pages per signature (each sheet, folded once, holds 4 pages: front and back, each side showing 2 pages)`;
}

function readSettingsFromForm() {
  return {
    paperSize: els.paperSize.value,
    signatureSheetCount: parseInt(els.signatureSheetCount.value, 10) || DEFAULT_SETTINGS.signatureSheetCount,
    marginIn: parseFloat(els.marginIn.value) || DEFAULT_SETTINGS.marginIn,
    fontFamily: els.fontFamily.value || DEFAULT_SETTINGS.fontFamily,
    fontSizePt: parseFloat(els.fontSizePt.value) || DEFAULT_SETTINGS.fontSizePt,
    lineHeight: parseFloat(els.lineHeight.value) || DEFAULT_SETTINGS.lineHeight,
    paragraphSpacingEm: parseFloat(els.paragraphSpacingEm.value) || 0,
    justify: els.justify.checked,
    duplexFlipEdge: els.duplexFlipEdge.value,
    chapterStartNewPage: els.chapterStartNewPage.checked,
    chapterTitleOffsetPercent: parseFloat(els.chapterTitleOffsetPercent.value) || 0,
    chapterTitleFontFamily: els.chapterTitleFontFamily.value || DEFAULT_SETTINGS.chapterTitleFontFamily,
  };
}

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("error", !!isError);
}

async function onFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  setStatus("Parsing EPUB…");
  els.generateBtn.disabled = true;
  try {
    state.epub = await parseEpub(file);
    els.bookInfo.textContent = `${state.epub.title}${state.epub.author ? " — " + state.epub.author : ""}`;
    els.generateBtn.disabled = false;
    setStatus("EPUB parsed. Adjust settings and click Generate.");
  } catch (err) {
    console.error(err);
    setStatus(`Failed to parse EPUB: ${err.message}`, true);
  }
}

async function onGenerate() {
  if (!state.epub) return;
  els.generateBtn.disabled = true;
  els.printBtn.disabled = true;
  els.preview.innerHTML = "";
  setStatus("Paginating…");
  try {
    const settings = readSettingsFromForm();

    applyPageSizeCss(settings.paperSize);

    const pages = await paginateContent(state.epub.flowHtml, settings);
    state.pages = pages;
    setStatus(`Paginated into ${pages.length} page(s). Imposing…`);

    const { book, sheetsContainer } = renderImposedSheets(pages, settings);
    els.preview.appendChild(sheetsContainer);

    const sheetCount = book.signatures.reduce((sum, sig) => sum + sig.sheets.length, 0);
    setStatus(
      `Done: ${pages.length} content page(s), ${book.blanksAdded} blank padding page(s), ` +
      `${book.signatures.length} signature(s), ${sheetCount} sheet(s) total. ` +
      `Duplex flip edge: ${settings.duplexFlipEdge}.`
    );
    els.printBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(`Failed to generate: ${err.message}`, true);
  } finally {
    els.generateBtn.disabled = false;
  }
}

function applyPageSizeCss(paperSize) {
  const size = paperSize === "a4" ? "A4" : "letter";
  // Sheets are laid out landscape (two half-pages side by side, folded down the middle).
  els.pageSizeStyle.textContent = `@page { size: ${size} landscape; margin: 0; }`;
}
