// Drives headless Chrome to turn book.config.json into a typeset book.
//
//   node build.mjs              preview images + both PDFs
//   node build.mjs preview      preview images only (the fast iteration loop)
//   node build.mjs pdf          both PDFs only
//
// Everything is rendered by render.html in a real browser, because pagination
// needs a real layout engine: where a line breaks, how tall a paragraph is, and
// what a font's cap height actually measures are not things to reimplement.
//
// No dependencies — it shells out to Chrome and serves files with node:http.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(ROOT, "book.config.json"), "utf8"));
const OUT = resolve(ROOT, config.source.outDir || "out");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".epub": "application/epub+zip", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
};

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error(
      "Could not find Chrome. Set CHROME env var to its path, or add it to " +
      "CHROME_CANDIDATES in build.mjs."
    );
  }
  return process.env.CHROME || found;
}

// A minimal static server. render.html fetches the epub and the config over
// HTTP, and file:// URLs can't do that under Chrome's origin rules.
function serve() {
  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
        const filePath = join(ROOT, path === "/" ? "/render.html" : path);
        if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const body = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
          // The renderer cache-busts its own scripts, but belt and braces: a
          // stale engine against a fresh renderer is a maddening bug to chase.
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port }));
  });
}

function runChrome(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(findChrome(), args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`Chrome timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); rejectRun(e); });
    child.on("exit", () => { clearTimeout(timer); resolveRun(); });
  });
}

/**
 * Chrome's headless screenshot/print can fire before an async page has finished.
 * `--virtual-time-budget` is what makes it wait: the clock only advances while
 * the page is idle, so a long budget costs nothing on a fast page but gives a
 * thousand-page book room to finish.
 */
function chromeArgs(url, extra, profile) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=600000",
    ...extra,
    url,
  ];
}

// Chrome sometimes exits early against a cold profile, producing a stub file.
// Retry on anything implausibly small rather than shipping a blank page.
async function capture(label, args, outFile, minBytes, profile) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await rm(outFile, { force: true });
    await runChrome(args);
    if (existsSync(outFile)) {
      const { size } = await stat(outFile);
      if (size >= minBytes) {
        console.log(`  ${label.padEnd(26)} ${(size / 1024).toFixed(0).padStart(7)} KB`);
        return;
      }
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label}: Chrome produced no usable output after 3 attempts`);
}

async function main() {
  const task = process.argv[2] || "all";
  const doPreview = task === "all" || task === "preview";
  const doPdf = task === "all" || task === "pdf";

  await mkdir(OUT, { recursive: true });
  const profile = join(OUT, ".chrome-profile");
  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}/render.html`;
  const { fromChapter, toChapter, zoom } = config.preview;

  try {
    if (doPreview) {
      console.log(`\nPreview — chapters ${fromChapter}–${toChapter}:`);
      const url = `${base}?mode=preview&from=${fromChapter}&to=${toChapter}&zoom=${zoom}`;
      // One tall capture of every spread in the range, plus a tight one of the
      // first spread — that's the chapter opener, where most of the design lives.
      await capture(
        "preview-spreads.png",
        chromeArgs(url, ["--window-size=1650,3200", `--screenshot=${join(OUT, "preview-spreads.png")}`], profile),
        join(OUT, "preview-spreads.png"), 20000, profile
      );
      await capture(
        "preview-opener.png",
        chromeArgs(`${base}?mode=preview&from=${fromChapter}&to=${fromChapter + 1}&zoom=1.5`,
          ["--window-size=1850,1500", `--screenshot=${join(OUT, "preview-opener.png")}`], profile),
        join(OUT, "preview-opener.png"), 20000, profile
      );
    }

    if (doPdf) {
      console.log("\nPDFs — whole book:");
      await capture(
        "reading.pdf",
        chromeArgs(`${base}?mode=reading`,
          [`--print-to-pdf=${join(OUT, "reading.pdf")}`, "--no-pdf-header-footer"], profile),
        join(OUT, "reading.pdf"), 50000, profile
      );
      await capture(
        "imposed.pdf",
        chromeArgs(`${base}?mode=imposed`,
          [`--print-to-pdf=${join(OUT, "imposed.pdf")}`, "--no-pdf-header-footer"], profile),
        join(OUT, "imposed.pdf"), 50000, profile
      );
    }

    console.log(`\nDone → ${OUT}`);
    for (const f of (await readdir(OUT)).filter((f) => !f.startsWith("."))) console.log(`  ${f}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});
