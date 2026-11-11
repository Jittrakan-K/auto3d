import { Viewer } from "./js/viewer.js";
import { useKernel, stepBlob, verifyStep, meshOf } from "./js/cad.js";
import { useHelpers, render as renderMacro } from "./js/macro.js";
import { MODELS, makePlan, toBlocks, tryBuild, AiError } from "./js/ai.js";
import { quickPlan } from "./js/quick.js";
import { addEntry, getEntry } from "./js/history.js";
import { localStatus, localSldprt, launchLocal, LocalError } from "./js/local.js";

const $ = (id) => document.getElementById(id);
const VIEW_NAMES = { iso: "ไอโซเมตริก", front: "ด้านหน้า", top: "ด้านบน", right: "ด้านขวา" };
const KEY_STORE = "autodesign3d.key";
const MODEL_STORE = "autodesign3d.model";
const state = { job: null, files: [], key: "", model: MODELS[0], kernel: null, DxfParser: null, schema: null, system: "" };
const viewer = new Viewer($("viewport"));

// Storage can be blocked (private windows), so every access is guarded.
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* not saved */ } },
};

function show(el, on) { el.hidden = !on; }
function fail(message) { $("error").textContent = message; show($("error"), !!message); }
function busy(text) {
  $("busy").textContent = text || "";
  show($("busy"), !!text);
  $("generate").disabled = !!text || !state.kernel;
  $("rebuild").disabled = !!text;
}
function list(el, items) {
  el.replaceChildren(...items.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
}
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const safeName = (n) => (n || "part").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "part";
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- status ----------
function refreshStatus() {
  const ai = $("st-ai");
  ai.className = "state on";
  ai.textContent = state.key ? "Claude API พร้อมใช้" : "Claude Pro ผ่านแชต";
  ai.title = state.key ? `ใช้ ${state.model}` : "ไม่มี API key ใช้แชตของ Claude Pro แทน";
  const cad = $("st-cad");
  cad.className = "state " + (state.kernel ? "on" : state.kernelError ? "off" : "wait");
  cad.textContent = state.kernel ? "ตัวสร้างโมเดลพร้อม" : state.kernelError ? "โหลดตัวสร้างโมเดลไม่ได้" : "ตัวสร้างโมเดลกำลังโหลด";
  $("generate").disabled = !state.kernel;
}

async function loadKernel() {
  const [K, helpers, schema, system] = await Promise.all([
    import("./vendor/kernel/cad-kernel.js"),
    fetch("assets/macro-helpers.bas").then((r) => r.text()),
    fetch("assets/plan-schema.json").then((r) => r.json()),
    fetch("assets/system-prompt.txt").then((r) => r.text()),
  ]);
  state.chatFormat = await fetch("assets/chat-format.txt").then((r) => r.text());
  const wasm = new URL("vendor/kernel/replicad_single.wasm", document.baseURI).href;
  const oc = await K.opencascade({ locateFile: () => wasm });
  K.setOC(oc);
  useKernel(K);
  useHelpers(helpers);
  Object.assign(state, { kernel: K, DxfParser: K.DxfParser, schema, system });
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
function addFiles(files) { state.files.push(...files); renderFiles(); }
const drop = $("drop");
drop.onclick = () => $("file").click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } };
$("file").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
for (const ev of ["dragover", "dragenter"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

// ---------- result ----------
// source: what this build came from (the command, a sample, an edit). Builds without one,
// such as reopening an entry, are not added to the history again.
async function showJob(raw, plan, result, source) {
  const step = stepBlob(result, plan.name);
  const verify = await verifyStep(step, result.volume_mm3);
  state.job = { raw, plan, result, step, macro: renderMacro(result.steps, plan.name), source: source || state.job?.source || "" };
  document.body.classList.add("has-model");
  show($("rebuild"), false);
  show($("empty"), false);
  show($("no-model"), false);
  show($("details"), true);
  show($("title-block"), true);
  show($("modify-row"), true);

  $("tb-name").textContent = plan.name;
  $("tb-size").textContent = result.size.map((v) => fmt(v)).join(" × ");
  $("tb-vol").textContent = fmt(result.volume_mm3 / 1000);
  $("tb-mass").textContent = fmt(result.mass_g);
  const v = $("tb-verify");
  v.textContent = verify.ok ? "ผ่าน ปริมาตรตรงกัน" : `ค่าต่างกัน ${verify.diff_percent}%`;
  v.classList.toggle("bad", !verify.ok);

  show($("questions-box"), plan.questions.length > 0);
  list($("questions"), plan.questions);
  show($("assume-box"), plan.assumptions.length > 0);
  list($("assumptions"), plan.assumptions);
  renderDims(raw, plan);
  list($("features"), plan.features.map((f) => f.name || f.id));
  $("plan-json").value = JSON.stringify(raw, null, 2);
  viewer.load(meshOf(result));
  if (source) {
    addEntry({
      at: new Date().toISOString(), name: plan.name, source, raw,
      size: result.size.map((v) => +v.toFixed(2)), volume_cm3: +(result.volume_mm3 / 1000).toFixed(2),
      mass_g: +result.mass_g.toFixed(2), features: plan.features.length, thumb: viewer.thumbnail(),
    });
  }
}

function renderDims(raw, plan) {
  const rows = plan.parameters.map((p, i) => {
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
    input.type = "number"; input.step = "any"; input.value = +p.value.toFixed(4);
    input.setAttribute("aria-label", p.label || p.name);
    const src = raw.parameters[i];
    if (typeof src.value === "string" && src.value.startsWith("=")) {
      input.disabled = true; input.title = `คำนวณจาก ${src.value.slice(1)}`;
    }
    input.oninput = () => {
      if (input.value === "") return;
      src.value = Number(input.value);
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

async function buildRaw(raw, source) {
  fail(""); busy("กำลังสร้างโมเดล");
  await nextFrame();
  try {
    const built = tryBuild(raw);
    if (built.error) throw new Error(built.error);
    await showJob(raw, built.plan, built.result, source);
  } catch (e) { fail(e.message); }
  finally { busy(""); }
}

// ---------- actions ----------
$("brief-form").onsubmit = async (e) => {
  e.preventDefault();
  fail("");
  const prompt = $("prompt").value;
  if (!prompt.trim() && !state.files.length) { fail("พิมพ์คำสั่งหรือแนบ Drawing ก่อน"); return; }
  if (!state.key) {
    if (state.files.length) {
      openPro("การอ่าน Drawing ต้องใช้ Claude คัดลอกคำสั่งให้แล้ว");
      return;
    }
    // Plain parts: read the command here, build, and hand over the STEP file in one click.
    const quick = quickPlan(prompt);
    if (quick.error) {
      openPro(`ระบบอ่านคำสั่งนี้เองไม่ได้: ${quick.error} หรือให้ Claude ออกแบบ คัดลอกคำสั่งให้แล้ว`);
      return;
    }
    busy("กำลังสร้างโมเดล");
    await nextFrame();
    try {
      const built = tryBuild(quick.plan);
      if (built.error) { openPro(`ระบบสร้างจากคำสั่งนี้ไม่ได้: ${built.error} ให้ Claude ออกแบบแทน คัดลอกคำสั่งให้แล้ว`); return; }
      show($("pro-flow"), false);
      await showJob(quick.plan, built.plan, built.result, prompt.trim());
    } catch (err) { fail(`เกิดข้อผิดพลาด: ${err.message}`); }
    finally { busy(""); }
    return;
  }
  busy(state.files.length ? "กำลังอ่าน Drawing และออกแบบ อาจใช้เวลา 1 ถึง 3 นาที" : "กำลังออกแบบ อาจใช้เวลาประมาณ 1 นาที");
  try {
    const blocks = [];
    for (const f of state.files) blocks.push(...(await toBlocks(f, state.DxfParser)));
    const r = await makePlan({
      key: state.key, model: state.model, system: state.system, schema: state.schema,
      prompt, blocks, currentPlan: state.job && $("modify").checked ? state.job.raw : null,
      onStatus: (t) => busy(t),
    });
    await showJob(r.raw, r.plan, r.result, prompt.trim() || `Drawing: ${state.files.map((f) => f.name).join(", ")}`);
    state.files = []; renderFiles();
  } catch (err) { fail(err instanceof AiError ? err.message : `เกิดข้อผิดพลาด: ${err.message}`); }
  finally { busy(""); }
};

// ---------- Claude Pro: copy the request into a chat, paste the answer back ----------
function chatPrompt() {
  const rules = state.system
    .replace(/and you always deliver it by calling the submit_cad_plan tool\. Never answer with the plan as text\./, "and you reply with the plan as one JSON code block.")
    .replace(/EXAMPLE of a valid plan:[\s\S]*$/, "");
  const example = (state.system.match(/EXAMPLE of a valid plan:\s*([\s\S]*)$/) || [])[1] || "";
  const current = state.job && $("modify").checked ? `\n\nCURRENT PLAN (change only what the request asks):\n${JSON.stringify(state.job.raw)}` : "";
  const drawing = state.files.length ? `\n\nThe drawing is attached to this message (${state.files.map((f) => f.name).join(", ")}).` : "";
  return `${rules.trim()}

${state.chatFormat.trim()}

EXAMPLE:
${example.trim()}

ANSWER FORMAT: reply with exactly one \`\`\`json code block holding the complete plan, then at most three short lines in Thai. No other code.${current}${drawing}

REQUEST:
${$("prompt").value.trim() || "Model the part shown in the attached drawing."}`;
}

async function copyText(text, note) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
  }
  const n = $("pro-note");
  n.textContent = note; show(n, true);
}

function openPro(reason = "") {
  show($("pro-flow"), true);
  $("pro-reason").textContent = reason;
  show($("pro-reason"), !!reason);
  show($("pro-attach"), state.files.length > 0);
  show($("pro-fix"), false);
  $("pro-flow").scrollIntoView({ behavior: "smooth", block: "start" });
  copyText(chatPrompt(), "คัดลอกคำสั่งแล้ว เปิด Claude แล้ววางในแชตใหม่ได้เลย");
}

function extractPlan(text) {
  if (!text.trim()) throw new Error("ยังไม่ได้วางคำตอบจาก Claude");
  if (text.includes("PLAN FORMAT (JSON") || text.includes("ANSWER FORMAT:")) {
    throw new Error("ข้อความที่วางคือคำสั่งที่เว็บคัดลอกไปให้ Claude ไม่ใช่คำตอบ ให้วางคำสั่งนี้ในแชตของ Claude ก่อน แล้วคัดลอกคำตอบของ Claude มาวางที่นี่");
  }
  // Try every code block, newest last, then the outermost braces.
  const blocks = [...text.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) blocks.push(text.slice(first, last + 1));
  let error = "ไม่พบโค้ด JSON ในคำตอบ";
  for (const body of blocks) {
    try {
      const value = JSON.parse(body);
      if (value && typeof value === "object" && Array.isArray(value.features)) return value;
      error = "JSON ในคำตอบไม่ใช่แผนชิ้นงาน (ไม่มี features)";
    } catch (e) { error = `อ่าน JSON ในคำตอบไม่ได้: ${e.message}`; }
  }
  throw new Error(error);
}

$("pro-copy").onclick = () => copyText(chatPrompt(), "คัดลอกคำสั่งแล้ว เปิด Claude แล้ววางในแชตใหม่ได้เลย");
$("pro-build").onclick = async () => {
  show($("pro-fix"), false); show($("pro-note"), false);
  let raw;
  try { raw = extractPlan($("pro-reply").value); }
  catch (e) {
    $("pro-error").textContent = e.message;
    show($("pro-fix"), true);
    show($("pro-copy-error"), !e.message.startsWith("ข้อความที่วาง") && !e.message.startsWith("ยังไม่ได้"));
    return;
  }
  busy("กำลังสร้างโมเดล");
  await nextFrame();
  try {
    const built = tryBuild(raw);
    if (built.error) { $("pro-error").textContent = built.error; show($("pro-fix"), true); show($("pro-copy-error"), true); return; }
    await showJob(raw, built.plan, built.result,
      $("prompt").value.trim() || (state.files.length ? `Drawing: ${state.files.map((f) => f.name).join(", ")}` : "แผนจาก Claude Pro"));
    $("pro-reply").value = "";
    state.files = []; renderFiles();
    $("pro-note").textContent = "สร้างโมเดลแล้ว"; show($("pro-note"), true);
  } finally { busy(""); }
};
$("pro-copy-error").onclick = () => copyText(
  `The plan could not be built. Fix it and reply with the complete corrected plan in one \`\`\`json block.\n\n${$("pro-error").textContent}`,
  "คัดลอกข้อผิดพลาดแล้ว วางในแชตเดิมของ Claude"
);

$("rebuild").onclick = () => buildRaw(state.job.raw, `${(state.job.source || state.job.plan.name).replace(/ \(แก้ขนาด\)$/, "")} (แก้ขนาด)`);
$("build-json").onclick = () => {
  let raw;
  try { raw = JSON.parse($("plan-json").value); } catch (e) { fail(`JSON ไม่ถูกต้อง: ${e.message}`); return; }
  buildRaw(raw, "แก้จาก JSON");
};
$("dl-step").onclick = () => download(state.job.step, `${safeName(state.job.plan.name)}.step`);
// ---------- .SLDPRT through SOLIDWORKS on this computer ----------
function localHelp(text) {
  $("sw-local-msg").textContent = text || "";
  show($("sw-local-help"), !!text);
  if (text) $("sw-local-help").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
async function refreshLocal() {
  const st = await localStatus();
  const cell = $("sw-local-state");
  if (st.blocked) cell.textContent = "เบราว์เซอร์บล็อกการเชื่อมต่อกับเครื่อง";
  else if (!st.running) cell.textContent = "ยังไม่พบแอปบนเครื่อง";
  else if (!st.sw.available) cell.textContent = st.sw.reason;
  else cell.textContent = `SOLIDWORKS ${st.sw.version} ในเครื่องนี้` + (st.sw.version > 2018 ? " (เปิดได้ใน " + st.sw.version + " ขึ้นไป)" : " เปิดได้ 2018 ขึ้นไป");
  return st;
}
$("dl-sldprt").onclick = async () => {
  localHelp(""); fail("");
  let st = await refreshLocal();
  if (st.blocked) { localHelp("เบราว์เซอร์บล็อกไม่ให้เว็บนี้เชื่อมต่อกับเครื่อง กดไอคอนหน้า URL > การตั้งค่าเว็บไซต์ แล้วอนุญาต \"อุปกรณ์ในเครือข่าย\" จากนั้นกดสร้างไฟล์อีกครั้ง"); return; }
  if (!st.running) {
    $("dl-sldprt").disabled = true;
    busy("กำลังเปิดแอปบนเครื่อง ถ้าเบราว์เซอร์ถาม ให้กดเปิด");
    try { st = await launchLocal(45000, (s) => busy(`กำลังเปิดแอปบนเครื่อง ถ้าเบราว์เซอร์ถาม ให้กดเปิด (รออีก ${s} วินาที)`)); }
    finally { busy(""); $("dl-sldprt").disabled = false; }
    await refreshLocal();
    if (!st.running) {
      localHelp(st.blocked
        ? "เบราว์เซอร์บล็อกไม่ให้เว็บนี้เชื่อมต่อกับเครื่อง กดไอคอนหน้า URL > การตั้งค่าเว็บไซต์ แล้วอนุญาต \"อุปกรณ์ในเครือข่าย\" จากนั้นกดสร้างไฟล์อีกครั้ง"
        : "เปิดแอปบนเครื่องไม่สำเร็จ ถ้าไม่มีหน้าต่างถามให้เปิด AUTO DESIGN 3D แปลว่ายังไม่ได้ลงทะเบียนลิงก์ ทำตามข้อ 1 ด้านล่าง ถ้ามีหน้าต่างถามและกดเปิดแล้ว ให้ลองเปิด start.bat แทนแล้วกดสร้างไฟล์อีกครั้ง");
      return;
    }
  }
  if (!st.sw.available) { localHelp(st.sw.reason); return; }
  busy(`SOLIDWORKS ${st.sw.version} กำลังสร้างทีละฟีเจอร์ อาจใช้เวลา 1 ถึง 2 นาที`);
  $("dl-sldprt").disabled = true;
  try {
    const r = await localSldprt(state.job.raw);
    download(r.blob, r.name);
    $("sw-local-state").textContent = r.ok ? `ได้ ${r.name} แล้ว` : r.message;
    if (!r.ok) fail(r.message);
  } catch (e) {
    if (e instanceof LocalError) localHelp(e.message); else fail(`เกิดข้อผิดพลาด: ${e.message}`);
  } finally { busy(""); $("dl-sldprt").disabled = false; }
};

$("dl-sw").onclick = () => {
  const name = safeName(state.job.plan.name);
  // The _AD3D suffix lets the AUTO_DESIGN_3D.swb toolbar macro find the newest download.
  download(new Blob([state.job.macro], { type: "text/plain" }), `${name}_AD3D.swb`);
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

// ---------- settings ----------
function openSettings() {
  show($("settings-error"), false);
  $("remember").checked = !!store.get(KEY_STORE);
  $("settings").showModal();
}
$("open-settings").onclick = openSettings;
$("close-settings").onclick = () => $("settings").close();
$("settings-form").onsubmit = (e) => {
  e.preventDefault();
  const key = $("api-key").value.trim();
  if (key && !/^[A-Za-z0-9_-]{20,300}$/.test(key)) {
    $("settings-error").textContent = "รูปแบบ API key ไม่ถูกต้อง";
    show($("settings-error"), true);
    return;
  }
  if (key) state.key = key;
  state.model = $("model").value;
  store.set(MODEL_STORE, state.model);
  store.set(KEY_STORE, $("remember").checked ? state.key : "");
  $("api-key").value = "";
  refreshStatus();
  $("settings").close();
};

// history.html links here with ?open=<id>
function openFromHistory() {
  const id = new URLSearchParams(location.search).get("open");
  if (!id) return;
  history.replaceState(null, "", location.pathname);
  const entry = getEntry(id);
  if (!entry) { fail("ไม่พบงานนี้ในประวัติแล้ว"); return; }
  state.job = { source: entry.source };
  buildRaw(structuredClone(entry.raw));
}

(async () => {
  state.key = store.get(KEY_STORE);
  state.model = MODELS.includes(store.get(MODEL_STORE)) ? store.get(MODEL_STORE) : MODELS[0];
  $("model").replaceChildren(...MODELS.map((m) => new Option(m, m, false, m === state.model)));
  refreshStatus();
  try {
    const names = await fetch("examples/index.json").then((r) => r.json());
    const examples = await Promise.all(names.map((n) => fetch(`examples/${n}`).then((r) => r.json())));
    $("examples").replaceChildren(...examples.map((x) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = x.description || x.name;
      b.onclick = () => { if (state.kernel) buildRaw(structuredClone(x), `ตัวอย่าง: ${x.description || x.name}`); };
      return b;
    }));
    await loadKernel();
    openFromHistory();
  } catch (e) {
    state.kernelError = true;
    fail(`โหลดตัวสร้างโมเดลไม่ได้: ${e.message}`);
  }
  refreshStatus();
})();
