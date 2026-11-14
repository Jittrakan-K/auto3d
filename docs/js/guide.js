// First-visit guide: a short tour that highlights each part of the builder in turn.
// Opens by itself once per browser, and again from the Guide button in the rail.

const SEEN = "auto3d.guided";

const STEPS = [
  { title: "Welcome to AUTO3D", text: "Turn a command or a drawing into a STEP file and a SOLIDWORKS part with a feature tree. This tour takes about a minute" },
  { sel: "#prompt", title: "1. Describe the part", text: "Type sizes and features, for example: Steel plate 120x80x10, M8 holes at 4 corners 10 from edge. Simple parts build here with no AI" },
  { sel: "#drop", title: "2. Or attach a drawing", text: "Drop a PDF, picture or DXF. Drawings are read by Claude, using your Claude Pro chat or an API key" },
  { sel: "#generate", title: "3. Build model", text: "Builds each feature in order, checks the result and shows it. Nothing downloads until you choose a file" },
  { sel: "#examples", title: "Try a sample", text: "Click any sample part to see a finished result straight away" },
  { sel: ".frame", title: "4. Check the part", text: "Four views like a drawing. Switch to one view, Lines or Shaded, and drag to turn the model" },
  { sel: ".files-grid", title: "5. Download", text: "STEP opens in any CAD. SOLIDWORKS macro rebuilds the part with a feature tree and dimensioned sketches. .SLDPRT needs the desktop app" },
  { sel: "#sw-setup", title: "Set up SOLIDWORKS once", text: "Make the macro button one time. After that every part is one click in SOLIDWORKS, with nothing to install" },
  { sel: "#open-settings", title: "Settings", text: "Add a Claude project link so a drawing goes over in one paste, or an API key to skip Claude chat entirely" },
  { sel: '.rail a[href="history.html"]', title: "History", text: "Every part you build is kept here. Open it again, back it up or delete it" },
  { sel: '.rail a[href="drawing.html"]', title: "2D drawing", text: "Turn a STEP file into a dimensioned drawing with title block, as PDF, DXF or SVG" },
  { title: "You are ready", text: "Start with a sample or type your first part. Open this guide again any time from Guide in the left menu" },
];

let root, spot, card, i = 0;

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function target(step) {
  if (!step.sel) return null;
  const el = document.querySelector(step.sel);
  if (el && el.tagName === "DETAILS") el.open = true;
  return visible(el) ? el : null;
}

function place() {
  const step = STEPS[i];
  const el = target(step);
  card.querySelector(".guide-title").textContent = step.title;
  card.querySelector(".guide-text").textContent = step.text;
  card.querySelector(".guide-count").textContent = `${i + 1} / ${STEPS.length}`;
  card.querySelector("[data-g=back]").hidden = i === 0;
  card.querySelector("[data-g=next]").textContent = i === STEPS.length - 1 ? "Start building" : "Next";
  card.querySelector("[data-g=skip]").hidden = i === STEPS.length - 1;

  if (!el) {
    spot.hidden = true;
    root.classList.add("dim");
    Object.assign(card.style, { left: "50%", top: "50%", transform: "translate(-50%, -50%)" });
    return;
  }
  root.classList.remove("dim");
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect(), pad = 6;
  spot.hidden = false;
  Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });

  // Card beside the target: right if there is room, else left, else below or above.
  card.style.transform = "none";
  const cw = card.offsetWidth, ch = card.offsetHeight, gap = 16, vw = innerWidth, vh = innerHeight;
  let x, y;
  if (r.right + gap + cw < vw - 8) { x = r.right + gap; y = r.top; }
  else if (r.left - gap - cw > 8) { x = r.left - gap - cw; y = r.top; }
  else { x = r.left; y = r.bottom + gap + ch < vh - 8 ? r.bottom + gap : r.top - gap - ch; }
  x = Math.min(Math.max(8, x), vw - cw - 8);
  y = Math.min(Math.max(8, y), vh - ch - 8);
  Object.assign(card.style, { left: `${x}px`, top: `${y}px` });
}

function go(n) {
  if (n < 0) return;
  if (n >= STEPS.length) { close(); return; }
  i = n;
  place();
  card.querySelector("[data-g=next]").focus();
}

function close() {
  try { localStorage.setItem(SEEN, "1"); } catch { /* not saved */ }
  root?.remove();
  root = null;
  removeEventListener("resize", place);
  removeEventListener("keydown", keys, true);
}

function keys(e) {
  if (e.key === "Escape") { e.preventDefault(); close(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
}

export function startGuide() {
  if (root) return;
  root = document.createElement("div");
  root.className = "guide";
  root.innerHTML = `
    <div class="guide-spot" hidden></div>
    <div class="guide-card" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <div class="guide-top"><span class="guide-count"></span><button type="button" class="guide-x" data-g="skip" aria-label="Close guide">Skip</button></div>
      <h2 id="guide-title" class="guide-title"></h2>
      <p class="guide-text"></p>
      <div class="guide-actions">
        <button type="button" class="btn" data-g="back">Back</button>
        <button type="button" class="btn primary" data-g="next">Next</button>
      </div>
    </div>`;
  document.body.append(root);
  spot = root.querySelector(".guide-spot");
  card = root.querySelector(".guide-card");
  root.addEventListener("click", (e) => {
    const g = e.target.closest("[data-g]")?.dataset.g;
    if (g === "next") go(i + 1);
    else if (g === "back") go(i - 1);
    else if (g === "skip") close();
  });
  addEventListener("resize", place);
  addEventListener("keydown", keys, true);
  go(0);
}

// Once per browser, and whenever the page is opened with ?guide
export function autoGuide() {
  let seen = false;
  try { seen = !!localStorage.getItem(SEEN); } catch { /* storage blocked: show it */ }
  if (new URLSearchParams(location.search).has("guide") || !seen) setTimeout(startGuide, 400);
}
