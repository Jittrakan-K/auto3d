// Talks to the AUTO DESIGN 3D app running on this computer (start.bat), which drives
// the installed SOLIDWORKS and sends back a native .SLDPRT with a Feature Tree.
export const LOCAL = "http://127.0.0.1:8765";

export class LocalError extends Error {}

// A long timeout on purpose: the first request can wait on the browser's
// "allow this site to reach devices on this computer" question. A refused
// connection (app not running) still fails at once.
export async function localStatus(timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${LOCAL}/api/status`, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return { running: true, sw: { available: false, reason: "The desktop app refused this site. Update the app with update.bat" } };
    const data = await r.json();
    return { running: true, sw: data.solidworks || { available: false, reason: "The desktop app is out of date. Run update.bat" } };
  } catch {
    return { running: false, blocked: await accessDenied() };
  } finally { clearTimeout(t); }
}

// True when the user (or a policy) has blocked this site from reaching the computer.
async function accessDenied() {
  for (const name of ["local-network-access", "loopback-network", "local-network"]) {
    try { if ((await navigator.permissions.query({ name })).state === "denied") return true; } catch { /* not supported */ }
  }
  return false;
}

// Ask Windows to start the app through the autodesign3d:// link (registered by
// install.bat or setup_web_link.bat), then wait until it answers.
export async function launchLocal(waitMs = 45000, onTick = () => {}) {
  window.location.href = "autodesign3d://start";
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    onTick(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    const st = await localStatus(10000);
    if (st.running || st.blocked) return st;
  }
  return { running: false };
}

// The desktop app does not know the web-only fields yet (Hole Wizard details, check).
function forDesktop(raw) {
  const plan = JSON.parse(JSON.stringify(raw));
  delete plan.check;
  for (const f of plan.features || []) for (const k of ["thread", "tap_type", "thread_depth", "screw", "end"]) delete f[k];
  return plan;
}

export async function localSldprt(raw) {
  let r;
  try {
    r = await fetch(`${LOCAL}/api/web/sldprt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: forDesktop(raw) }),
    });
  } catch {
    throw new LocalError("Could not reach the desktop app. Start start.bat and try again");
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new LocalError(data.error || `The desktop app returned an error (${r.status})`);
  }
  const cd = r.headers.get("content-disposition") || "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  return {
    blob: await r.blob(),
    name: m ? decodeURIComponent(m[1]) : "part.SLDPRT",
    ok: r.headers.get("x-sw-ok") === "1",
    year: Number(r.headers.get("x-sw-year")) || null,
    message: decodeURIComponent(r.headers.get("x-sw-message") || ""),
  };
}
