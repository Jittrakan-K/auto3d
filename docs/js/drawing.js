// Turns a solid (from a STEP file or the model on screen) into a 2D engineering drawing:
// front, top and right views in third-angle layout plus an isometric, hidden lines,
// centre marks, overall dimensions, hole callouts and a title block.
// Everything is produced as plain primitives in sheet millimetres (origin bottom left,
// y up) so the SVG, DXF and PDF writers draw exactly the same sheet.

export const SHEETS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
const SCALES = [50, 20, 10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100];
const MARGIN = 10;          // border inset
const TITLE_H = 36;         // reserved strip for the title block
const GAP = 22;             // space between views, leaves room for dimensions
const EPS = 1e-6;

export const fmtScale = (s) => (s >= 1 ? `${+s.toFixed(3)}:1` : `1:${+(1 / s).toFixed(3)}`);
export const fmtLen = (v) => String(+v.toFixed(2));

// ---------- projected paths → segments ----------
// replicad gives SVG path data in the view's own coordinates (y up). Lines stay lines,
// arcs become true arcs (so the DXF gets real circles), splines arrive already sampled.
function arcCenter(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  const phi = (phiDeg * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = c * dx + s * dy, y1p = -s * dx + c * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  else if (fs && dt < 0) dt += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, r: (rx + ry) / 2, t1, dt };
}

function parsePath(d) {
  const tok = d.match(/[MLACQZHVmlacqzhv]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const segs = [];
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0;
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    const C = cmd.toUpperCase();
    if (C === "M") { x = sx = num(); y = sy = num(); cmd = "L"; }
    else if (C === "L") { const nx = num(), ny = num(); segs.push({ t: "line", a: [x, y], b: [nx, ny] }); x = nx; y = ny; }
    else if (C === "H") { const nx = num(); segs.push({ t: "line", a: [x, y], b: [nx, y] }); x = nx; }
    else if (C === "V") { const ny = num(); segs.push({ t: "line", a: [x, y], b: [x, ny] }); y = ny; }
    else if (C === "A") {
      const rx = num(), ry = num(), rot = num(), fa = num(), fs = num(), nx = num(), ny = num();
      const a = arcCenter(x, y, rx, ry, rot, fa, fs, nx, ny);
      if (Math.abs(a.rx - a.ry) > 1e-3 * Math.max(a.rx, a.ry)) {
        // Elliptical arcs (circles seen at an angle) are drawn as short straight pieces.
        const n = Math.max(8, Math.ceil((Math.abs(a.dt) / (2 * Math.PI)) * 72));
        const c = Math.cos(a.phi), sn = Math.sin(a.phi);
        let px = x, py = y;
        for (let k = 1; k <= n; k++) {
          const th = a.t1 + (a.dt * k) / n;
          const qx = k === n ? nx : a.cx + a.rx * c * Math.cos(th) - a.ry * sn * Math.sin(th);
          const qy = k === n ? ny : a.cy + a.rx * sn * Math.cos(th) + a.ry * c * Math.sin(th);
          segs.push({ t: "line", a: [px, py], b: [qx, qy] }); px = qx; py = qy;
        }
      } else segs.push({ t: "arc", cx: a.cx, cy: a.cy, r: a.r, t1: a.t1, dt: a.dt });
      x = nx; y = ny;
    } else if (C === "C" || C === "Q") {
      const pts = C === "C" ? [[x, y], [num(), num()], [num(), num()], [num(), num()]] : [[x, y], [num(), num()], [num(), num()]];
      const n = 12;
      let px = x, py = y;
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        const [qx, qy] = C === "C"
          ? [u * u * u * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t * t * t * pts[3][0],
             u * u * u * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t * t * t * pts[3][1]]
          : [u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0], u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1]];
        segs.push({ t: "line", a: [px, py], b: [qx, qy] }); px = qx; py = qy;
      }
      x = pts[pts.length - 1][0]; y = pts[pts.length - 1][1];
    } else if (C === "Z") {
      if (Math.hypot(x - sx, y - sy) > EPS) segs.push({ t: "line", a: [x, y], b: [sx, sy] });
      x = sx; y = sy; cmd = "";
    } else i++;
  }
  // Consecutive arcs on one centre that add up to a full turn are one circle.
  const out = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (s.t === "arc" && p && p.t === "arc" && Math.hypot(s.cx - p.cx, s.cy - p.cy) < 1e-4 && Math.abs(s.r - p.r) < 1e-4) {
      p.dt += s.dt;
      continue;
    }
    out.push({ ...s });
  }
  return out.map((s) => (s.t === "arc" && Math.abs(Math.abs(s.dt) - 2 * Math.PI) < 1e-3 ? { t: "circle", cx: s.cx, cy: s.cy, r: s.r } : s));
}

