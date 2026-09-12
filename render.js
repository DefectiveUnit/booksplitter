// Builds the imposed, print-ready sheet DOM from paginated page divs + impose.js math.
// Reuses (moves) the actual page-content DOM nodes so preview and print share one
// source of truth — no second rendering pipeline.

/**
 * @param {HTMLDivElement[]} pages output of paginateContent()
 * @param {object} settings see reflow.js DEFAULT_SETTINGS
 * @returns {{book: ReturnType<typeof imposeBook>, sheetsContainer: HTMLDivElement}}
 */
function renderImposedSheets(pages, settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const trim = getTrimSizeIn(s.paperSize);
  const portrait = PAPER_SIZES_IN[s.paperSize] || PAPER_SIZES_IN.letter;
  // Sheets print in landscape (two half-pages side by side, folded down the middle).
  const paper = { width: portrait.height, height: portrait.width };

  const book = imposeBook(pages.length, s.signatureSheetCount);

  const container = document.createElement("div");
  container.className = "sheets-container";

  const pageByNumber = new Map();
  pages.forEach((p, i) => pageByNumber.set(i + 1, p));

  function slotFor(pageNum) {
    const slot = document.createElement("div");
    slot.className = "slot";
    slot.style.width = trim.width + "in";
    slot.style.height = trim.height + "in";
    if (pageNum === 0) {
      slot.classList.add("blank");
    } else {
      const page = pageByNumber.get(pageNum);
      if (page) {
        slot.appendChild(page); // move, not clone
        page.classList.add("placed");
      }
    }
    return slot;
  }

  book.signatures.forEach((sig) => {
    const sigHeader = document.createElement("div");
    sigHeader.className = "signature-header no-print";
    sigHeader.textContent = `Signature ${sig.index + 1} of ${book.signatures.length} — ${sig.sheets.length} sheet(s), pages ${sig.pageOffset + 1}–${Math.min(sig.pageOffset + sig.pageCount, pages.length)}`;
    container.appendChild(sigHeader);

    sig.sheets.forEach((sheet, sheetIdx) => {
      ["front", "back"].forEach((side) => {
        const sheetDiv = document.createElement("div");
        sheetDiv.className = `sheet ${side}`;
        sheetDiv.dataset.signature = String(sig.index + 1);
        sheetDiv.dataset.sheet = String(sheetIdx + 1);
        sheetDiv.style.width = paper.width + "in";
        sheetDiv.style.height = paper.height + "in";

        const label = document.createElement("div");
        label.className = "sheet-label no-print";
        label.textContent = `Sig ${sig.index + 1} · Sheet ${sheetIdx + 1} · ${side}`;
        sheetDiv.appendChild(label);

        const sideRow = document.createElement("div");
        sideRow.className = "sheet-side-row";
        sideRow.appendChild(slotFor(sheet[side].left));
        sideRow.appendChild(slotFor(sheet[side].right));
        sheetDiv.appendChild(sideRow);

        container.appendChild(sheetDiv);
      });
    });
  });

  return { book, sheetsContainer: container };
}

if (typeof window !== "undefined") {
  window.renderImposedSheets = renderImposedSheets;
}
