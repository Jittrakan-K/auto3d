import { loadHistory, saveHistory, removeEntry } from "./js/history.js?v=202611121757";

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const when = (iso) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

function message(text) { $("log-msg").textContent = text; $("log-msg").hidden = !text; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render() {
  const all = loadHistory();
  const q = $("log-search").value.trim().toLowerCase();
  const shown = q ? all.filter((e) => `${e.name} ${e.source}`.toLowerCase().includes(q)) : all;
  $("log-count").textContent = all.length ? `${all.length} ${all.length === 1 ? "part" : "parts"}${q ? ` · ${shown.length} found` : ""}` : "";
  $("log-empty").hidden = all.length > 0;
  $("log-list").replaceChildren(...shown.map((e) => {
    const li = el("li", "log-item");
    const pic = el("div", "log-thumb");
    if (e.thumb) { const img = new Image(160, 160); img.src = e.thumb; img.alt = ""; pic.append(img); }
    const body = el("div", "log-body");
    body.append(el("h2", "log-name", e.name), el("p", "log-source", e.source || "-"));
    const facts = el("dl", "log-facts");
    for (const [k, v] of [
      ["Size (mm)", e.size ? e.size.map((x) => fmt(x)).join(" × ") : "-"],
      ["Mass (g)", e.mass_g != null ? fmt(e.mass_g) : "-"],
      ["Features", e.features ?? "-"],
      ["Built", when(e.at)],
    ]) { const d = el("div"); d.append(el("dt", null, k), el("dd", null, String(v))); facts.append(d); }
    body.append(facts);
    const acts = el("div", "log-acts");
    const open = el("a", "btn primary", "Open");
    open.href = `./?open=${encodeURIComponent(e.id)}`;
    const del = el("button", "btn", "Delete");
    del.type = "button";
    del.onclick = () => {
      if (del.dataset.armed) { removeEntry(e.id); render(); return; }
      del.dataset.armed = "1"; del.textContent = "Click again to delete"; del.classList.add("danger");
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "Delete"; del.classList.remove("danger"); } }, 3000);
    };
    acts.append(open, del);
    li.append(pic, body, acts);
    return li;
  }));
}

$("log-search").oninput = render;
$("log-export").onclick = () => {
  const list = loadHistory();
  if (!list.length) { message("Nothing to back up yet"); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: "auto-design-3d", history: list }, null, 1)], { type: "application/json" }));
  a.download = `auto-design-3d-history-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
$("log-import").onclick = () => $("log-file").click();
$("log-file").onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.history || []).filter((e) => e && e.id && e.raw && e.at);
    if (!incoming.length) throw new Error("No parts found in this file");
    const byId = new Map(loadHistory().map((e) => [e.id, e]));
    let added = 0;
    for (const e of incoming) if (!byId.has(e.id)) { byId.set(e.id, e); added++; }
    const merged = [...byId.values()].sort((a, b) => b.at.localeCompare(a.at));
    if (!saveHistory(merged)) throw new Error("Not enough browser storage");
    message(`Imported ${added} ${added === 1 ? "part" : "parts"}`);
    render();
  } catch (e) { message(`Import failed: ${e.message}`); }
};
render();
