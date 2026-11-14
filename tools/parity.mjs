// Builds every example with the browser engine and compares it with the Python engine.
//   cd tools && npm install && python -m tools.dump_reference && npm run parity
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const P = await import(new URL("../docs/js/plan.js", import.meta.url));
const E = await import(new URL("../docs/js/cad.js", import.meta.url));
const M = await import(new URL("../docs/js/macro.js", import.meta.url));
const wasm = fileURLToPath(new URL("./node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
R.setOC(await opencascade({ locateFile: () => wasm }));
E.useKernel(R);
M.useHelpers(fs.readFileSync(`${root}docs/assets/macro-helpers.bas`, "utf8"));
const ref = JSON.parse(fs.readFileSync(`${root}tools/reference.json`, "utf8"));
const NUM = /-?[\d.]+(e[-+]\d+)?/g;
let bad = 0;
for (const [name, py] of Object.entries(ref)) {
  const plan = P.parsePlan(JSON.parse(fs.readFileSync(`${root}docs/examples/${name}`, "utf8")));
  const r = E.build(plan);
  const dv = (Math.abs(r.volume_mm3 - py.volume) / py.volume) * 100;
  if (dv > 0.01) { bad++; console.log(name, "volume differs", dv); }
  r.steps.forEach((s, i) => {
    const p = py.steps[i];
    const v = (Math.abs(s.volume_after - p.v) / p.v) * 100;
    const c = Math.hypot(...s.center_after.map((x, k) => x - p.c[k]));
    if (v > 0.01 || c > 0.01 || s.edge_points.length !== p.edges.length) { bad++; console.log(name, s.id, { v, c }); }
  });
  // Hole Wizard lines are written by the browser only; the desktop app still cuts holes from sketches.
  const WIZ = /^(    If HoleWiz\(|        WizFlag 1$|        Exit Sub$|    End If$|    WizFlag 0$|    If WizFlag\(\) Then Exit Sub$)/;
  const a = M.render(r.steps, plan.name).split("\r\n").filter((l) => !WIZ.test(l)), b = py.macro.split("\r\n").filter((l) => !WIZ.test(l));
  if (a.length !== b.length) { bad++; console.log(name, "macro length differs"); }
  a.forEach((l, i) => {
    const x = l.match(NUM) || [], y = (b[i] || "").match(NUM) || [];
    if (l.replace(NUM, "#") !== (b[i] || "").replace(NUM, "#") || x.some((n, k) => Math.abs(n - y[k]) > 1e-6 * Math.max(1, Math.abs(n)))) {
      bad++; console.log(name, "macro line", i, l, "|", b[i]);
    }
  });
  console.log(name, bad ? "" : "matches");
}
console.log(bad ? `${bad} difference(s)` : "browser engine matches the Python engine");
process.exit(bad ? 1 : 0);
