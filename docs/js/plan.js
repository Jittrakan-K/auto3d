// CAD feature plan: the JSON that Claude writes and the engine builds.
// Same rules as app/plan.py. The AI never writes code, only this JSON.
// Coordinates follow SOLIDWORKS (Y up), lengths in millimetres.

export class PlanError extends Error {}

// ---------- arithmetic expressions such as "=L/2" ----------
const FUNCS = {
  sqrt: Math.sqrt,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: Math.round,
};

export function evaluate(expr, names) {
  if (expr.length > 200) throw new PlanError("expression too long");
  const tokens = expr.match(/\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*|[-+*/%(),])/gy);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== expr.replace(/\s/g, "")) {
    throw new PlanError(`'${expr}' is not a plain arithmetic expression`);
  }
  const t = tokens.map((s) => s.trim());
  let i = 0;
  const peek = () => t[i];
  const take = (want) => {
    if (want !== undefined && t[i] !== want) throw new PlanError(`cannot read expression '${expr}'`);
    return t[i++];
  };
  const sum = () => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + product() : v - product();
    return v;
  };
  const product = () => {
    let v = unary();
    while (["*", "/", "%"].includes(peek())) {
      const op = take();
      const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new PlanError(`division by zero in '${expr}'`);
      v = op === "*" ? v * r : op === "/" ? v / r : v - Math.floor(v / r) * r;
    }
    return v;
  };
  const unary = () => {
    if (peek() === "-") { take(); return -unary(); }
    if (peek() === "+") { take(); return unary(); }
    return power();
  };
  const power = () => {
    const base = atom();
    if (peek() === "**") { take(); return base ** unary(); }
    return base;
  };
  const atom = () => {
    const tok = take();
    if (tok === undefined) throw new PlanError(`cannot read expression '${expr}'`);
    if (tok === "(") { const v = sum(); take(")"); return v; }
    if (/^[\d.]/.test(tok)) return Number(tok);
    if (/^[A-Za-z_]/.test(tok)) {
      if (peek() === "(") {
        if (!Object.hasOwn(FUNCS, tok)) throw new PlanError(`'${expr}' is not a plain arithmetic expression`);
        take("(");
        const args = [];
        if (peek() !== ")") { args.push(sum()); while (peek() === ",") { take(); args.push(sum()); } }
        take(")");
        return FUNCS[tok](...args);
      }
      if (tok === "pi") return Math.PI;
      if (Object.hasOwn(names, tok)) return names[tok];
      throw new PlanError(`unknown name '${tok}' in '${expr}'`);
    }
    throw new PlanError(`cannot read expression '${expr}'`);
  };
  const v = sum();
  if (i !== t.length) throw new PlanError(`cannot read expression '${expr}'`);
  if (!Number.isFinite(v)) throw new PlanError(`'${expr}' does not give a number`);
  return v;
}

const INT_KEYS = new Set(["count", "nx", "ny", "sides"]);

export function resolve(raw) {
  const data = structuredClone(raw);
  const names = {};
  for (const p of data.parameters || []) {
    const v = p.value;
    names[p.name] = typeof v === "string" && v.startsWith("=") ? evaluate(v.slice(1), names) : Number(v);
    p.value = names[p.name];
  }
  const walk = (node, key) => {
    if (Array.isArray(node)) return node.map((v) => walk(v, key));
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    }
    if (typeof node === "string" && node.startsWith("=")) {
      const value = evaluate(node.slice(1), names);
      return INT_KEYS.has(key) ? Math.round(value) : value;
    }
    return node;
  };
  data.features = walk(data.features || []);
  return data;
}

