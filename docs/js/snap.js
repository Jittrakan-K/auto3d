// Turns an attached drawing (PDF or image) into one PNG for pasting into a Claude chat.
// Margins are trimmed so the drawing keeps as much resolution as Claude allows.

const LONG_EDGE = 3000; // px of the final picture
const MAX_PAGES = 2;

let pdfjs = null;
async function loadPdf() {
  if (!pdfjs) {
    pdfjs = await import("../vendor/pdfjs/pdf.min.mjs?v=202611141900");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs?v=202611141900", import.meta.url).href;
  }
  return pdfjs;
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  return [c, g];
}

// Bounding box of the non-white pixels, with a small margin.
function trim(src) {
  const g = src.getContext("2d");
  const { width: w, height: h } = src;
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (d[i] < 225 || d[i + 1] < 225 || d[i + 2] < 225) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return src;
  const m = Math.round(Math.max(w, h) * 0.01);
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(w, x1 + m); y1 = Math.min(h, y1 + m);
  const [c, cg] = canvas(x1 - x0, y1 - y0);
  cg.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return c;
}

async function pdfPages(file) {
  const lib = await loadPdf();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (LONG_EDGE * 1.3) / Math.max(base.width, base.height) });
    const [c, g] = canvas(vp.width, vp.height);
    await page.render({ canvasContext: g, viewport: vp, background: "#ffffff" }).promise;
    out.push(trim(c));
  }
  doc.destroy();
  return out;
}

async function imagePage(file) {
  const bmp = await createImageBitmap(file);
  const [c, g] = canvas(bmp.width, bmp.height);
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return [trim(c)];
}

export function canSnap(file) {
  return /\.pdf$/i.test(file.name) || file.type === "application/pdf" || /^image\//.test(file.type);
}

// One PNG blob of the drawing; pages are stacked when the PDF has more than one.
export async function drawingPng(file) {
  const pages = /^image\//.test(file.type) ? await imagePage(file) : await pdfPages(file);
  const w = Math.max(...pages.map((p) => p.width));
  const h = pages.reduce((s, p) => s + p.height, 0);
  const k = Math.min(1, LONG_EDGE / Math.max(w, h));
  const [c, g] = canvas(w * k, h * k);
  g.imageSmoothingQuality = "high";
  let y = 0;
  for (const p of pages) { g.drawImage(p, 0, y, p.width * k, p.height * k); y += p.height * k; }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not make a picture of the drawing"))), "image/png"));
}
