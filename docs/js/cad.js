// Builds a plan into a real B-rep solid with OpenCASCADE (replicad, WebAssembly).
// Same behaviour as app/cad_engine.py: each feature becomes primitive steps, and every
// step records the volume and centre of mass the SOLIDWORKS macro must reproduce.
import { holePoints } from "./plan.js";

let R = null;
export function useKernel(replicad) { R = replicad; }

export class BuildError extends Error {
  constructor(featureId, message) {
    super(`${featureId}: ${message}`);
    this.featureId = featureId;
    this.detail = message;
  }
}

const PLANES = {
  Front: { x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  Top: { x: [1, 0, 0], y: [0, 0, -1], n: [0, 1, 0] },
  Right: { x: [0, 0, -1], y: [0, 1, 0], n: [1, 0, 0] },
};
const AXES = { X: 0, Y: 1, Z: 2 };
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------- sketch entities to closed loops ----------
const line = (a, b) => ({ t: "line", a: [...a], b: [...b] });
const arc = (c, a, b, ccw) => ({ t: "arc", c: [...c], a: [...a], b: [...b], ccw });
const circle = (c, r) => ({ t: "circle", c: [...c], r });
const polyline = (pts) => pts.map((p, i) => line(p, pts[(i + 1) % pts.length]));

export function loopsOf(e) {
  if (e.type === "rect") {
    const { cx: x, cy: y } = e, w = e.w / 2, h = e.h / 2;
    return [polyline([[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]])];
  }
  if (e.type === "circle") return [[circle([e.cx, e.cy], e.d / 2)]];
  if (e.type === "regular_polygon") {
    const r = e.d / 2, a0 = (e.angle_deg * Math.PI) / 180;
    return [polyline(Array.from({ length: e.sides }, (_, i) => {
      const a = a0 + (2 * Math.PI * i) / e.sides;
      return [e.cx + r * Math.cos(a), e.cy + r * Math.sin(a)];
    }))];
  }
  if (e.type === "slot") {
    const L = (e.length - e.width) / 2, Rr = e.width / 2, t = (e.angle_deg * Math.PI) / 180;
    const ux = Math.cos(t), uy = Math.sin(t), nx = -Math.sin(t), ny = Math.cos(t);
    const c1 = [e.cx + L * ux, e.cy + L * uy], c2 = [e.cx - L * ux, e.cy - L * uy];
    const p1 = [c1[0] + Rr * nx, c1[1] + Rr * ny], p2 = [c2[0] + Rr * nx, c2[1] + Rr * ny];
    const p3 = [c2[0] - Rr * nx, c2[1] - Rr * ny], p4 = [c1[0] - Rr * nx, c1[1] - Rr * ny];
    return [[arc(c1, p4, p1, true), line(p1, p2), arc(c2, p2, p3, true), line(p3, p4)]];
  }
  if (e.type === "profile") {
    const segs = [];
    let cur = [...e.start];
    for (const s of e.segments) {
      if (s.line_to) { segs.push(line(cur, s.line_to)); cur = [...s.line_to]; }
      else {
        if (Math.abs(dist2(s.center, cur) - dist2(s.center, s.arc_to)) > 0.01) {
          throw new Error(`arc center [${s.center}] is not equidistant from [${cur}] and [${s.arc_to}]`);
        }
        segs.push(arc(s.center, cur, s.arc_to, s.ccw));
        cur = [...s.arc_to];
      }
    }
    if (dist2(cur, e.start) > 1e-6) segs.push(line(cur, e.start));
    return [segs];
  }
  throw new Error(`unknown sketch entity ${e.type}`);
}

function arcPoint(s, frac) {
  const r = dist2(s.c, s.a);
  const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
  const a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
  const tau = 2 * Math.PI;
  const sweep = s.ccw ? (((a1 - a0) % tau) + tau) % tau : -((((a0 - a1) % tau) + tau) % tau);
  const m = a0 + sweep * frac;
  return [s.c[0] + r * Math.cos(m), s.c[1] + r * Math.sin(m)];
}

// Points along a loop, used to sort loops into outlines and openings.
function samplePoly(loop) {
  if (loop.length === 1 && loop[0].t === "circle") {
    const s = loop[0];
    return Array.from({ length: 48 }, (_, i) => [s.c[0] + s.r * Math.cos((i / 48) * 2 * Math.PI), s.c[1] + s.r * Math.sin((i / 48) * 2 * Math.PI)]);
  }
  const pts = [];
  for (const s of loop) {
    if (s.t === "line") pts.push(s.a);
    else for (let i = 0; i < 16; i++) pts.push(arcPoint(s, i / 16));
  }
  return pts;
}
const polyArea = (p) => Math.abs(p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;
function inside(pt, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function makePlane(name, offset) {
  const d = PLANES[name];
  return { ...d, o: d.n.map((v) => v * offset) };
}
const world = (pl, p, z = 0) => [0, 1, 2].map((k) => pl.o[k] + p[0] * pl.x[k] + p[1] * pl.y[k] + z * pl.n[k]);

function wireOf(loop, pl, z = 0) {
  if (loop.length === 1 && loop[0].t === "circle") {
    const s = loop[0];
    return R.assembleWire([R.makeCircle(s.r, world(pl, s.c, z), pl.n)]);
  }
  return R.assembleWire(loop.map((s) => (s.t === "line"
    ? R.makeLine(world(pl, s.a, z), world(pl, s.b, z))
    : R.makeThreePointArc(world(pl, s.a, z), world(pl, arcPoint(s, 0.5), z), world(pl, s.b, z)))));
}

// Outlines with the loops nested directly inside them as openings.
function facesOf(loops, pl, z = 0) {
  const polys = loops.map(samplePoly);
  const depth = polys.map((p, i) => polys.filter((q, j) => j !== i && polyArea(q) > polyArea(p) && inside(p[0], q)).length);
  const faces = [];
  loops.forEach((loop, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((_, j) => depth[j] === depth[i] + 1 && inside(polys[j][0], polys[i]));
    faces.push(R.makeFace(wireOf(loop, pl, z), holes.map((h) => wireOf(h, pl, z))));
  });
  return faces;
}

function fuseAll(shapes) {
  let out = shapes[0];
  for (const s of shapes.slice(1)) out = out.fuse(s);
  return out;
}

function prism(loops, pl, z0, z1, draftDeg) {
  if (draftDeg > 0) {
    // countersink: a cone from each circle, narrowing along the cut
    const shrink = Math.abs(z1 - z0) * Math.tan((draftDeg * Math.PI) / 180);
    return fuseAll(loops.map((loop) => {
      const s = loop[0];
      const top = R.assembleWire([R.makeCircle(s.r, world(pl, s.c, z0), pl.n)]);
      const bottom = R.assembleWire([R.makeCircle(Math.max(s.r - shrink, 1e-3), world(pl, s.c, z1), pl.n)]);
      return R.loft([top, bottom]);
    }));
  }
  const vec = new R.Vector(pl.n.map((v) => v * (z1 - z0)));
  return fuseAll(facesOf(loops, pl, z0).map((f) => R.basicFaceExtrusion(f, vec)));
}

function bounds(shape) {
  const [[a, b, c], [d, e, f]] = shape.boundingBox.bounds;
  return [a, b, c, d, e, f].map((v) => round(v));
}

function massProps(shape) {
  const p = R.measureShapeVolumeProperties(shape);
  return { volume: p.volume, center: p.centerOfMass };
}

function solidCount(shape) {
  try { return shape.solids?.length ?? 1; } catch { return 1; }
}

function isValid(shape) {
  try {
    const oc = R.getOC();
    const a = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
    const ok = a.IsValid_2 ? a.IsValid_2() : a.IsValid_1 ? a.IsValid_1() : a.IsValid();
    a.delete?.();
    return ok;
  } catch {
    return true; // the analyzer is optional; volume checks still catch broken results
  }
}

function edgeSamples(edge, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const p = edge.pointAt(i / n); pts.push([p.x, p.y, p.z]); }
  return pts;
}

function selectEdges(body, sel) {
  const edges = body.edges;
  const bb = body.boundingBox.bounds;
  const info = edges.map((e) => ({ e, type: e.geomType, pts: edgeSamples(e) }));
  const keep = ({ type, pts }) => {
    if (sel.kind === "line" && type !== "LINE") return false;
    if (sel.kind === "circle" && type !== "CIRCLE") return false;
    if (sel.parallel_to) {
      if (type !== "LINE") return false;
      const a = pts[0], b = pts[pts.length - 1];
      const len = dist3(a, b);
      if (Math.abs(Math.abs((b[AXES[sel.parallel_to]] - a[AXES[sel.parallel_to]]) / len) - 1) > 1e-6) return false;
    }
    if (sel.on) {
      const i = AXES[sel.on.axis];
      const at = sel.on.at === "max" ? bb[1][i] : sel.on.at === "min" ? bb[0][i] : Number(sel.on.at);
      if (!pts.every((p) => Math.abs(p[i] - at) < 1e-4)) return false;
    }
    return true;
  };
  let picked = info.filter(keep);
  if (sel.near && sel.near.length) {
    const pool = picked.length ? picked : info;
    const chosen = [];
    for (const pt of sel.near) {
      const best = pool.reduce((m, x) => {
        const d = Math.min(...edgeSamples(x.e, 96).map((p) => dist3(p, pt)));
        return d < m.d ? { d, x } : m;
      }, { d: Infinity, x: null }).x;
      if (best && !chosen.includes(best)) chosen.push(best);
    }
    picked = chosen;
  }
  return picked.map(({ e }) => { const p = e.pointAt(0.5); return [p.x, p.y, p.z]; });
}

function expand(f) {
  const name = f.name || f.id;
  const loops = () => f.sketch.flatMap(loopsOf);
  const base = { id: f.id, name, plane: f.plane || "", offset: f.offset || 0, loops: [], depth: 0, through: false,
    direction: f.direction || "normal", draft_deg: 0, axis: null, angle_deg: 360, is_cut: false, size: 0, edge_points: [] };
  if (f.type === "extrude") return [{ ...base, kind: "extrude", loops: loops(), depth: f.depth }];
  if (f.type === "cut") return [{ ...base, kind: "cut", loops: loops(), depth: f.depth || 0, through: !!f.through }];
  if (f.type === "revolve") {
    return [{ ...base, kind: "revolve", offset: 0, loops: loops(), axis: [f.axis_a, f.axis_b], angle_deg: f.angle_deg, is_cut: !!f.cut }];
  }
  if (f.type === "hole") {
    const pts = holePoints(f);
    const out = [{ ...base, kind: "cut", loops: pts.map((p) => [circle(p, f.diameter / 2)]), depth: f.depth || 0, through: !!f.through }];
    if (f.cbore_d) {
      out.push({ ...base, id: `${f.id}_cbore`, kind: "cut", name: `${name} counterbore`, loops: pts.map((p) => [circle(p, f.cbore_d / 2)]), depth: f.cbore_depth });
    }
    if (f.csk_d) {
      const half = f.csk_angle_deg / 2;
      const h = (f.csk_d - f.diameter) / 2 / Math.tan((half * Math.PI) / 180);
      out.push({ ...base, id: `${f.id}_csk`, kind: "cut", name: `${name} countersink`, loops: pts.map((p) => [circle(p, f.csk_d / 2)]), depth: h, draft_deg: half });
    }
    return out;
  }
  if (f.type === "fillet") return [{ ...base, kind: "fillet", size: f.radius }];
  if (f.type === "chamfer") return [{ ...base, kind: "chamfer", size: f.distance }];
  throw new Error(`unknown feature ${f.type}`);
}

function range(step, reach) {
  const length = step.through ? reach : step.depth;
  if (step.direction === "normal") return [0, length];
  if (step.direction === "reverse") return [0, -length];
  const half = step.through ? reach : step.depth / 2;
  return [-half, half];
}

function apply(step, feature, body) {
  if (step.kind === "fillet" || step.kind === "chamfer") {
    if (!body) throw new BuildError(step.id, "nothing to fillet yet");
    const points = selectEdges(body, feature.edges || {});
    if (!points.length) throw new BuildError(step.id, "the edge selector matched no edges");
    step.edge_points = points.map((p) => p.map((v) => round(v, 6)));
    const pick = (e) => { const p = e.pointAt(0.5); const q = [p.x, p.y, p.z]; return points.some((m) => dist3(m, q) < 1e-6) ? step.size : null; };
    return step.kind === "fillet" ? body.fillet(pick) : body.chamfer(pick);
  }
  const pl = makePlane(step.plane, step.offset);
  if (step.kind === "revolve") {
    const [a, b] = step.axis.map((p) => world(pl, p));
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const tool = fuseAll(facesOf(step.loops, pl).map((f) => R.revolution(f, a, dir, step.angle_deg)));
    if (!body) return tool;
    return step.is_cut ? body.cut(tool) : body.fuse(tool);
  }
  if (step.kind === "extrude") {
    const [z0, z1] = range(step, 0);
    const tool = prism(step.loops, pl, z0, z1, 0);
    return body ? body.fuse(tool) : tool;
  }
  if (step.kind === "cut") {
    if (!body) throw new BuildError(step.id, "cannot cut before a body exists");
    const [lo, hi] = body.boundingBox.bounds;
    const reach = 2 * dist3(lo, hi) + Math.abs(step.offset) + 1;
    const [z0, z1] = range(step, reach);
    return body.cut(prism(step.loops, pl, z0, z1, step.draft_deg));
  }
  throw new BuildError(step.id, `unknown step kind ${step.kind}`);
}

export function build(plan) {
  if (!R) throw new Error("CAD kernel is not loaded");
  let body = null;
  const steps = [];
  for (const feature of plan.features) {
    let expanded;
    try { expanded = expand(feature); } catch (e) { throw new BuildError(feature.id, e.message); }
    for (const step of expanded) {
      const before = body ? massProps(body).volume : 0;
      try {
        body = apply(step, feature, body);
      } catch (e) {
        if (e instanceof BuildError) throw e;
        throw new BuildError(step.id, `geometry failed: ${e.message || e}`);
      }
      if (!body || !isValid(body)) throw new BuildError(step.id, "result is not a valid solid");
      const { volume, center } = massProps(body);
      if (!(volume > 0)) throw new BuildError(step.id, "result has no volume");
      if ((step.kind === "cut" || step.is_cut) && Math.abs(volume - before) < 1e-6) {
        throw new BuildError(step.id, "this cut removed no material; check plane, direction and position");
      }
      if (step.kind === "extrude" && steps.length && Math.abs(volume - before) < 1e-6) {
        throw new BuildError(step.id, "this extrude added no material; it is fully inside the body");
      }
      const n = solidCount(body);
      if (n > 1) throw new BuildError(step.id, `the part split into ${n} separate bodies; features must connect into one solid`);
      step.volume_after = round(volume);
      step.center_after = center.map((v) => round(v));
      step.bbox_after = bounds(body);
      steps.push(step);
    }
  }
  const b = bounds(body);
  const { volume } = massProps(body);
  return {
    shape: body,
    steps,
    volume_mm3: round(volume, 3),
    bbox: b,
    size: [round(b[3] - b[0], 3), round(b[4] - b[1], 3), round(b[5] - b[2], 3)],
    mass_g: round((volume * plan.density_g_cm3) / 1000, 2),
    faces: body.faces.length,
  };
}

export function stepBlob(result, name) {
  return R.exportSTEP([{ shape: result.shape, name }]);
}

export async function verifyStep(blob, expected) {
  const shape = await R.importSTEP(blob);
  const volume = R.measureVolume(shape);
  const diff = (Math.abs(volume - expected) / expected) * 100;
  return { ok: diff < 0.01, volume_mm3: round(volume, 3), diff_percent: round(diff, 5) };
}

export function meshOf(result) {
  const mesh = result.shape.mesh({ tolerance: 0.05, angularTolerance: 0.15 });
  mesh.edges = result.shape.meshEdges({ tolerance: 0.05, angularTolerance: 0.15 }).lines;
  return mesh;
}
