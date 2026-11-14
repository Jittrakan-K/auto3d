import { makeDrawing, projectAll, fmtScale, fmtLen } from "./js/drawing.js?v=202611141800";
import { toSVG, toDXF, toPDF } from "./js/export2d.js?v=202611141800";

const $ = (id) => document.getElementById(id);
const state = { K: null, shape: null, views: null, name: "", drawing: null };
const HANDOFF = "auto3d.drawing";

function fail(msg) { $("dw-error").textContent = msg; $("dw-error").hidden = !msg; }
function status(text, kind) { const s = $("dw-status"); s.textContent = text; s.className = "state " + kind; s.hidden = kind === "on"; }
const safeName = (n) => (n || "drawing").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "drawing";
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function loadKernel() {
  const K = await import("./vendor/kernel/cad-kernel.js?v=202611141800");
  const wasm = new URL("vendor/kernel/replicad_single.wasm", document.baseURI).href;
  K.setOC(await K.opencascade({ locateFile: () => wasm }));
  state.K = K;
}

async function loadStep(text, name) {
  fail("");
  $("dw-file-name").textContent = name;
  $("dw-heading").textContent = "Reading the part";
  $("dw-heading").classList.add("working");
  await frame();
  try {
    state.shape = await state.K.importSTEP(new Blob([text]));
    state.views = projectAll(state.K, state.shape, $("dw-main").value);
  } catch (e) {
    state.shape = null;
    $("dw-heading").classList.remove("working");
    $("dw-heading").textContent = "Could not read the file";
    fail(`This file could not be read as a STEP part: ${e.message || e}`);
    return;
  }
  state.name = name.replace(/\.(step|stp)$/i, "");
  if (!$("dw-title").value) $("dw-title").value = state.name;
  if (!$("dw-part").value) $("dw-part").value = state.name;
  $("dw-make").disabled = false;
  render();
}

function render() {
  if (!state.shape) return;
  const opts = {
    views: state.views,
    title: $("dw-title").value.trim() || state.name,
    partNo: $("dw-part").value.trim(),
    material: $("dw-material").value.trim(),
    drawnBy: $("dw-drawn").value.trim(),
    sheet: $("dw-sheet").value, scale: $("dw-scale").value,
    hidden: $("dw-hidden").checked, iso: $("dw-iso").checked, callouts: $("dw-callouts").value === "on",
  };
  const d = makeDrawing(state.K, state.shape, opts);
  d.title = opts.title;
  state.drawing = d;
  $("dw-preview").innerHTML = toSVG(d, { forScreen: true });
  $("dw-preview").classList.add("ready");
  $("dw-heading").classList.remove("working");
  $("dw-heading").textContent = opts.title;
  $("dw-sub").textContent = `${d.sheet} sheet at ${fmtScale(d.scale)}. Download it as PDF, DXF or SVG`;
  $("dw-sheet-label").textContent = `${d.sheet} · ${fmtScale(d.scale)}`;
  const bb = state.shape.boundingBox.bounds;
  $("dw-f-sheet").textContent = `${d.sheet} landscape`;
  $("dw-f-scale").textContent = fmtScale(d.scale);
  $("dw-f-size").textContent = [0, 1, 2].map((i) => fmtLen(bb[1][i] - bb[0][i])).join(" × ");
  const holes = d.prims.filter((p) => p.t === "text" && p.layer === "dim" && /%%c|(^|x )R\d/.test(p.s)).map((p) => p.s.replace("%%c", "Ø"));
  $("dw-f-holes").textContent = holes.length ? holes.join(", ") : "None";
  for (const id of ["dw-pdf", "dw-dxf", "dw-svg"]) $(id).disabled = false;
}

// ---------- inputs ----------
const drop = $("dw-drop");
drop.onclick = () => $("dw-file").click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("dw-file").click(); } };
for (const ev of ["dragover", "dragenter"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
async function takeFile(file) {
  if (!file) return;
  if (!/\.(step|stp)$/i.test(file.name)) { fail("Choose a .step or .stp file. For SLDPRT, save it as STEP in SOLIDWORKS first"); return; }
  if (!state.K) { fail("The engine is still loading, try again in a moment"); return; }
  await loadStep(await file.text(), file.name);
}
drop.addEventListener("drop", (e) => takeFile(e.dataTransfer.files[0]));
$("dw-file").onchange = (e) => { takeFile(e.target.files[0]); e.target.value = ""; };
$("dw-form").onsubmit = (e) => { e.preventDefault(); render(); };
for (const id of ["dw-sheet", "dw-scale", "dw-hidden", "dw-iso", "dw-callouts"]) $(id).onchange = render;
$("dw-main").onchange = async () => {
  if (!state.shape) return;
  $("dw-heading").classList.add("working");
  await frame();
  state.views = projectAll(state.K, state.shape, $("dw-main").value);
  render();
};
for (const id of ["dw-title", "dw-part", "dw-material", "dw-drawn"]) $(id).onchange = render;

$("dw-pdf").onclick = () => download(toPDF(state.drawing), `${safeName(state.drawing.title)}.pdf`);
$("dw-dxf").onclick = () => download(new Blob([toDXF(state.drawing)], { type: "application/dxf" }), `${safeName(state.drawing.title)}.dxf`);
$("dw-svg").onclick = () => download(new Blob([toSVG(state.drawing)], { type: "image/svg+xml" }), `${safeName(state.drawing.title)}.svg`);

// The builder page hands over its current part through sessionStorage.
function handoff() {
  try { const v = sessionStorage.getItem(HANDOFF); return v ? JSON.parse(v) : null; } catch { return null; }
}

(async () => {
  try {
    await loadKernel();
    status("Ready", "on");
  } catch (e) {
    status("Engine failed to load", "off");
    fail(`The engine failed to load: ${e.message}`);
    return;
  }
  const h = handoff();
  if (h?.step) {
    $("dw-use-current").hidden = false;
    $("dw-use-current").onclick = () => loadStep(h.step, `${h.name}.step`);
    if (new URLSearchParams(location.search).get("from") === "builder") {
      history.replaceState(null, "", location.pathname);
      if (h.material && !$("dw-material").value) $("dw-material").value = h.material;
      await loadStep(h.step, `${h.name}.step`);
    }
  }
})();
