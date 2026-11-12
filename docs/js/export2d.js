// Writers for the drawing primitives from drawing.js: SVG (preview), DXF R12 (opens in
// SOLIDWORKS, AutoCAD, DraftSight) and PDF (print). All take sheet millimetres, y up.

const STYLE = {
  outline: { w: 0.5, color: "#1e1b33", dash: null, dxf: 7 },
  hidden: { w: 0.25, color: "#1e1b33", dash: [2, 1], dxf: 8 },
  center: { w: 0.18, color: "#5b4ad8", dash: [6, 1.5, 1, 1.5], dxf: 5 },
  dim: { w: 0.18, color: "#3b3ba8", dash: null, dxf: 4 },
  border: { w: 0.35, color: "#1e1b33", dash: null, dxf: 7 },
  text: { w: 0.18, color: "#1e1b33", dash: null, dxf: 7 },
  label: { w: 0.18, color: "#706c8c", dash: null, dxf: 8 },
};
const nice = (v) => String(+v.toFixed(4));
const glyphs = (s) => s.replace(/%%c/g, "Ø");

// ---------- SVG ----------
export function toSVG(d, { forScreen = false } = {}) {
  const [W, H] = d.size;
  const Y = (y) => H - y;
  const out = [];
  for (const p of d.prims) {
    const st = STYLE[p.layer] || STYLE.outline;
    const stroke = `stroke="${st.color}" stroke-width="${st.w}"${st.dash ? ` stroke-dasharray="${st.dash.join(" ")}"` : ""}`;
    if (p.t === "line") out.push(`<line x1="${nice(p.a[0])}" y1="${nice(Y(p.a[1]))}" x2="${nice(p.b[0])}" y2="${nice(Y(p.b[1]))}" ${stroke}/>`);
    else if (p.t === "circle") out.push(`<circle cx="${nice(p.c[0])}" cy="${nice(Y(p.c[1]))}" r="${nice(p.r)}" fill="none" ${stroke}/>`);
    else if (p.t === "arc") {
      const a0 = (p.a0 * Math.PI) / 180, a1 = (p.a1 * Math.PI) / 180;
      const x0 = p.c[0] + p.r * Math.cos(a0), y0 = p.c[1] + p.r * Math.sin(a0);
      const x1 = p.c[0] + p.r * Math.cos(a1), y1 = p.c[1] + p.r * Math.sin(a1);
      const large = ((p.a1 - p.a0) % 360 + 360) % 360 > 180 ? 1 : 0;
      // Counter-clockwise with y up turns clockwise once y is flipped: sweep flag 1.
      out.push(`<path d="M${nice(x0)} ${nice(Y(y0))}A${nice(p.r)} ${nice(p.r)} 0 ${large} 1 ${nice(x1)} ${nice(Y(y1))}" fill="none" ${stroke}/>`);
    } else if (p.t === "solid") out.push(`<polygon points="${p.pts.map((q) => `${nice(q[0])},${nice(Y(q[1]))}`).join(" ")}" fill="${st.color}"/>`);
    else if (p.t === "text") {
      const anchor = p.anchor || "start";
      const rot = p.rot ? ` transform="rotate(${-p.rot} ${nice(p.p[0])} ${nice(Y(p.p[1]))})"` : "";
      out.push(`<text x="${nice(p.p[0])}" y="${nice(Y(p.p[1]))}" font-size="${p.h * 1.4}" text-anchor="${anchor}" fill="${st.color}"${rot}>${esc(glyphs(p.s))}</text>`);
    }
  }
  const size = forScreen ? `width="100%" height="100%"` : `width="${W}mm" height="${H}mm"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ${size} font-family="Inter, Arial, Helvetica, sans-serif" stroke-linecap="round"><rect width="${W}" height="${H}" fill="#fff"/>${out.join("")}</svg>`;
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// ---------- DXF R12 ----------
export function toDXF(d) {
  const L = [];
  const g = (code, v) => L.push(String(code), String(v));
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$EXTMIN"); g(10, 0); g(20, 0);
  g(9, "$EXTMAX"); g(10, d.size[0]); g(20, d.size[1]);
  g(9, "$MEASUREMENT"); g(70, 1);
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  const ltypes = [["CONTINUOUS", "Solid line", []], ["HIDDEN", "Hidden __ __ __", [2, -1]], ["CENTER", "Center ____ _ ____", [6, -1.5, 1, -1.5]]];
  g(0, "TABLE"); g(2, "LTYPE"); g(70, ltypes.length);
  for (const [name, desc, pat] of ltypes) {
    g(0, "LTYPE"); g(2, name); g(70, 0); g(3, desc); g(72, 65); g(73, pat.length);
    g(40, pat.reduce((a, b) => a + Math.abs(b), 0));
    for (const e of pat) g(49, e);
  }
  g(0, "ENDTAB");
  const layers = Object.entries(STYLE).map(([k, v]) => [k.toUpperCase(), v.dxf, k === "hidden" ? "HIDDEN" : k === "center" ? "CENTER" : "CONTINUOUS"]);
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
  for (const [name, color, lt] of layers) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, lt); }
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "STYLE"); g(70, 1);
  g(0, "STYLE"); g(2, "STANDARD"); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, "txt"); g(4, "");
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const p of d.prims) {
    const layer = (p.layer || "outline").toUpperCase();
    if (p.t === "line") { g(0, "LINE"); g(8, layer); g(10, nice(p.a[0])); g(20, nice(p.a[1])); g(30, 0); g(11, nice(p.b[0])); g(21, nice(p.b[1])); g(31, 0); }
    else if (p.t === "circle") { g(0, "CIRCLE"); g(8, layer); g(10, nice(p.c[0])); g(20, nice(p.c[1])); g(30, 0); g(40, nice(p.r)); }
    else if (p.t === "arc") { g(0, "ARC"); g(8, layer); g(10, nice(p.c[0])); g(20, nice(p.c[1])); g(30, 0); g(40, nice(p.r)); g(50, nice(((p.a0 % 360) + 360) % 360)); g(51, nice(((p.a1 % 360) + 360) % 360)); }
    else if (p.t === "solid") {
      const [a, b, c] = p.pts;
      g(0, "SOLID"); g(8, layer);
      g(10, nice(a[0])); g(20, nice(a[1])); g(30, 0); g(11, nice(b[0])); g(21, nice(b[1])); g(31, 0);
      g(12, nice(c[0])); g(22, nice(c[1])); g(32, 0); g(13, nice(c[0])); g(23, nice(c[1])); g(33, 0);
    } else if (p.t === "text") {
      const align = { start: 0, middle: 1, end: 2 }[p.anchor || "start"];
      g(0, "TEXT"); g(8, layer); g(10, nice(p.p[0])); g(20, nice(p.p[1])); g(30, 0); g(40, p.h); g(1, p.s.replace(/[^\x20-\x7e]/g, "?"));
      if (p.rot) g(50, p.rot);
      g(7, "STANDARD");
      if (align) { g(72, align); g(11, nice(p.p[0])); g(21, nice(p.p[1])); g(31, 0); }
    }
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return L.join("\r\n") + "\r\n";
}