// Collapse long runs of tiny collinear pieces (sampled straight splines) into one line.
function mergeLines(segs) {
  const out = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (s.t === "line" && p && p.t === "line" && Math.hypot(p.b[0] - s.a[0], p.b[1] - s.a[1]) < 1e-6) {
      const ux = p.b[0] - p.a[0], uy = p.b[1] - p.a[1], vx = s.b[0] - s.a[0], vy = s.b[1] - s.a[1];
      const cross = Math.abs(ux * vy - uy * vx), lens = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      if (lens > 0 && cross / lens < 1e-6 && ux * vx + uy * vy > 0) { p.b = s.b; continue; }
    }
    if (s.t === "line" && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) < 1e-6) continue;
    out.push({ ...s });
  }
  return out;
}

function projectView(K, shape, view) {
  const pr = K.drawProjection(shape, view);
  const segsOf = (drawing) => {
    let paths = [];
    try { paths = drawing.toSVGPaths().flat(Infinity); } catch { paths = []; }
    return mergeLines(paths.flatMap((d) => parsePath(String(d))));
  };
  const visible = segsOf(pr.visible), hidden = segsOf(pr.hidden);
  let b = [[Infinity, Infinity], [-Infinity, -Infinity]];
  const grow = (x, y) => { b = [[Math.min(b[0][0], x), Math.min(b[0][1], y)], [Math.max(b[1][0], x), Math.max(b[1][1], y)]]; };
  for (const s of [...visible, ...hidden]) {
    if (s.t === "line") { grow(...s.a); grow(...s.b); }
    else { grow(s.cx - s.r, s.cy - s.r); grow(s.cx + s.r, s.cy + s.r); }
  }
  if (!isFinite(b[0][0])) b = [[0, 0], [0, 0]];
  return { visible, hidden, box: b, w: b[1][0] - b[0][0], h: b[1][1] - b[0][1] };
}

// Cameras in SOLIDWORKS orientation (Y up). The direction points from the part to the
// viewer and xAxis is screen right; replicad's named views assume Z up, so they are not used.
// The main (front) view can be any of the model's front, top or right; the other views
// follow from it the way a drawing would place them.
const MAIN = { front: [[0, 0, 1], [1, 0, 0]], top: [[0, 1, 0], [1, 0, 0]], right: [[1, 0, 0], [0, 0, -1]] };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
function cameras(main) {
  const [F, X] = MAIN[main] || MAIN.front;
  const U = cross(F, X);
  return {
    front: [F, X],
    top: [U, X],
    right: [X, F.map((x) => -x)],
    iso: [unit(F.map((f, i) => f + U[i] + X[i])), unit(X.map((x, i) => x - F[i]))],
  };
}

// The most descriptive view goes in front: the one with the largest projected outline.
function pickMain(shape) {
  const b = shape.boundingBox.bounds, d = [0, 1, 2].map((i) => b[1][i] - b[0][i]);
  const area = { front: d[0] * d[1], top: d[0] * d[2], right: d[2] * d[1] };
  return Object.keys(area).reduce((a, k) => (area[k] > area[a] * 1.05 ? k : a), "front");
}

// ---------- layout ----------
// The isometric gets the top-right cell; it is scaled down to fit that cell when needed.
function cells(v, s) {
  const cellW = Math.max(v.right.w * s, v.front.w * s * 0.55);
  const cellH = Math.max(v.top.h * s, v.front.h * s * 0.55);
  return { cellW, cellH, isoS: Math.min(s, cellW / Math.max(v.iso.w, EPS), cellH / Math.max(v.iso.h, EPS)) };
}
function needed(v, s) {
  const { cellW, cellH } = cells(v, s);
  return { w: v.front.w * s + GAP + cellW + 1.5 * GAP, h: v.front.h * s + GAP + cellH + 1.5 * GAP };
}

