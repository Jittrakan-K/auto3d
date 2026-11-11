// The task card and progress bar. Each step is a real phase of the build; the short
// minimum time per step only keeps fast steps readable, it never stands in for work.
const $ = (id) => document.getElementById(id);
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, calm() ? 0 : ms));

let current = null;   // the <li> being worked on
let lastAt = 0;
let pct = 0;
let running = false;

function setStage(title, sub, working) {
  const t = $("stage-title");
  if (t.textContent !== title) { t.textContent = title; t.classList.remove("swap"); void t.offsetWidth; t.classList.add("swap"); }
  t.classList.toggle("working", !!working);
  if (sub != null) $("stage-sub").textContent = sub;
}

function setPill(kind, text) {
  const p = $("task-pill");
  p.className = `pill ${kind} swap`;
  p.replaceChildren();
  if (kind === "run") { const s = document.createElement("i"); s.className = "spin"; p.append(s); }
  const t = document.createElement("span"); t.textContent = text; p.append(t);
}

function setPercent(value, label) {
  pct = Math.max(pct, Math.min(100, Math.round(value)));
  $("progress-bar").style.width = `${pct}%`;
  const out = $("progress-pct");
  const from = Number(out.textContent) || 0, to = pct, t0 = performance.now();
  const tick = (now) => {
    const k = calm() ? 1 : Math.min(1, (now - t0) / 400);
    out.textContent = String(Math.round(from + (to - from) * k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (label) $("progress-label").textContent = label;
}

function item(text, cls) {
  const li = document.createElement("li");
  li.className = cls;
  const m = document.createElement("span"); m.className = "mark"; m.setAttribute("aria-hidden", "true");
  const s = document.createElement("span"); s.textContent = text;
  li.append(m, s);
  $("task-steps").append(li);
  return li;
}

export const task = {
  get running() { return running; },

  start(title) {
    running = true;
    pct = 0;
    current = null;
    lastAt = performance.now();
    $("task-title").textContent = title;
    $("task-steps").replaceChildren();
    const card = $("task");
    card.hidden = false;
    card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";
    setPill("run", "กำลังทำงาน");
    document.querySelector(".progress").classList.remove("done", "fail");
    $("progress-bar").style.width = "0%";
    $("progress-pct").textContent = "0";
    setStage("Building your part", "Each feature is built in order, then the files are checked", true);
    setPercent(2, title);
  },

  // Finish the step in progress and begin the next one.
  async step(text, percent, minMs = 260) {
    if (!running) return;
    const left = minMs - (performance.now() - lastAt);
    if (left > 0) await wait(left);
    if (current) current.className = current.className.replace("now", "done");
    current = item(text, "now");
    lastAt = performance.now();
    if (percent != null) setPercent(percent, text);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  },

  // Items that are already finished, e.g. each feature the kernel built.
  async ticks(texts, fromPct, toPct, gapMs = 90) {
    if (!running) return;
    for (let i = 0; i < texts.length; i++) {
      await wait(gapMs);
      item(texts[i], "sub done");
      setPercent(fromPct + ((toPct - fromPct) * (i + 1)) / texts.length);
    }
  },

  async done(name) {
    if (!running) return;
    await wait(Math.max(0, 220 - (performance.now() - lastAt)));
    if (current) current.className = current.className.replace("now", "done");
    current = null;
    running = false;
    setPill("ok", "เสร็จแล้ว");
    setPercent(100, `${name} is ready`);
    document.querySelector(".progress").classList.add("done");
    setStage("Part ready", "Check the dimensions on the right, then download the files below", false);
  },

  fail(message) {
    if (!running) return;
    running = false;
    if (current) current.className = current.className.replace("now", "fail");
    else item(message, "fail");
    current = null;
    setPill("bad", "ไม่สำเร็จ");
    document.querySelector(".progress").classList.add("fail");
    $("progress-label").textContent = "Build failed";
    setStage("Could not build", message.length > 140 ? message.slice(0, 140) + "…" : message, false);
  },

  // Waiting on the user (e.g. answering in Claude), not on the computer.
  pause(title, sub) {
    if (current) current.className = current.className.replace("now", "done");
    current = null;
    running = false;
    setPill("run", "รอคำตอบ");
    setStage(title, sub, false);
  },
};