// ---------- validation ----------
class Checker {
  constructor() { this.errors = []; }
  at(path, msg) { this.errors.push(`${path}: ${msg}`); }
  obj(v, path, allowed) {
    if (!v || typeof v !== "object" || Array.isArray(v)) { this.at(path, "must be an object"); return false; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.at(`${path}.${k}`, "extra field not allowed");
    return true;
  }
  num(o, k, path, { def, gt, ge, lt, le, int, required } = {}) {
    if (o[k] === undefined || o[k] === null) {
      if (required) this.at(`${path}.${k}`, "field required");
      if (def !== undefined) o[k] = def;
      return o[k];
    }
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) { this.at(`${path}.${k}`, "must be a number"); return; }
    if (int && !Number.isInteger(v)) this.at(`${path}.${k}`, "must be a whole number");
    if (gt !== undefined && !(v > gt)) this.at(`${path}.${k}`, `must be greater than ${gt}`);
    if (ge !== undefined && !(v >= ge)) this.at(`${path}.${k}`, `must be at least ${ge}`);
    if (lt !== undefined && !(v < lt)) this.at(`${path}.${k}`, `must be less than ${lt}`);
    if (le !== undefined && !(v <= le)) this.at(`${path}.${k}`, `must be at most ${le}`);
    return v;
  }
  point(v, path) {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      this.at(path, "must be [x, y] numbers");
      return false;
    }
    return true;
  }
  enumOf(o, k, path, options, def) {
    if (o[k] === undefined) { o[k] = def; return def; }
    if (!options.includes(o[k])) this.at(`${path}.${k}`, `must be one of ${options.join(", ")}`);
    return o[k];
  }
  str(o, k, path, def = "") {
    if (o[k] === undefined) { o[k] = def; return def; }
    if (typeof o[k] !== "string") this.at(`${path}.${k}`, "must be text");
    return o[k];
  }
}

const PLANES = ["Front", "Top", "Right"];

function checkEntity(c, e, path) {
  const type = e && e.type;
  if (type === "rect") {
    if (!c.obj(e, path, ["type", "cx", "cy", "w", "h"])) return;
    c.num(e, "cx", path, { def: 0 }); c.num(e, "cy", path, { def: 0 });
    c.num(e, "w", path, { required: true, gt: 0 }); c.num(e, "h", path, { required: true, gt: 0 });
  } else if (type === "circle") {
    if (!c.obj(e, path, ["type", "cx", "cy", "d"])) return;
    c.num(e, "cx", path, { def: 0 }); c.num(e, "cy", path, { def: 0 });
    c.num(e, "d", path, { required: true, gt: 0 });
  } else if (type === "slot") {
    if (!c.obj(e, path, ["type", "cx", "cy", "length", "width", "angle_deg"])) return;
    c.num(e, "cx", path, { def: 0 }); c.num(e, "cy", path, { def: 0 });
    const L = c.num(e, "length", path, { required: true, gt: 0 });
    const W = c.num(e, "width", path, { required: true, gt: 0 });
    c.num(e, "angle_deg", path, { def: 0 });
    if (L !== undefined && W !== undefined && L <= W) c.at(path, "slot length must be greater than width");
  } else if (type === "regular_polygon") {
    if (!c.obj(e, path, ["type", "cx", "cy", "sides", "d", "angle_deg"])) return;
    c.num(e, "cx", path, { def: 0 }); c.num(e, "cy", path, { def: 0 });
    c.num(e, "sides", path, { required: true, int: true, ge: 3, le: 64 });
    c.num(e, "d", path, { required: true, gt: 0 }); c.num(e, "angle_deg", path, { def: 0 });
  } else if (type === "profile") {
    if (!c.obj(e, path, ["type", "start", "segments"])) return;
    c.point(e.start, `${path}.start`);
    if (!Array.isArray(e.segments) || e.segments.length < 2) { c.at(`${path}.segments`, "needs at least 2 segments"); return; }
    e.segments.forEach((s, i) => {
      const sp = `${path}.segments.${i}`;
      if (s && "line_to" in s) { if (c.obj(s, sp, ["line_to"])) c.point(s.line_to, `${sp}.line_to`); }
      else if (s && "arc_to" in s) {
        if (!c.obj(s, sp, ["arc_to", "center", "ccw"])) return;
        c.point(s.arc_to, `${sp}.arc_to`); c.point(s.center, `${sp}.center`);
        if (s.ccw === undefined) s.ccw = true;
        else if (typeof s.ccw !== "boolean") c.at(`${sp}.ccw`, "must be true or false");
      } else c.at(sp, "must have line_to or arc_to");
    });
  } else {
    c.at(`${path}.type`, "must be rect, circle, slot, regular_polygon or profile");
  }
}

function checkSketch(c, f, path) {
  if (!Array.isArray(f.sketch) || f.sketch.length < 1) { c.at(`${path}.sketch`, "needs at least one entity"); return; }
  f.sketch.forEach((e, i) => checkEntity(c, e, `${path}.sketch.${i}`));
}

