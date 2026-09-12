// Pure imposition math — no DOM. Runnable under `node impose.js` for self-checks
// and included directly via <script> in the browser (attaches to window if present).

/**
 * Compute per-sheet front/back left/right page numbers for a single signature.
 * @param {number} P total pages in this signature (must be a multiple of 4)
 * @returns {Array<{front:{left:number,right:number}, back:{left:number,right:number}}>}
 *   sheets[0] is the outermost sheet (wraps the whole signature), sheets[S-1] the innermost.
 *   Page numbers are 1-indexed, local to the signature (add the signature's page offset
 *   to get global book page numbers).
 */
function imposeSignature(P) {
  if (!Number.isInteger(P) || P <= 0 || P % 4 !== 0) {
    throw new Error(`imposeSignature: P must be a positive multiple of 4, got ${P}`);
  }
  const S = P / 4;
  const sheets = [];
  for (let k = 1; k <= S; k++) {
    sheets.push({
      front: { left: P - 2 * k + 2, right: 2 * k - 1 },
      back: { left: 2 * k, right: P - 2 * k + 1 },
    });
  }
  return sheets;
}

/**
 * Split a book's total page count into padded signatures and impose each one.
 * @param {number} totalPages actual content page count (before padding)
 * @param {number} signatureSheetCount sheets per signature (S)
 * @returns {{
 *   paddedTotal: number,
 *   blanksAdded: number,
 *   signatures: Array<{
 *     index: number,
 *     pageOffset: number,
 *     pageCount: number,
 *     sheets: Array<{front:{left:number,right:number}, back:{left:number,right:number}}>
 *   }>
 * }}
 *   Sheet page numbers inside each signature's `sheets` are GLOBAL 1-indexed book page
 *   numbers (local imposition result + that signature's pageOffset), with 0 meaning
 *   "blank page" (only possible on the trailing padded pages of the last signature).
 */
function imposeBook(totalPages, signatureSheetCount) {
  if (!Number.isInteger(totalPages) || totalPages <= 0) {
    throw new Error(`imposeBook: totalPages must be a positive integer, got ${totalPages}`);
  }
  if (!Number.isInteger(signatureSheetCount) || signatureSheetCount <= 0) {
    throw new Error(
      `imposeBook: signatureSheetCount must be a positive integer, got ${signatureSheetCount}`
    );
  }

  const P = 4 * signatureSheetCount;
  const paddedTotal = Math.ceil(totalPages / P) * P;
  const blanksAdded = paddedTotal - totalPages;
  const signatureCount = paddedTotal / P;

  const signatures = [];
  for (let i = 0; i < signatureCount; i++) {
    const pageOffset = i * P;
    const localSheets = imposeSignature(P);
    const toGlobal = (localPageNum) => {
      const global = pageOffset + localPageNum;
      return global > totalPages ? 0 : global; // 0 = blank
    };
    const sheets = localSheets.map((sheet) => ({
      front: { left: toGlobal(sheet.front.left), right: toGlobal(sheet.front.right) },
      back: { left: toGlobal(sheet.back.left), right: toGlobal(sheet.back.right) },
    }));
    signatures.push({ index: i, pageOffset, pageCount: P, sheets });
  }

  return { paddedTotal, blanksAdded, signatures };
}

// ---- Self-checks -----------------------------------------------------------
// Hand-verified expected page mappings for small P values. Run with `node impose.js`.
function _runSelfChecks() {
  const cases = [
    {
      P: 4,
      expected: [{ front: { left: 4, right: 1 }, back: { left: 2, right: 3 } }],
    },
    {
      P: 8,
      expected: [
        { front: { left: 8, right: 1 }, back: { left: 2, right: 7 } },
        { front: { left: 6, right: 3 }, back: { left: 4, right: 5 } },
      ],
    },
    {
      P: 12,
      expected: [
        { front: { left: 12, right: 1 }, back: { left: 2, right: 11 } },
        { front: { left: 10, right: 3 }, back: { left: 4, right: 9 } },
        { front: { left: 8, right: 5 }, back: { left: 6, right: 7 } },
      ],
    },
  ];

  let failures = 0;
  for (const { P, expected } of cases) {
    const actual = imposeSignature(P);
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.assert(ok, `imposeSignature(${P}) mismatch`, { actual, expected });
    if (!ok) failures++;
  }

  // imposeBook: 10 pages, signature size 1 sheet (P=4) -> pad to 12, 3 signatures.
  const book = imposeBook(10, 1);
  console.assert(book.paddedTotal === 12, "imposeBook paddedTotal", book.paddedTotal);
  console.assert(book.blanksAdded === 2, "imposeBook blanksAdded", book.blanksAdded);
  console.assert(book.signatures.length === 3, "imposeBook signatureCount", book.signatures.length);
  // Last signature covers global pages 9,10,11,12 -> 11 and 12 are blank (0).
  const lastSheet = book.signatures[2].sheets[0];
  const flat = [lastSheet.front.left, lastSheet.front.right, lastSheet.back.left, lastSheet.back.right];
  console.assert(flat.includes(0), "imposeBook trailing blanks present", flat);
  if (!book.paddedTotal === 12 || book.blanksAdded !== 2 || book.signatures.length !== 3) failures++;

  if (failures === 0) {
    console.log("impose.js self-checks passed.");
  } else {
    console.error(`impose.js self-checks: ${failures} failure(s).`);
  }
  return failures === 0;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { imposeSignature, imposeBook };
  if (require.main === module) {
    const ok = _runSelfChecks();
    process.exit(ok ? 0 : 1);
  }
}
if (typeof window !== "undefined") {
  window.imposeSignature = imposeSignature;
  window.imposeBook = imposeBook;
  window._imposeSelfCheck = _runSelfChecks;
}
