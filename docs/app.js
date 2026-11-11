import { Viewer } from "./js/viewer.js";
import { useKernel, stepBlob, verifyStep, meshOf } from "./js/cad.js";
import { useHelpers, render as renderMacro } from "./js/macro.js";
import { MODELS, makePlan, toBlocks, tryBuild, AiError } from "./js/ai.js";
import { quickPlan } from "./js/quick.js";
import { addEntry, getEntry, loadHistory } from "./js/history.js";
import { task } from "./js/progress.js";
import { localStatus, localSldprt, launchLocal, LocalError } from "./js/local.js";

const $ = (id) => document.getElementById(id);
const VIEW_NAMES = { iso: "Isometric", front: "Front", top: "Top", right: "Right" };
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
function fail(message) {
  $("error").textContent = message; show($("error"), !!message);
  if (message && task.running) task.fail(message);
}
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
  ai.textContent = state.key ? "Claude API ready" : "Claude Pro via chat";
  ai.title = state.key ? `Using ${state.model}` : "No API key, Claude Pro chat is used instead";
  const cad = $("st-cad");
  cad.className = "state " + (state.kernel ? "on" : state.kernelError ? "off" : "wait");
  cad.textContent = state.kernel ? "CAD engine ready" : state.kernelError ? "CAD engine failed to load" : "Loading CAD engine";
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
    del.type = "button"; del.textContent = "Remove";
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
  if (!task.running) task.start(source || plan.name);
  await task.ticks(plan.features.map((f) => f.name || f.id), 30, 70);
  await task.step("Write STEP AP203 file", 76);
  const step = stepBlob(result, plan.name);
  await task.step("Check STEP volume against the model", 86);
  const verify = await verifyStep(step, result.volume_mm3);
  await task.step("Prepare SOLIDWORKS macro", 94);
  state.job = { raw, plan, result, step, macro: renderMacro(result.steps, plan.name), source: source || state.job?.source || "" };
  document.body.classList.add("has-model");
  show($("rebuild"), false);
  show($("empty"), false);
  show($("no-model"), false);
  show($("details"), true);
  show($("title-block"), true);
  for (const id of ["dl-step", "dl-sldprt", "dl-sw"]) $(id).disabled = false;
  if (!document.body.classList.contains("seen-model")) { $("sw-setup").open = false; document.body.classList.add("seen-model"); }
  show($("modify-row"), true);

  $("tb-name").textContent = plan.name;
  $("tb-size").textContent = result.size.map((v) => fmt(v)).join(" × ");
  $("tb-vol").textContent = fmt(result.volume_mm3 / 1000);
  $("tb-mass").textContent = fmt(result.mass_g);
  const v = $("tb-verify");
  v.textContent = verify.ok ? "Passed" : `Off by ${verify.diff_percent}%`;
  v.className = `pill ${verify.ok ? "ok" : "bad"}`;

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
    renderRecent(true);
  }
  await task.done(plan.name);
  if (matchMedia("(max-width: 860px)").matches) document.querySelector(".stage").scrollIntoView({ behavior: "smooth", block: "start" });
}

// The last few builds, newest first, under the composer.
function renderRecent(fresh = false) {
  const items = loadHistory().slice(0, 3);
  show($("recent-box"), items.length > 0);
  $("recent").replaceChildren(...items.map((e, i) => {
    const li = document.createElement("li");
    if (fresh && i === 0) li.className = "fresh";
    const name = document.createElement("span"); name.className = "r-name"; name.textContent = e.source || e.name; name.title = e.source || e.name;
    const pill = document.createElement("span"); pill.className = "pill ok"; pill.textContent = "Completed";
    const a = document.createElement("a"); a.href = `./?open=${encodeURIComponent(e.id)}`; a.textContent = "See details";
    a.onclick = (ev) => { ev.preventDefault(); state.job = { source: e.source }; buildRaw(structuredClone(e.raw), null, e.source || e.name); };
    li.append(name, pill, a);
    return li;
  }));
}