function checkFeature(c, f, path) {
  const base = ["id", "name", "type"];
  const type = f && f.type;
  const fields = {
    extrude: ["plane", "offset", "sketch", "depth", "direction"],
    cut: ["plane", "offset", "sketch", "depth", "through", "direction"],
    revolve: ["plane", "sketch", "axis_a", "axis_b", "angle_deg", "cut"],
    hole: ["plane", "offset", "direction", "points", "bolt_circle", "grid", "diameter", "depth", "through", "cbore_d", "cbore_depth", "csk_d", "csk_angle_deg"],
    fillet: ["radius", "edges"],
    chamfer: ["distance", "edges"],
  }[type];
  if (!fields) { c.at(`${path}.type`, "must be extrude, cut, revolve, hole, fillet or chamfer"); return; }
  if (!c.obj(f, path, [...base, ...fields])) return;
  if (typeof f.id !== "string" || !f.id) c.at(`${path}.id`, "field required");
  c.str(f, "name", path);
  if (["extrude", "cut", "revolve", "hole"].includes(type)) {
    if (!PLANES.includes(f.plane)) c.at(`${path}.plane`, "must be Front, Top or Right");
  }
  if (type === "extrude") {
    c.num(f, "offset", path, { def: 0 }); checkSketch(c, f, path);
    c.num(f, "depth", path, { required: true, gt: 0 });
    c.enumOf(f, "direction", path, ["normal", "reverse", "both"], "normal");
  } else if (type === "cut") {
    c.num(f, "offset", path, { def: 0 }); checkSketch(c, f, path);
    c.num(f, "depth", path, { gt: 0 });
    if (f.through === undefined) f.through = false;
    c.enumOf(f, "direction", path, ["normal", "reverse", "both"], "normal");
    if (f.through === (f.depth !== undefined && f.depth !== null)) c.at(path, "cut needs either depth or through=true, not both");
    if (f.direction === "both" && !f.through) c.at(path, "direction 'both' on a cut is only allowed with through=true");
  } else if (type === "revolve") {
    checkSketch(c, f, path);
    c.point(f.axis_a, `${path}.axis_a`); c.point(f.axis_b, `${path}.axis_b`);
    c.num(f, "angle_deg", path, { def: 360, gt: 0, le: 360 });
    if (f.cut === undefined) f.cut = false;
  } else if (type === "hole") {
    c.num(f, "offset", path, { def: 0 });
    c.enumOf(f, "direction", path, ["normal", "reverse"], "normal");
    if (f.points === undefined) f.points = [];
    if (!Array.isArray(f.points)) c.at(`${path}.points`, "must be a list");
    else f.points.forEach((p, i) => c.point(p, `${path}.points.${i}`));
    if (f.bolt_circle != null) {
      const b = f.bolt_circle, bp = `${path}.bolt_circle`;
      if (c.obj(b, bp, ["cx", "cy", "pcd", "count", "start_deg"])) {
        c.num(b, "cx", bp, { def: 0 }); c.num(b, "cy", bp, { def: 0 });
        c.num(b, "pcd", bp, { required: true, gt: 0 });
        c.num(b, "count", bp, { required: true, int: true, ge: 1, le: 256 });
        c.num(b, "start_deg", bp, { def: 0 });
      }
    }
    if (f.grid != null) {
      const g = f.grid, gp = `${path}.grid`;
      if (c.obj(g, gp, ["cx", "cy", "nx", "ny", "dx", "dy"])) {
        c.num(g, "cx", gp, { def: 0 }); c.num(g, "cy", gp, { def: 0 });
        c.num(g, "nx", gp, { required: true, int: true, ge: 1, le: 256 });
        c.num(g, "ny", gp, { required: true, int: true, ge: 1, le: 256 });
        c.num(g, "dx", gp, { def: 0 }); c.num(g, "dy", gp, { def: 0 });
      }
    }
    const d = c.num(f, "diameter", path, { required: true, gt: 0 });
    c.num(f, "depth", path, { gt: 0 });
    if (f.through === undefined) f.through = false;
    c.num(f, "cbore_d", path, { gt: 0 }); c.num(f, "cbore_depth", path, { gt: 0 });
    c.num(f, "csk_d", path, { gt: 0 }); c.num(f, "csk_angle_deg", path, { def: 90, gt: 0, lt: 180 });
    const has = (k) => f[k] !== undefined && f[k] !== null;
    if (f.through === has("depth")) c.at(path, "hole needs either depth or through=true, not both");
    if (!(f.points?.length || f.bolt_circle || f.grid)) c.at(path, "hole needs points, bolt_circle or grid");
    if (has("cbore_d") !== has("cbore_depth")) c.at(path, "counterbore needs both cbore_d and cbore_depth");
    if (has("cbore_d") && has("csk_d")) c.at(path, "a hole cannot be both counterbored and countersunk");
    if (has("cbore_d") && f.cbore_d <= d) c.at(path, "cbore_d must be larger than diameter");
    if (has("csk_d") && f.csk_d <= d) c.at(path, "csk_d must be larger than diameter");
  } else {
    c.num(f, type === "fillet" ? "radius" : "distance", path, { required: true, gt: 0 });
    if (f.edges === undefined) f.edges = {};
    const e = f.edges, ep = `${path}.edges`;
    if (c.obj(e, ep, ["parallel_to", "on", "kind", "near"])) {
      if (e.parallel_to != null && !["X", "Y", "Z"].includes(e.parallel_to)) c.at(`${ep}.parallel_to`, "must be X, Y or Z");
      if (e.kind != null && !["line", "circle"].includes(e.kind)) c.at(`${ep}.kind`, "must be line or circle");
      if (e.on != null && c.obj(e.on, `${ep}.on`, ["axis", "at"])) {
        if (!["X", "Y", "Z"].includes(e.on.axis)) c.at(`${ep}.on.axis`, "must be X, Y or Z");
        if (!(typeof e.on.at === "number" || e.on.at === "max" || e.on.at === "min")) c.at(`${ep}.on.at`, "must be a number, max or min");
      }
      if (e.near === undefined) e.near = [];
      if (!Array.isArray(e.near) || !e.near.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) {
        c.at(`${ep}.near`, "must be a list of [x, y, z]");
      }
    }
  }
}