// ---------- PDF ----------
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const winAnsi = (s) => [...glyphs(s)].map((ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : 63; });
const textWidth = (codes, size) => codes.reduce((w, c) => w + (c >= 32 && c <= 126 ? HELV[c - 32] : c === 0xd8 ? 778 : 556), 0) * size / 1000;

export function toPDF(d) {
  const k = 72 / 25.4;
  const [W, H] = d.size;
  const f = (v) => (+(v * k).toFixed(3)).toString();
  const ops = ["1 J 1 j"];
  let cur = "";
  const setStyle = (st, fill = false) => {
    const key = `${st.w}|${st.color}|${st.dash}|${fill}`;
    if (key === cur) return;
    cur = key;
    const [r, gg, b] = [1, 3, 5].map((i) => (parseInt(st.color.slice(i, i + 2), 16) / 255).toFixed(3));
    ops.push(`${f(st.w)} w ${r} ${gg} ${b} RG ${r} ${gg} ${b} rg ${st.dash ? `[${st.dash.map(f).join(" ")}] 0 d` : "[] 0 d"}`);
  };
  const arcPath = (cx, cy, r, a0, a1) => {
    // Bezier pieces of at most 90 degrees.
    const parts = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
    const step = (a1 - a0) / parts, kk = (4 / 3) * Math.tan(step / 4);
    let s = `${f(cx + r * Math.cos(a0))} ${f(cy + r * Math.sin(a0))} m`;
    for (let i = 0; i < parts; i++) {
      const t0 = a0 + i * step, t1 = t0 + step;
      const p1 = [cx + r * (Math.cos(t0) - kk * Math.sin(t0)), cy + r * (Math.sin(t0) + kk * Math.cos(t0))];
      const p2 = [cx + r * (Math.cos(t1) + kk * Math.sin(t1)), cy + r * (Math.sin(t1) - kk * Math.cos(t1))];
      s += ` ${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])} ${f(cx + r * Math.cos(t1))} ${f(cy + r * Math.sin(t1))} c`;
    }
    return s;
  };
  for (const p of d.prims) {
    const st = STYLE[p.layer] || STYLE.outline;
    if (p.t === "line") { setStyle(st); ops.push(`${f(p.a[0])} ${f(p.a[1])} m ${f(p.b[0])} ${f(p.b[1])} l S`); }
    else if (p.t === "circle") { setStyle(st); ops.push(arcPath(p.c[0], p.c[1], p.r, 0, 2 * Math.PI) + " S"); }
    else if (p.t === "arc") {
      setStyle(st);
      let a0 = (p.a0 * Math.PI) / 180, a1 = (p.a1 * Math.PI) / 180;
      while (a1 <= a0) a1 += 2 * Math.PI;
      ops.push(arcPath(p.c[0], p.c[1], p.r, a0, a1) + " S");
    } else if (p.t === "solid") { setStyle({ ...st, dash: null }, true); ops.push(`${p.pts.map((q, i) => `${f(q[0])} ${f(q[1])} ${i ? "l" : "m"}`).join(" ")} h f`); }
    else if (p.t === "text") {
      setStyle({ ...st, dash: null });
      const size = p.h * 1.4 * k, codes = winAnsi(p.s), wpt = textWidth(codes, size);
      const shift = p.anchor === "middle" ? -wpt / 2 : p.anchor === "end" ? -wpt : 0;
      const rad = ((p.rot || 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
      const x = p.p[0] * k + shift * c, y = p.p[1] * k + shift * s;
      const str = codes.map((ch) => (ch === 40 || ch === 41 || ch === 92 ? "\\" + String.fromCharCode(ch) : ch > 126 ? "\\" + ch.toString(8).padStart(3, "0") : String.fromCharCode(ch))).join("");
      ops.push(`BT /F1 ${size.toFixed(2)} Tf ${c.toFixed(4)} ${s.toFixed(4)} ${(-s).toFixed(4)} ${c.toFixed(4)} ${x.toFixed(2)} ${y.toFixed(2)} Tm (${str}) Tj ET`);
    }
  }
  const content = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Producer (AUTO3D) /Title (${(d.title || "Drawing").replace(/[()\\]/g, "")}) >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: "application/pdf" });
}