function chooseSheet(v, wantSheet, wantScale) {
  const fits = (name, s) => {
    const [W, H] = SHEETS[name], n = needed(v, s);
    return n.w <= W - 2 * MARGIN && n.h <= H - 2 * MARGIN - TITLE_H;
  };
  const sheets = wantSheet && wantSheet !== "auto" ? [wantSheet] : ["A4", "A3", "A2", "A1", "A0"];
  const scales = wantScale && wantScale !== "auto" ? [Number(wantScale)] : SCALES;
  if (wantSheet && wantSheet !== "auto") {
    const s = scales.find((x) => fits(wantSheet, x));
    return { sheet: wantSheet, scale: s ?? scales[scales.length - 1] };
  }
  // A4 or A3 at full size (or enlarged) if it fits; otherwise reduce on A4/A3 before
  // moving up to larger sheets.
  for (const name of ["A4", "A3"]) {
    const s = scales.find((x) => x >= 1 && fits(name, x));
    if (s) return { sheet: name, scale: s };
  }
  for (const name of ["A4", "A3"]) {
    const s = scales.find((x) => x >= 0.5 && fits(name, x));
    if (s) return { sheet: name, scale: s };
  }
  for (const name of ["A3", "A2", "A1", "A0"]) {
    const s = scales.find((x) => fits(name, x));
    if (s) return { sheet: name, scale: s };
  }
  return { sheet: "A0", scale: scales[scales.length - 1] };
}

// ---------- drawing ----------
// The slow part (hidden-line projection); do it once per part and reuse for every layout.
export function projectAll(K, shape, main = "auto") {
  const m = main === "auto" || !MAIN[main] ? pickMain(shape) : main;
  const cams = cameras(m);
  const cam = (k) => new K.ProjectionCamera([0, 0, 0], cams[k][0], cams[k][1]);
  const v = { front: projectView(K, shape, cam("front")), top: projectView(K, shape, cam("top")), right: projectView(K, shape, cam("right")), iso: projectView(K, shape, cam("iso")) };
  v.main = m;
  return v;
}

