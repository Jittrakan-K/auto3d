import { Viewer } from "/viewer.js";

const $ = (id) => document.getElementById(id);
const state = { job: null, files: [], status: null, dirty: false };
const viewer = new Viewer($("viewport"));
const VIEW_NAMES = { iso: "ไอโซเมตริก", front: "ด้านหน้า", top: "ด้านบน", right: "ด้านขวา" };

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบกลับผิดพลาด (${res.status})`);
  return body;
}
const post = (path, data) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

function show(el, on) { el.hidden = !on; }
function fail(message) { $("error").textContent = message; show($("error"), !!message); }
function busy(text) {
  $("busy").textContent = text || "";
  show($("busy"), !!text);
  $("generate").disabled = !!text;
  $("rebuild").disabled = !!text;
}
function list(el, items) {
  el.replaceChildren(...items.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
}
const fileUrl = (name, inline) =>
  `/api/jobs/${state.job.id}/files/${encodeURIComponent(name)}${inline ? "?inline=true" : ""}`;

// ---------- status ----------
async function refreshStatus() {
  const s = await api("/api/status");
  state.status = s;
  const ai = $("st-ai"), sw = $("st-sw");
  ai.className = "state " + (s.api_key ? "on" : "off");
  ai.textContent = s.api_key ? "Claude พร้อมใช้" : "Claude ยังไม่มีคีย์";
  ai.title = s.api_key ? `ใช้ ${s.model}` : "ยังไม่ได้ใส่ API key";
  sw.className = "state " + (s.solidworks.available ? "on" : "off");
  sw.title = s.solidworks.reason;
  sw.textContent = s.solidworks.version ? `SOLIDWORKS ${s.solidworks.version}` : "SOLIDWORKS";
  $("model").replaceChildren(...s.models.map((m) => new Option(m, m, false, m === s.model)));
  updateSwButton();
}

function updateSwButton() {
  const btn = $("make-sw"), s = state.status;
  if (!s) return;
  const year = s.solidworks.version;
  btn.disabled = !s.solidworks.available;
  btn.title = s.solidworks.reason;
  btn.textContent = "สร้าง";
  $("sw-compat").textContent = year ? `${year} ขึ้นไป สร้างด้วยรุ่นในเครื่องนี้` : "ต้องมี SOLIDWORKS ในเครื่อง";
}

// ---------- files ----------
function renderFiles() {
  $("file-list").replaceChildren(...state.files.map((f, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span"); name.textContent = f.name;
    const del = document.createElement("button");
    del.type = "button"; del.textContent = "เอาออก";
    del.onclick = () => { state.files.splice(i, 1); renderFiles(); };
    li.append(name, del);
    return li;
  }));
}
function addFiles(list) { state.files.push(...list); renderFiles(); }
const drop = $("drop");
drop.onclick = () => $("file").click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } };
$("file").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
for (const ev of ["dragover", "dragenter"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

// ---------- result ----------
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });

async function showJob(job) {
  state.job = job;
  state.dirty = false;
  document.body.classList.add("has-model");
  show($("rebuild"), false);
  show($("empty"), false);
  show($("no-model"), false);
  show($("details"), true);
  show($("title-block"), true);
  show($("modify-row"), true);
  show($("sw-result"), false);

  const s = job.summary;
  $("tb-name").textContent = job.name;
  $("tb-size").textContent = s.size.map((v) => fmt(v)).join(" × ");
  $("tb-vol").textContent = fmt(s.volume_mm3 / 1000);
  $("tb-mass").textContent = fmt(s.mass_g);
  const v = $("tb-verify");
  v.textContent = job.verify.ok ? "ผ่าน ปริมาตรตรงกัน" : `ค่าต่างกัน ${job.verify.diff_percent}%`;
  v.classList.toggle("bad", !job.verify.ok);
  $("dl-step").href = fileUrl(job.files.step);
  $("dl-macro").href = fileUrl(job.files.macro);
  updateSwButton();

  show($("questions-box"), job.questions.length > 0);
  list($("questions"), job.questions);
  show($("assume-box"), job.assumptions.length > 0);
  list($("assumptions"), job.assumptions);
  renderDims(job);
  $("features").replaceChildren(...job.features.map((f) => {
    const li = document.createElement("li");
    li.textContent = f.name;
    return li;
  }));
  $("plan-json").value = JSON.stringify(job.raw_plan, null, 2);
  await viewer.load(fileUrl(job.files.stl, true));
}

function renderDims(job) {
  const rows = job.parameters.map((p, i) => {
    const tr = document.createElement("tr");
    if (p.confidence === "low") tr.className = "low";
    const a = document.createElement("td");
    a.textContent = p.label || p.name;
    if (p.confidence === "low") {
      const tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = "ค่าประมาณ ตรวจก่อนใช้";
      a.append(" ", tag);
    }
    if (p.source) { const s = document.createElement("small"); s.textContent = p.source; a.append(s); }
    const b = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number"; input.step = "any"; input.value = p.value;
    input.setAttribute("aria-label", p.label || p.name);
    const raw = job.raw_plan.parameters[i];
    if (typeof raw.value === "string" && raw.value.startsWith("=")) {
      input.disabled = true; input.title = `คำนวณจาก ${raw.value.slice(1)}`;
    }
    input.oninput = () => {
      if (input.value === "") return;
      raw.value = Number(input.value);
      state.dirty = true;
      show($("rebuild"), true);
    };
    b.append(input);
    tr.append(a, b);
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = 2; td.textContent = "แผนนี้ไม่มีตัวแปรให้แก้"; tr.append(td); rows.push(tr);
  }
  $("dims").replaceChildren(...rows);
}

async function build(plan) {
  fail(""); busy("กำลังสร้างโมเดล");
  try { await showJob(await post("/api/build", { plan })); }
  catch (e) { fail(e.message); }
  finally { busy(""); }
}

// ---------- actions ----------
$("brief-form").onsubmit = async (e) => {
  e.preventDefault();
  fail("");
  if (!state.status?.api_key) { fail("ใส่ Claude API key ก่อน หรือลองชิ้นงานตัวอย่างด้านล่าง"); $("settings").showModal(); return; }
  const prompt = $("prompt").value;
  if (!prompt.trim() && !state.files.length) { fail("พิมพ์คำสั่งหรือแนบ Drawing ก่อน"); return; }
  const form = new FormData();
  form.append("prompt", prompt);
  if (state.job && $("modify").checked) form.append("current_plan", JSON.stringify(state.job.raw_plan));
  for (const f of state.files) form.append("files", f);
  busy(state.files.length ? "กำลังอ่าน Drawing และออกแบบ อาจใช้เวลา 1 ถึง 3 นาที" : "กำลังออกแบบ อาจใช้เวลาประมาณ 1 นาที");
  try {
    await showJob(await api("/api/generate", { method: "POST", body: form }));
    state.files = []; renderFiles();
  } catch (err) { fail(err.message); }
  finally { busy(""); }
};

$("rebuild").onclick = () => build(state.job.raw_plan);

$("build-json").onclick = () => {
  try { build(JSON.parse($("plan-json").value)); }
  catch (e) { fail(`JSON ไม่ถูกต้อง: ${e.message}`); }
};

$("make-sw").onclick = async () => {
  const btn = $("make-sw"), out = $("sw-result");
  btn.disabled = true; btn.textContent = "SOLIDWORKS กำลังสร้าง";
  out.textContent = "ถ้า SOLIDWORKS ยังไม่เปิด ระบบจะเปิดให้ อาจใช้เวลาสักครู่"; show(out, true);
  try {
    const r = await post(`/api/jobs/${state.job.id}/sldprt`, {});
    out.textContent = r.message + " ";
    const a = document.createElement("a");
    a.href = fileUrl(r.file); a.download = r.file; a.textContent = "ดาวน์โหลด SLDPRT";
    const open = document.createElement("a");
    open.href = "#"; open.textContent = "เปิดโฟลเดอร์";
    open.onclick = (ev) => { ev.preventDefault(); post(`/api/jobs/${state.job.id}/open`, {}); };
    out.append(a, " ", open);
  } catch (e) { out.textContent = e.message; }
  finally { updateSwButton(); }
};

function press(selector, chosen) {
  document.querySelectorAll(selector).forEach((b) => b.setAttribute("aria-pressed", String(b === chosen)));
}
document.querySelectorAll("[data-view]").forEach((b) => {
  b.onclick = () => {
    const name = b.dataset.view;
    press("[data-view]", b);
    $("views").dataset.mode = name === "quad" ? "quad" : "single";
    $("single-label").textContent = VIEW_NAMES[name] || "";
    viewer.setView(name);
  };
});
document.querySelectorAll("[data-look]").forEach((b) => {
  b.onclick = () => { press("[data-look]", b); viewer.setLook(b.dataset.look); };
});

$("open-settings").onclick = () => { show($("settings-error"), false); $("settings").showModal(); };
$("close-settings").onclick = () => $("settings").close();
$("settings-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post("/api/settings", { api_key: $("api-key").value || null, model: $("model").value });
    $("api-key").value = "";
    await refreshStatus();
    $("settings").close();
  } catch (err) { $("settings-error").textContent = err.message; show($("settings-error"), true); }
};

(async () => {
  try {
    await refreshStatus();
    const examples = await api("/api/examples");
    $("examples").replaceChildren(...examples.map((x) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = x.description || x.name;
      b.onclick = () => build(x.plan);
      return b;
    }));
  } catch (e) { fail(e.message); }
})();
