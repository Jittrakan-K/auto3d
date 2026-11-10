// Builds typical commands with the no-AI reader (docs/js/quick.js). Run: cd tools && npm install && node quick.mjs
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
const P = await import(new URL("../docs/js/plan.js", import.meta.url));
const E = await import(new URL("../docs/js/cad.js", import.meta.url));
const Q = await import(new URL("../docs/js/quick.js", import.meta.url));
R.setOC(await opencascade({ locateFile: () => new URL("./node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url).pathname }));
E.useKernel(R);
const cases = [
 "แผ่นอะคลิลิคขนาด 30x60x5 mm เจาะรูจากตำแหน่ง x, y = 15,15 mm และ 45,15 mm",
 "แผ่นเพลทเหล็ก 120 x 80 หนา 10 มม. เจาะรู M8 ที่มุมทั้ง 4 ห่างขอบ 10 มม. ลบมุม R5",
 "เพลา Ø20 ยาว 100 ลบคม C1",
 "ท่อ OD 30 ID 20 ยาว 50",
 "หน้าแปลน Ø120 หนา 12 รูกลาง Ø50 รูน็อต 6 รู PCD 95 Ø11",
 "บล็อกอลูมิเนียม กว้าง 50 ยาว 80 สูง 30 รูกลาง Ø10 ลึก 15",
 "plate 100x60x8 steel 4 holes M6 10mm from edges fillet 3",
 "กล่อง 40x40x20 ร่อง 30x6",
 "แผ่น 200x100x6 ช่อง 40x20 ลึก 3 เจาะรู Ø6 ที่ (20,20) (180,20) (20,80) (180,80) ลบคม C0.5",
 "ทำเฟืองตรง 20 ฟัน",
];
for (const c of cases) {
  const q = Q.quickPlan(c);
  if (q.error) { console.log("ERR ", c, "→", q.error); continue; }
  try {
    const plan = P.parsePlan(q.plan); const r = E.build(plan);
    console.log("OK  ", c, "→", plan.name, r.size.join("x"), "vol", r.volume_mm3, "|", plan.features.map(f => f.type + (f.points ? JSON.stringify(f.points) : "") + (f.diameter ? "Ø" + f.diameter : "")).join(" "));
  } catch (e) { console.log("FAIL", c, "→", e.message); }
}
