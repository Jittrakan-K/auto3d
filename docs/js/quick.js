// Reads a short Thai or English command and writes a plan, with no AI and no cost.
// It covers plain parts: plates and blocks, round bars, tubes and discs, with holes,
// slots, pockets, rounded corners and chamfers. Anything else goes to Claude.

const NUM = "(\\d+(?:\\.\\d+)?)";
const n = (s) => Number(s);

// Clearance hole for a bolt, ISO 273 medium series
const CLEARANCE = { 2: 2.4, 2.5: 2.9, 3: 3.4, 4: 4.5, 5: 5.5, 6: 6.6, 8: 9, 10: 11, 12: 13.5, 14: 15.5, 16: 17.5, 20: 22, 24: 26 };
// Tap drill for a coarse thread
const TAP = { 2: 1.6, 2.5: 2.05, 3: 2.5, 4: 3.3, 5: 4.2, 6: 5, 8: 6.8, 10: 8.5, 12: 10.2, 14: 12, 16: 14, 20: 17.5, 24: 21 };

const MATERIALS = [
  [/อะ?ค[รล]?[ิี]?ล[ิี]?ค|acryl|pmma|แผ่นใส/, "Acrylic", 1.19],
  [/สแตนเลส|stainless|sus\s?304/, "Stainless steel", 7.93],
  [/อลู|aluminium|aluminum|al\s?6061/, "Aluminium", 2.7],
  [/ทองเหลือง|brass/, "Brass", 8.5],
  [/ทองแดง|copper/, "Copper", 8.96],
  [/\bpom\b|ปอม|delrin/, "POM", 1.41],
  [/\babs\b/, "ABS", 1.05],
  [/ไนลอน|nylon/, "Nylon", 1.14],
  [/\bpla\b/, "PLA", 1.24],
  [/ไม้|wood/, "Wood", 0.6],
  [/เหล็ก|steel|ss400|s45c/, "Steel", 7.85],
];

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[×✕*]/g, "x")
    .replace(/[⌀ø∅φ]/g, "ø")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/(\d)\s*(?:มิลลิเมตร|มม\.?|mm)/g, "$1 ")
    .replace(/\s+/g, " ");
}

function grab(t, re) { const m = t.match(re); return m ? n(m[1]) : null; }

// "Ø20", "ø 20", "dia 20", "เส้นผ่าน(ศูนย์กลาง) 20", "d20"
function diameterAfter(t) {
  return grab(t, new RegExp(`(?:ø|dia(?:meter)?\\.?|เส้นผ่าน(?:ศูนย์กลาง)?|\\bd)\\s*=?\\s*${NUM}`));
}

function holeSize(t, notes) {
  const m = t.match(/(เกลียว|tap|thread)?\s*\bm\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const size = n(m[2]);
    if (m[1] && TAP[size]) { notes.push(`M${size} tapped hole uses a Ø${TAP[size]} tap drill (thread not modelled)`); return TAP[size]; }
    if (CLEARANCE[size]) { notes.push(`M${size} screw hole uses a Ø${CLEARANCE[size]} clearance hole`); return CLEARANCE[size]; }
    return size;
  }
  const d = diameterAfter(t) ?? grab(t, new RegExp(`(?:รู|holes?)\\s*(?:ขนาด|size|dia)?\\s*${NUM}(?!\\s*(?:รู|holes?|,))`));
  return d;
}

function points(t) {
  const out = [];
  const re = /\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/g;
  let m;
  while ((m = re.exec(t))) out.push([n(m[1]), n(m[2])]);
  return out;
}

// One command part such as "เจาะรู m8 ที่มุมทั้ง 4 ห่างขอบ 10"
function splitClauses(t) {
  return t.split(/(?=เจาะ|(?<!เจาะ)(?:(?<!\d\s*)รู|รู(?=[ก-๙]))(?!ใน|กลาง\s*(?:ø|ขนาด)?\s*\d)|\d+\s*holes?\b|(?<!\d\s*)holes?\b|ร่อง|สล็อต|slot|ช่อง|pocket|ลบมุม|ลบคม|มุมมน|มุมโค้ง|fillet|chamfer|round|(?<![a-z0-9ø])r(?=\s*\d))/);
}