export function makeDrawing(K, shape, opts = {}) {
  const views = opts.views || projectAll(K, shape, opts.main);
  const { sheet, scale } = chooseSheet(views, opts.sheet, opts.scale);
  const [W, H] = SHEETS[sheet];
  const P = [];
  const add = (p) => P.push(p);

  // Drawing area above the title strip; views centred as a group.
  const areaX = MARGIN, areaY = MARGIN + TITLE_H, areaW = W - 2 * MARGIN, areaH = H - 2 * MARGIN - TITLE_H;
  const s = scale;
  const { cellW, cellH, isoS } = cells(views, s);
  const n = needed(views, s);
  const x0 = areaX + (areaW - n.w) / 2 + GAP * 0.9;  // left edge of the front view
  const y0 = areaY + (areaH - n.h) / 2 + GAP * 0.9;  // bottom edge of the front view
  const frontW = views.front.w * s, frontH = views.front.h * s;
  const place = {
    front: { x: x0, y: y0, s },
    top: { x: x0, y: y0 + frontH + GAP, s },
    right: { x: x0 + frontW + GAP, y: y0, s },
    iso: { x: x0 + frontW + GAP + (cellW - views.iso.w * isoS) / 2, y: y0 + frontH + GAP + (cellH - views.iso.h * isoS) / 2, s: isoS },
  };
  // Keep projection alignment exact: top shares the front's x, right shares the front's y.
  const map = (name) => {
    const v = views[name], pl = place[name];
    return (x, y) => [pl.x + (x - v.box[0][0]) * pl.s, pl.y + (y - v.box[0][1]) * pl.s];
  };

  const hiddenOn = opts.hidden !== false;
  const circles = { front: [], top: [], right: [] };
  const arcs = { front: [], top: [], right: [] };
  for (const name of ["front", "top", "right", "iso"]) {
    if (name === "iso" && opts.iso === false) continue;
    const v = views[name], m = map(name), k = place[name].s;
    const emit = (seg, layer) => {
      if (seg.t === "line") add({ t: "line", a: m(...seg.a), b: m(...seg.b), layer });
      else if (seg.t === "circle") {
        const [cx, cy] = m(seg.cx, seg.cy);
        add({ t: "circle", c: [cx, cy], r: seg.r * k, layer });
        if (layer === "outline" && circles[name]) circles[name].push({ c: [cx, cy], r: seg.r, rp: seg.r * k });
      } else {
        const [cx, cy] = m(seg.cx, seg.cy);
        const a0 = seg.dt >= 0 ? seg.t1 : seg.t1 + seg.dt, a1 = seg.dt >= 0 ? seg.t1 + seg.dt : seg.t1;
        add({ t: "arc", c: [cx, cy], r: seg.r * k, a0: (a0 * 180) / Math.PI, a1: (a1 * 180) / Math.PI, layer });
        if (layer === "outline" && arcs[name]) arcs[name].push({ c: [cx, cy], r: seg.r, rp: seg.r * k, a0: (a0 * 180) / Math.PI, a1: (a1 * 180) / Math.PI });
      }
    };
    if (hiddenOn && name !== "iso") v.hidden.forEach((sg) => emit(sg, "hidden"));
    v.visible.forEach((sg) => emit(sg, "outline"));
    const lb = map(name)(v.box[0][0], v.box[0][1]);
    const label = { front: "FRONT", top: "TOP", right: "RIGHT", iso: "ISOMETRIC" }[name] + (name === "iso" && Math.abs(isoS - s) > EPS ? ` (${fmtScale(isoS)})` : "");
    add({ t: "text", p: [lb[0] + (v.w * place[name].s) / 2, lb[1] - (name === "front" ? 18 : name === "iso" ? 6 : 6)], h: 2.5, s: label, anchor: "middle", layer: "text" });
  }

  // Arcs on one centre that cover at least half a turn (a ring broken by tabs or slots)
  // are dimensioned as a diameter, like a full circle.
  for (const name of ["front", "top", "right"]) {
    const groups = new Map();
    for (const a of arcs[name]) {
      const key = `${a.c[0].toFixed(2)},${a.c[1].toFixed(2)},${a.r.toFixed(3)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    for (const list of groups.values()) {
      const sweep = list.reduce((t, a) => t + (((a.a1 - a.a0) % 360) + 360) % 360, 0);
      if (sweep >= 180 && !circles[name].some((c) => Math.hypot(c.c[0] - list[0].c[0], c.c[1] - list[0].c[1]) < 1e-3 && Math.abs(c.r - list[0].r) < 1e-3)) {
        circles[name].push({ c: list[0].c, r: list[0].r, rp: list[0].rp, spans: list.map((a) => [a.a0, a.a1]), half: sweep < 200 });
      }
    }
  }

  // A chamfer or fillet on a round edge shows as a second circle a hair away from the
  // real one. Keep the real edge: the largest for the outside, the smallest for a bore.
  for (const name of ["front", "top", "right"]) {
    const keep = [];
    const byCentre = new Map();
    for (const c of circles[name]) {
      const k = `${c.c[0].toFixed(2)},${c.c[1].toFixed(2)}`;
      if (!byCentre.has(k)) byCentre.set(k, []);
      byCentre.get(k).push(c);
    }
    for (const list of byCentre.values()) {
      list.sort((a, b) => a.r - b.r);
      const rMax = list[list.length - 1].r;
      let cluster = [list[0]];
      const flush = () => { keep.push(cluster.some((c) => c.r === rMax) ? cluster[cluster.length - 1] : cluster[0]); };
      for (let i = 1; i < list.length; i++) {
        if (list[i].r - list[i - 1].r < 1.2) cluster.push(list[i]);
        else { flush(); cluster = [list[i]]; }
      }
      flush();
    }
    circles[name] = keep;
  }

  // Centre marks on every hole and boss seen end-on.
  for (const name of ["front", "top", "right"]) {
    const marked = [];
    for (const c of [...circles[name]].sort((p, q) => q.rp - p.rp)) {
      if (marked.some((m) => Math.hypot(m[0] - c.c[0], m[1] - c.c[1]) < 1e-3)) continue;
      marked.push(c.c);
      const e = c.rp + Math.min(3, c.rp * 0.4 + 1.5);
      add({ t: "line", a: [c.c[0] - e, c.c[1]], b: [c.c[0] + e, c.c[1]], layer: "center" });
      add({ t: "line", a: [c.c[0], c.c[1] - e], b: [c.c[0], c.c[1] + e], layer: "center" });
    }
  }

  // Overall dimensions: width and height on the front view, depth on the top view.
  const fb = place.front, tb = place.top;
  const fW = views.front.w, fH = views.front.h, tH = views.top.h;
  const roundFront = circles.front.some((c) => Math.abs(2 * c.r - fW) < 0.01 && Math.abs(2 * c.r - fH) < 0.01);
  dimH(add, [fb.x, fb.y], [fb.x + fW * s, fb.y], fb.y - 9, (roundFront ? "%%c" : "") + fmtLen(fW));
  if (!roundFront) dimV(add, [fb.x, fb.y], [fb.x, fb.y + fH * s], fb.x - 9, fmtLen(fH));
  dimV(add, [tb.x, tb.y], [tb.x, tb.y + tH * s], tb.x - 9, fmtLen(tH));

  // Hole callouts: one leader per hole size, with the count.
  const seen = new Set(opts.callouts === false ? ["all"] : []);
  const labels = [];
  for (const name of ["front", "top", "right"]) {
    const groups = new Map();
    for (const c of circles[name]) {
      const key = (c.half ? "R" : "D") + c.r.toFixed(3);
      if (roundFront && name === "front" && Math.abs(2 * c.r - fW) < 0.01) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [key, list] of groups) {
      if (seen.has("all") || seen.has(key) || seen.size >= 6) continue;
      seen.add(key);
      const c = list.reduce((a, b) => (b.c[0] + b.c[1] > a.c[0] + a.c[1] ? b : a));
      const text = c.half ? `${list.length > 1 ? `${list.length}x ` : ""}R${fmtLen(c.r)}` : `${list.length > 1 ? `${list.length}x ` : ""}%%c${fmtLen(2 * c.r)}`;
      const tw = text.replace("%%c", "O").length * 1.7 + 4;
      // Try a few leader angles and lengths until the label lands on free paper.
      let p0, p1;
      search: for (const len of [7, 12, 17, 22]) {
        for (const deg of [45, 30, 60, 15, 75, 135, 120, 150, -45, -30]) {
          if (c.spans && !c.spans.some(([a0, a1]) => { const t = (((deg - a0) % 360) + 360) % 360; return t <= (((a1 - a0) % 360) + 360) % 360; })) continue;
          const ang = (deg * Math.PI) / 180;
          p0 = [c.c[0] + c.rp * Math.cos(ang), c.c[1] + c.rp * Math.sin(ang)];
          p1 = [p0[0] + len * Math.cos(ang), p0[1] + len * Math.sin(ang)];
          const box = p1[0] < p0[0] ? [p1[0] - tw, p1[1] - 2.5, p1[0] + 1, p1[1] + 3] : [p1[0] - 1, p1[1] - 2.5, p1[0] + tw, p1[1] + 3];
          if (!labels.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) { labels.push(box); break search; }
        }
      }
      const left = p1[0] < p0[0];
      arrow(add, p1, p0);
      add({ t: "line", a: p1, b: [p1[0] + (left ? -3 : 3), p1[1]], layer: "dim" });
      add({ t: "text", p: [p1[0] + (left ? -4 : 4), p1[1] - 1.2], h: 2.5, s: text, anchor: left ? "end" : "start", layer: "dim" });
    }
  }

  frame(add, W, H, { ...opts, sheet, scale });
  return { sheet, size: [W, H], scale, prims: P, main: views.main, views: Object.fromEntries(["front", "top", "right", "iso"].map((k) => [k, { w: views[k].w, h: views[k].h }])) };
}

// ---------- dimension helpers (paper mm) ----------
function arrow(add, from, tip) {
  const len = 3, wid = 0.9;
  const dx = tip[0] - from[0], dy = tip[1] - from[1], L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  const bx = tip[0] - ux * len, by = tip[1] - uy * len;
  add({ t: "line", a: from, b: [bx, by], layer: "dim" });
  add({ t: "solid", pts: [tip, [bx - uy * wid, by + ux * wid], [bx + uy * wid, by - ux * wid]], layer: "dim" });
}
function dimH(add, a, b, y, text) {
  const ext = (p) => add({ t: "line", a: [p[0], p[1] - 1.5 * Math.sign(p[1] - y || 1)], b: [p[0], y - 1.5], layer: "dim" });
  ext(a); ext(b);
  const mid = [(a[0] + b[0]) / 2, y];
  arrow(add, mid, [a[0], y]); arrow(add, mid, [b[0], y]);
  add({ t: "text", p: [mid[0], y + 1.2], h: 2.5, s: text, anchor: "middle", layer: "dim" });
}
function dimV(add, a, b, x, text) {
  const ext = (p) => add({ t: "line", a: [p[0] - 1.5, p[1]], b: [x - 1.5, p[1]], layer: "dim" });
  ext(a); ext(b);
  const mid = [x, (a[1] + b[1]) / 2];
  arrow(add, mid, [x, a[1]]); arrow(add, mid, [x, b[1]]);
  add({ t: "text", p: [x - 1.2, mid[1]], h: 2.5, s: text, anchor: "middle", rot: 90, layer: "dim" });
}

// ---------- border and title block ----------
function frame(add, W, H, o) {
  const L = (a, b, layer = "border") => add({ t: "line", a, b, layer });
  const rect = (x, y, w, h, layer) => { L([x, y], [x + w, y], layer); L([x + w, y], [x + w, y + h], layer); L([x + w, y + h], [x, y + h], layer); L([x, y + h], [x, y], layer); };
  rect(MARGIN, MARGIN, W - 2 * MARGIN, H - 2 * MARGIN, "border");

  const bw = Math.min(180, W - 2 * MARGIN), bh = 28, bx = W - MARGIN - bw, by = MARGIN;
  rect(bx, by, bw, bh, "border");
  const T = (x, y, s, h = 2.2, anchor = "start", layer = "text") => add({ t: "text", p: [x, y], h, s, anchor, layer });
  // Rows: title band on top, two rows of fields below.
  const col = [bx, bx + bw * 0.34, bx + bw * 0.56, bx + bw * 0.78, bx + bw];
  L([bx, by + 14], [bx + bw, by + 14]);
  L([bx, by + 7], [col[3], by + 7]);
  for (const x of col.slice(1, 4)) L([x, by], [x, by + 14]);
  const label = (x, y, s) => T(x + 1.5, y + 4.6, s, 1.6, "start", "label");
  const value = (x, y, s) => T(x + 1.5, y + 1.4, s, 2.2);
  label(col[0], by + 7, "PART NO."); value(col[0], by + 7, o.partNo || "-");
  label(col[0], by, "MATERIAL"); value(col[0], by, o.material || "-");
  label(col[1], by + 7, "SCALE"); value(col[1], by + 7, fmtScale(o.scale));
  label(col[1], by, "SIZE"); value(col[1], by, o.sheet);
  label(col[2], by + 7, "DRAWN"); value(col[2], by + 7, o.drawnBy || "AUTO3D");
  label(col[2], by, "DATE"); value(col[2], by, o.date || new Date().toISOString().slice(0, 10));
  // Third-angle symbol in the last cell.
  const sx = col[3] + (col[4] - col[3]) / 2 - 10, sy = by + 4;
  add({ t: "line", a: [sx, sy], b: [sx, sy + 6], layer: "border" });
  add({ t: "line", a: [sx, sy], b: [sx + 7, sy + 1.4], layer: "border" });
  add({ t: "line", a: [sx, sy + 6], b: [sx + 7, sy + 4.6], layer: "border" });
  add({ t: "line", a: [sx + 7, sy + 1.4], b: [sx + 7, sy + 4.6], layer: "border" });
  add({ t: "circle", c: [sx + 14, sy + 3], r: 3, layer: "border" });
  add({ t: "circle", c: [sx + 14, sy + 3], r: 1.6, layer: "border" });
  T(bx + 2, by + 18.2, o.title || "Part", 5, "start");
  T(bx + bw - 2, by + 18.6, "AUTO3D", 2.2, "end", "label");
  T(MARGIN + 3, H - MARGIN - 5, "DIMENSIONS IN MM  /  THIRD ANGLE PROJECTION  /  DO NOT SCALE", 2, "start", "label");
}