function renderDims(raw, plan) {
  const rows = plan.parameters.map((p, i) => {
    const tr = document.createElement("tr");
    if (p.confidence === "low") tr.className = "low";
    const a = document.createElement("td");
    a.textContent = p.label || p.name;
    if (p.confidence === "low") {
      const tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = "Estimate, please check";
      a.append(" ", tag);
    }
    if (p.source) { const s = document.createElement("small"); s.textContent = p.source; a.append(s); }
    const b = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number"; input.step = "any"; input.value = +p.value.toFixed(4);
    input.setAttribute("aria-label", p.label || p.name);
    const src = raw.parameters[i];
    if (typeof src.value === "string" && src.value.startsWith("=")) {
      input.disabled = true; input.title = `Calculated from ${src.value.slice(1)}`;
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
    td.colSpan = 2; td.textContent = "This plan has no editable dimensions"; tr.append(td); rows.push(tr);
  }
  $("dims").replaceChildren(...rows);
}

async function buildRaw(raw, source, title) {
  fail(""); busy("Building the model");
  task.start(title || source || raw.name || "Part");
  await task.step("Check the plan", 12);
  await task.step("Build the 3D model", 25);
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
  if (!prompt.trim() && !state.files.length) { fail("Type a command or attach a drawing first"); return; }
  if (!state.key) {
    if (state.files.length) {
      task.start(prompt.trim() || `Drawing: ${state.files.map((f) => f.name).join(", ")}`);
      await task.step("Copy the request and open Claude", 8, 0);
      await openPro("Reading a drawing needs Claude. The request is copied and Claude is open in a new tab");
      openClaude();
      task.pause("Waiting for Claude", "Paste the request in Claude, attach the drawing and send. Copy the answer and come back here");
      return;
    }
    // Plain parts: read the command here, build, and hand over the STEP file in one click.
    task.start(prompt.trim());
    await task.step("Read the command (no AI)", 8, 0);
    const quick = quickPlan(prompt);
    if (quick.error) {
      openPro(`This command could not be read here: ${quick.error}. Let Claude design it, the request is copied`);
      task.pause("Handed to Claude", "This part needs Claude. Paste the copied request in a Claude chat");
      return;
    }
    await task.step(`Plan ${quick.plan.features.length} features`, 16);
    await task.step("Build the 3D model", 25);
    busy("Building the model");
    try {
      const built = tryBuild(quick.plan);
      if (built.error) {
        openPro(`This command could not be built here: ${built.error}. Let Claude design it, the request is copied`);
        task.pause("Handed to Claude", "This command could not be built here. Paste the copied request in a Claude chat");
        return;
      }
      show($("pro-flow"), false);
      await showJob(quick.plan, built.plan, built.result, prompt.trim());
    } catch (err) { fail(`Something went wrong: ${err.message}`); }
    finally { busy(""); }
    return;
  }
  busy(state.files.length ? "Reading the drawing and designing, 1 to 3 minutes" : "Designing, about 1 minute");
  task.start(prompt.trim() || `Drawing: ${state.files.map((f) => f.name).join(", ")}`);
  await task.step(state.files.length ? "Send the drawing to Claude" : "Send the command to Claude", 6, 0);
  let aiPct = 8;
  try {
    const blocks = [];
    for (const f of state.files) blocks.push(...(await toBlocks(f, state.DxfParser)));
    const r = await makePlan({
      key: state.key, model: state.model, system: state.system, schema: state.schema,
      prompt, blocks, currentPlan: state.job && $("modify").checked ? state.job.raw : null,
      onStatus: (t) => { busy(t); aiPct = Math.min(26, aiPct + 4); task.step(t, aiPct, 0); },
    });
    await showJob(r.raw, r.plan, r.result, prompt.trim() || `Drawing: ${state.files.map((f) => f.name).join(", ")}`);
    state.files = []; renderFiles();
  } catch (err) { fail(err instanceof AiError ? err.message : `Something went wrong: ${err.message}`); }
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

ANSWER FORMAT: reply with exactly one \`\`\`json code block holding the complete plan, then at most three short lines in English. No other code.${current}${drawing}

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

// Opens a new Claude chat and waits for the answer to come back on the clipboard.
function openClaude() {
  state.awaitingReply = true;
  const w = window.open("https://claude.ai/new", "_blank");
  if (!w) { $("pro-note").textContent = "The browser blocked the new tab. Click Open Claude instead"; show($("pro-note"), true); }
}

// When the user comes back from Claude with the answer copied, build it straight away.
async function pickUpReply() {
  if (!state.awaitingReply || document.visibilityState !== "visible" || $("pro-flow").hidden) return;
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch { return; } // not allowed: the user pastes instead
  if (!text || text === state.lastPicked || text.includes("ANSWER FORMAT:")) return;
  try { extractPlan(text); } catch { return; }
  state.lastPicked = text;
  $("pro-reply").value = text;
  $("pro-build").click();
}
window.addEventListener("focus", () => setTimeout(pickUpReply, 150));
document.addEventListener("visibilitychange", () => setTimeout(pickUpReply, 150));
$("pro-reply").addEventListener("paste", () => setTimeout(() => {
  try { extractPlan($("pro-reply").value); } catch { return; }
  $("pro-build").click();
}, 0));
$("pro-open").onclick = () => { state.awaitingReply = true; };

function openPro(reason = "") {
  show($("pro-flow"), true);
  $("pro-reason").textContent = reason;
  show($("pro-reason"), !!reason);
  show($("pro-attach"), state.files.length > 0);
  show($("pro-fix"), false);
  $("pro-flow").scrollIntoView({ behavior: "smooth", block: "start" });
  return copyText(chatPrompt(), state.files.length
    ? "Request copied. In Claude press Ctrl+V, attach the drawing and send"
    : "Request copied. Paste it into a new Claude chat");
}

function extractPlan(text) {
  if (!text.trim()) throw new Error("Paste Claude's answer first");
  if (text.includes("PLAN FORMAT (JSON") || text.includes("ANSWER FORMAT:")) {
    throw new Error("That is the request for Claude, not the answer. Paste it in Claude first, then copy Claude's answer back here");
  }
  // Try every code block, newest last, then the outermost braces.
  const blocks = [...text.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) blocks.push(text.slice(first, last + 1));
  let error = "No JSON found in the answer";
  for (const body of blocks) {
    try {
      const value = JSON.parse(body);
      if (value && typeof value === "object" && Array.isArray(value.features)) return value;
      error = "The JSON in the answer is not a part plan (no features)";
    } catch (e) { error = `Could not read the JSON in the answer: ${e.message}`; }
  }
  throw new Error(error);
}

$("pro-copy").onclick = () => copyText(chatPrompt(), "Request copied. Paste it into a new Claude chat");
$("pro-build").onclick = async () => {
  show($("pro-fix"), false); show($("pro-note"), false);
  task.start($("prompt").value.trim() || (state.files.length ? `Drawing: ${state.files.map((f) => f.name).join(", ")}` : "Plan from Claude Pro"));
  await task.step("Read Claude's answer", 10, 0);
  let raw;
  try { raw = extractPlan($("pro-reply").value); }
  catch (e) {
    task.fail(e.message);
    $("pro-error").textContent = e.message;
    show($("pro-fix"), true);
    show($("pro-copy-error"), !e.message.startsWith("That is the request") && !e.message.startsWith("Paste Claude"));
    return;
  }
  await task.step("Build the 3D model", 25);
  busy("Building the model");
  try {
    const built = tryBuild(raw);
    if (built.error) { task.fail(built.error); $("pro-error").textContent = built.error; show($("pro-fix"), true); show($("pro-copy-error"), true); return; }
    await showJob(raw, built.plan, built.result,
      $("prompt").value.trim() || (state.files.length ? `Drawing: ${state.files.map((f) => f.name).join(", ")}` : "Plan from Claude Pro"));
    $("pro-reply").value = "";
    state.awaitingReply = false;
    state.files = []; renderFiles();
    show($("pro-flow"), false);
  } finally { busy(""); }
};
$("pro-copy-error").onclick = () => copyText(
  `The plan could not be built. Fix it and reply with the complete corrected plan in one \`\`\`json block.\n\n${$("pro-error").textContent}`,
  "Error copied. Paste it in the same Claude chat"
);

$("rebuild").onclick = () => buildRaw(state.job.raw, `${(state.job.source || state.job.plan.name).replace(/ \((?:แก้ขนาด|edited)\)$/, "")} (edited)`);
$("build-json").onclick = () => {
  let raw;
  try { raw = JSON.parse($("plan-json").value); } catch (e) { fail(`Invalid JSON: ${e.message}`); return; }
  buildRaw(raw, "Edited JSON plan");
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
  if (st.blocked) cell.textContent = "Browser blocked local access";
  else if (!st.running) cell.textContent = "Desktop app not found";
  else if (!st.sw.available) cell.textContent = st.sw.reason;
  else cell.textContent = `SOLIDWORKS ${st.sw.version} on this PC, opens in ${st.sw.version}+`;
  return st;
}
$("dl-sldprt").onclick = async () => {
  localHelp(""); fail("");
  let st = await refreshLocal();
  if (st.blocked) { localHelp("The browser blocks this site from reaching your PC. Click the icon left of the address, open Site settings, allow local network access, then try again"); return; }
  if (!st.running) {
    $("dl-sldprt").disabled = true;
    busy("Starting the desktop app. Click Open if the browser asks");
    try { st = await launchLocal(45000, (s) => busy(`Starting the desktop app. Click Open if the browser asks (${s} s left)`)); }
    finally { busy(""); $("dl-sldprt").disabled = false; }
    await refreshLocal();
    if (!st.running) {
      localHelp(st.blocked
        ? "The browser blocks this site from reaching your PC. Click the icon left of the address, open Site settings, allow local network access, then try again"
        : "The desktop app did not start. If the browser never asked to open AUTO DESIGN 3D, do step 1 below. If it did, run start.bat and try again");
      return;
    }
  }
  if (!st.sw.available) { localHelp(st.sw.reason); return; }
  busy(`SOLIDWORKS ${st.sw.version} is building each feature, 1 to 2 minutes`);
  $("dl-sldprt").disabled = true;
  try {
    const r = await localSldprt(state.job.raw);
    download(r.blob, r.name);
    $("sw-local-state").textContent = r.ok ? `Saved ${r.name}` : r.message;
    if (!r.ok) fail(r.message);
  } catch (e) {
    if (e instanceof LocalError) localHelp(e.message); else fail(`Something went wrong: ${e.message}`);
  } finally { busy(""); $("dl-sldprt").disabled = false; }
};

$("open-help").onclick = (e) => {
  e.preventDefault();
  $("sw-setup").open = true;
  $("sw-setup").scrollIntoView({ behavior: "smooth", block: "start" });
};
$("copy-launcher").onclick = async () => {
  const b = $("copy-launcher");
  try {
    const code = await fetch("assets/AUTO_DESIGN_3D.swb").then((r) => r.text());
    try { await navigator.clipboard.writeText(code); }
    catch {
      const t = document.createElement("textarea");
      t.value = code; document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
    }
    b.textContent = "Copied";
  } catch { b.textContent = "Copy failed, try again"; }
  setTimeout(() => { b.textContent = "Copy launcher code"; }, 2500);
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
    $("settings-error").textContent = "That does not look like an API key";
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
  if (!entry) { fail("This part is no longer in the history"); return; }
  state.job = { source: entry.source };
  buildRaw(structuredClone(entry.raw), null, entry.source || entry.name);
}

(async () => {
  state.key = store.get(KEY_STORE);
  state.model = MODELS.includes(store.get(MODEL_STORE)) ? store.get(MODEL_STORE) : MODELS[0];
  $("model").replaceChildren(...MODELS.map((m) => new Option(m, m, false, m === state.model)));
  refreshStatus();
  renderRecent();
  try {
    const names = await fetch("examples/index.json").then((r) => r.json());
    const examples = await Promise.all(names.map((n) => fetch(`examples/${n}`).then((r) => r.json())));
    $("examples").replaceChildren(...examples.map((x) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = x.description || x.name;
      b.onclick = () => { if (state.kernel) buildRaw(structuredClone(x), `Sample: ${x.description || x.name}`); };
      return b;
    }));
    await loadKernel();
    openFromHistory();
  } catch (e) {
    state.kernelError = true;
    fail(`The CAD engine failed to load: ${e.message}`);
  }
  refreshStatus();
})();