export function quickPlan(text) {
  const t = normalize(text);
  const notes = [];
  const questions = [];
  const params = [];
  const features = [];
  let density = 7.85, material = "Steel";
  const mat = MATERIALS.find(([re]) => re.test(t));
  if (mat) { [, material, density] = mat; } else notes.push("No material given, using steel");

  const P = (name, value, label, confidence = "high") => {
    params.push({ name, value, label, source: "Command", confidence });
    return `=${name}`;
  };

  // ---------- body ----------
  const dims3 = t.match(new RegExp(`${NUM}\\s*x\\s*${NUM}\\s*x\\s*${NUM}`));
  const dims2 = t.match(new RegExp(`${NUM}\\s*x\\s*${NUM}`));
  const word = (re) => grab(t, new RegExp(`(?<![a-z])(?:${re})(?![a-z])\\s*=?\\s*${NUM}`));
  const isTube = /ท่อ|tube|pipe|บูช|bush|ปลอก|sleeve|แหวน|washer|spacer/.test(t);
  const isDisc = /หน้าแปลน|flange|แผ่นกลม|จาน|disc|disk|วงกลม/.test(t);
  const isBar = /เพลา|shaft|แท่งกลม|ทรงกระบอก|cylinder|\brod\b|\bpin\b|สลัก|แกนกลม/.test(t);

  let kind, name, size;
  if (isTube || isDisc || isBar) {
    const od = word("od|โต|นอก") ?? diameterAfter(t);
    const id = word("id|ใน") ?? grab(t, new RegExp(`รู(?:กลาง|ใน)\\s*(?:ø|ขนาด)?\\s*${NUM}`));
    const len = word("ยาว|length|long|l") ?? word("หนา|thick(?:ness)?|สูง|height|t") ?? (dims2 ? n(dims2[2]) : null);
    if (!od || !len) return { error: "Give a diameter (e.g. Ø20) and a length or thickness (e.g. length 100)" };
    kind = isBar && !isDisc ? "bar" : "disc";
    const D = P("D", od, "Outer diameter");
    const L = P(kind === "bar" ? "L" : "T", len, kind === "bar" ? "Length" : "Thickness");
    const sketch = [{ type: "circle", d: D }];
    if (id) {
      if (id >= od) return { error: "The inner diameter must be smaller than the outer diameter" };
      sketch.push({ type: "circle", d: P("ID", id, "Inner diameter") });
    }
    if (kind === "bar") {
      features.push({ id: "F1", type: "extrude", name: id ? "Tube" : "Bar", plane: "Right", sketch, depth: L });
      size = [len, od, od];
    } else {
      features.push({ id: "F1", type: "extrude", name: "Disc", plane: "Top", sketch, depth: L });
      size = [od, len, od];
    }
    name = `${kind === "bar" ? (id ? "Tube" : "Bar") : isDisc ? "Flange" : isTube && len > od / 2 ? "Tube" : "Ring"}_D${od}${id ? "_ID" + id : ""}x${len}`;
  } else {
    let a = null, b = null, h = null;
    if (dims3) [a, b, h] = [n(dims3[1]), n(dims3[2]), n(dims3[3])];
    const wide = word("กว้าง|width|w"), long = word("ยาว|length|l"), thick = word("หนา|สูง|thick(?:ness)?|height|h|t");
    if (wide) b = wide; if (long) a = long; if (thick) h = thick;
    if (!dims3 && dims2 && !(a && b)) { a = n(dims2[1]); b = n(dims2[2]); }
    if (!a || !b || !h) {
      return { error: "Give three sizes, e.g. 120x80x10, or width 80 length 120 thick 10" };
    }
    kind = "box";
    let L = Math.max(a, b), W = Math.min(a, b);
    // Hole positions decide which side runs along X
    const pts = points(t.replace(/\d+\s*x\s*\d+(\s*x\s*\d+)?/g, ""));
    if (pts.some(([x, y]) => x > L || y > W) && pts.every(([x, y]) => x <= W && y <= L)) [L, W] = [W, L];
    P("L", L, "Length (X)"); P("W", W, "Width"); P("T", h, /แผ่น|เพลท|plate|sheet/.test(t) ? "Thickness" : "Height");
    features.push({ id: "F1", type: "extrude", name: "Body", plane: "Top",
      sketch: [{ type: "rect", cx: "=L/2", cy: "=W/2", w: "=L", h: "=W" }], depth: "=T" });
    size = [L, h, W];
    name = `${/แผ่น|เพลท|plate|sheet/.test(t) ? "Plate" : "Block"}_${L}x${W}x${h}`;
    notes.push("Positions are measured from the part corner, X along the length, Y along the width");
  }

  // ---------- holes, slots, pockets, edges ----------
  let f = 1;
  const top = kind === "box" ? "=T" : kind === "disc" ? "=T" : null;
  const centre = kind === "box" ? [["=L/2", "=W/2"]] : [[0, 0]];
  const done = new Set();
  for (const raw of splitClauses(t)) {
    const c = raw.trim();
    if (!c) continue;

    if (/ร่อง|สล็อต|slot/.test(c) && !done.has(c)) {
      const len = grab(c, new RegExp(`(?:ยาว|length|l)\\s*${NUM}`)), wid = grab(c, new RegExp(`(?:กว้าง|width|w)\\s*${NUM}`));
      const d2 = c.match(new RegExp(`${NUM}\\s*x\\s*${NUM}`));
      const sl = len ?? (d2 && Math.max(n(d2[1]), n(d2[2]))), sw = wid ?? (d2 && Math.min(n(d2[1]), n(d2[2])));
      if (!sl || !sw || sl <= sw) return { error: "Give the slot as length x width, e.g. slot 30x8 (length must exceed width)" };
      const at = points(c.replace(new RegExp(`${NUM}\\s*x\\s*${NUM}`), ""))[0];
      const depth = grab(c, new RegExp(`(?:ลึก|depth|deep)\\s*${NUM}`));
      const [cx, cy] = at || centre[0];
      if (!top) return { error: "Slots on round parts need Claude" };
      features.push({ id: `F${++f}`, type: "cut", name: "Slot", plane: "Top", offset: top, direction: "reverse",
        sketch: [{ type: "slot", cx, cy, length: sl, width: sw, angle_deg: /แนวตั้ง|vertical|ตามแนว y/.test(c) ? 90 : 0 }],
        ...(depth ? { depth } : { through: true }) });
      if (!at) notes.push("Slot placed at the centre of the part");
      continue;
    }

    if (/ช่อง|pocket/.test(c)) {
      const d2 = c.match(new RegExp(`${NUM}\\s*x\\s*${NUM}`));
      if (!d2 || !top) return { error: "Give the pocket as width x length, e.g. pocket 40x20 depth 5" };
      const depth = grab(c, new RegExp(`(?:ลึก|depth|deep)\\s*${NUM}`));
      const at = points(c.replace(d2[0], ""))[0];
      const [cx, cy] = at || centre[0];
      features.push({ id: `F${++f}`, type: "cut", name: "Pocket", plane: "Top", offset: top, direction: "reverse",
        sketch: [{ type: "rect", cx, cy, w: n(d2[1]), h: n(d2[2]) }], ...(depth ? { depth } : { through: true }) });
      continue;
    }

    if (/เจาะ|รู|hole/.test(c) && !/รู(?:กลาง|ใน)\s*(?:ø|ขนาด)?\s*\d/.test(c) || (/รูกลาง/.test(c) && kind === "box")) {
      let d = holeSize(c, notes);
      if (!d) {
        d = 5;
        questions.push("No hole size given, using Ø5 mm. Change it in the dimensions table");
      }
      if (!top) return { error: "Holes on round bars need Claude" };
      const depth = grab(c, new RegExp(`(?:ลึก|depth|deep)\\s*${NUM}`));
      const hn = features.filter((x) => x.type === "hole").length + 1;
      const hole = { id: `F${++f}`, type: "hole", name: "Holes", plane: "Top", offset: top, direction: "reverse",
        diameter: P(`HOLE${hn}`, d, hn > 1 ? `Hole size, set ${hn}` : "Hole size", questions.length && d === 5 ? "low" : "high"),
        ...(depth ? { depth } : { through: true }) };
      const pcd = grab(c, new RegExp(`(?:pcd|p\\.c\\.d|bcd|วงกลม)\\s*${NUM}`));
      const count = grab(c, /(\d+)\s*(?:รู|holes?)/) ?? grab(c, /(?:ทั้ง|จำนวน)\s*(\d+)/);
      const edge = grab(c, new RegExp(`(?:ห่างขอบ|จากขอบ|from (?:the )?edges?|edge distance)\\s*${NUM}`)) ??
        grab(c, new RegExp(`${NUM}\\s*(?:from (?:the )?edges?)`));
      const pts = points(c);
      if (pcd) {
        hole.bolt_circle = { pcd, count: count || 4, start_deg: 0 };
        if (!count) notes.push("No bolt hole count given, using 4");
        if (kind === "box") hole.bolt_circle = { ...hole.bolt_circle, cx: "=L/2", cy: "=W/2" };
      } else if (/มุม|corner/.test(c) || (edge && kind === "box")) {
        if (kind !== "box") return { error: "Corner holes work on rectangular parts only" };
        const e = edge ?? Math.max(d, 5);
        if (!edge) notes.push(`No edge distance given, using ${e} mm`);
        hole.grid = { cx: "=L/2", cy: "=W/2", nx: 2, ny: 2, dx: `=L-${2 * e}`, dy: `=W-${2 * e}` };
      } else if (pts.length) {
        hole.points = pts;
      } else {
        hole.points = centre;
      }
      features.push(hole);
      continue;
    }

    const r = grab(c, new RegExp(`(?<![a-z])r\\s*${NUM}`)) ?? grab(c, new RegExp(`(?:fillet|มุมมน|มุมโค้ง|รัศมี|radius)\\s*${NUM}`));
    const ch = grab(c, new RegExp(`(?<![a-z])c\\s*${NUM}`)) ?? grab(c, new RegExp(`(?:chamfer|ลบคม|ลบมุม)\\s*${NUM}`));
    if (r && /(ลบมุม|มุมมน|มุมโค้ง|fillet|round|\br\s*\d)/.test(c)) {
      if (kind !== "box") return { error: "Rounded edges on round parts need Claude" };
      features.push({ id: `F${++f}`, type: "fillet", name: "Corner radius", radius: r, edges: { parallel_to: "Y" } });
      continue;
    }
    if (ch && /(ลบคม|ลบมุม|chamfer|\bc\s*\d)/.test(c)) {
      const edges = kind === "box" ? { on: { axis: "Y", at: "max" } } : kind === "bar" ? { kind: "circle" } : { on: { axis: "Y", at: "max" }, kind: "circle" };
      features.push({ id: `F${++f}`, type: "chamfer", name: "Chamfer", distance: ch, edges });
    }
  }

  // Edges last, as an engineer would build it
  const order = { extrude: 0, cut: 1, hole: 1, fillet: 2, chamfer: 3 };
  features.sort((a, b) => order[a.type] - order[b.type]);
  features.forEach((x, i) => { x.id = `F${i + 1}`; });

  return {
    plan: {
      name: name.replace(/\./g, "_"),
      description: `${material} ${size.map((v) => +v.toFixed(2)).join(" x ")} mm`,
      density_g_cm3: density,
      parameters: params,
      features,
      assumptions: [`Read without AI, material: ${material}`, ...notes],
      questions,
    },
  };
}
