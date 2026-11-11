// Talks to the AUTO DESIGN 3D app running on this computer (start.bat), which drives
// the installed SOLIDWORKS and sends back a native .SLDPRT with a Feature Tree.
export const LOCAL = "http://127.0.0.1:8765";

export class LocalError extends Error {}

export async function localStatus(timeoutMs = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${LOCAL}/api/status`, { signal: ctrl.signal });
    if (!r.ok) return { running: true, sw: { available: false, reason: "แอปบนเครื่องไม่อนุญาตให้เว็บนี้เชื่อมต่อ อัปเดตแอปเป็นรุ่นล่าสุด" } };
    const data = await r.json();
    return { running: true, sw: data.solidworks || { available: false, reason: "แอปบนเครื่องเป็นรุ่นเก่า" } };
  } catch {
    return { running: false };
  } finally { clearTimeout(t); }
}

export async function localSldprt(raw) {
  let r;
  try {
    r = await fetch(`${LOCAL}/api/web/sldprt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: raw }),
    });
  } catch {
    throw new LocalError("เชื่อมต่อแอปบนเครื่องไม่ได้ เปิด start.bat ทิ้งไว้แล้วลองใหม่");
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new LocalError(data.error || `แอปบนเครื่องตอบกลับผิดพลาด (${r.status})`);
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