export function parsePlan(raw) {
  if (!raw || typeof raw !== "object") throw new PlanError("The plan must be a JSON object");
  let data;
  try {
    data = resolve(raw);
  } catch (e) {
    throw new PlanError(`The plan could not be read: ${e.message}`);
  }
  const c = new Checker();
  c.obj(data, "plan", ["name", "description", "density_g_cm3", "parameters", "features", "assumptions", "questions", "check"]);
  if (data.check != null) {
    if (c.obj(data.check, "check", ["size", "holes"])) {
      const sz = data.check.size;
      if (sz != null && !(Array.isArray(sz) && sz.length === 3 && sz.every((v) => typeof v === "number" && v > 0))) c.at("check.size", "must be three positive numbers [X, Y, Z]");
      if (data.check.holes != null && !(Number.isInteger(data.check.holes) && data.check.holes >= 0)) c.at("check.holes", "must be a whole number");
    }
  }
  if (typeof data.name !== "string" || !data.name.length || data.name.length > 80) c.at("name", "must be 1 to 80 characters");
  c.str(data, "description", "plan");
  c.num(data, "density_g_cm3", "plan", { def: 7.85, gt: 0 });
  data.parameters = data.parameters || [];
  data.parameters.forEach((p, i) => {
    const pp = `parameters.${i}`;
    if (!c.obj(p, pp, ["name", "value", "label", "source", "confidence"])) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name || "")) c.at(`${pp}.name`, "must be a simple name such as L or HOLE_D");
    c.str(p, "label", pp); c.str(p, "source", pp);
    c.enumOf(p, "confidence", pp, ["high", "medium", "low"], "high");
  });
  data.assumptions = data.assumptions || [];
  data.questions = data.questions || [];
  if (!Array.isArray(data.features) || data.features.length < 1) {
    c.at("features", "needs at least one feature");
  } else {
    data.features.forEach((f, i) => checkFeature(c, f, `features.${i}`));
    const first = data.features[0];
    if (!(first.type === "extrude" || (first.type === "revolve" && !first.cut))) {
      c.at("features", "the first feature must be an extrude or a non-cut revolve");
    }
    const ids = data.features.map((f) => f.id);
    if (new Set(ids).size !== ids.length) c.at("features", "feature ids must be unique");
  }
  if (c.errors.length) throw new PlanError("The plan does not match the schema:\n" + c.errors.slice(0, 12).join("\n"));
  return data;
}

export function holePoints(h) {
  const pts = [...(h.points || [])];
  if (h.bolt_circle) {
    const b = h.bolt_circle;
    for (let i = 0; i < b.count; i++) {
      const a = ((b.start_deg + (360 * i) / b.count) * Math.PI) / 180;
      pts.push([b.cx + (b.pcd / 2) * Math.cos(a), b.cy + (b.pcd / 2) * Math.sin(a)]);
    }
  }
  if (h.grid) {
    const g = h.grid;
    for (let i = 0; i < g.nx; i++) {
      for (let j = 0; j < g.ny; j++) pts.push([g.cx + (i - (g.nx - 1) / 2) * g.dx, g.cy + (j - (g.ny - 1) / 2) * g.dy]);
    }
  }
  return pts;
}
