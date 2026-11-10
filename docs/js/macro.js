// Writes the SOLIDWORKS macro (.swb). Same text as app/sw_macro.py, checked by tools/parity.mjs.
// It runs in SOLIDWORKS 2018 and newer and saves an SLDPRT in that version, with a Feature Tree.
let HELPERS = "";
export function useHelpers(text) { HELPERS = text; }

const ascii = (text, fallback) => (text || "").replace(/[^A-Za-z0-9 _.\-]/g, "").trim() || fallback;

// Python repr(round(v, 12)), so the macro matches the desktop app digit for digit.
export function num(v) {
  let x = Number(Number(v).toFixed(12));
  if (Object.is(x, -0)) x = 0;
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = x.toExponential().split("e");
    const n = Number(e);
    return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  return String(x);
}
const m = (mm) => num(Number(mm) / 1000);
const vb = (f) => (f ? "True" : "False");
const rad = (deg) => (deg * Math.PI) / 180;

function entity(s) {
  if (s.t === "line") return `    sm.CreateLine ${m(s.a[0])}, ${m(s.a[1])}, 0, ${m(s.b[0])}, ${m(s.b[1])}, 0`;
  if (s.t === "circle") return `    sm.CreateCircleByRadius ${m(s.c[0])}, ${m(s.c[1])}, 0, ${m(s.r)}`;
  return `    sm.CreateArc ${m(s.c[0])}, ${m(s.c[1])}, 0, ${m(s.a[0])}, ${m(s.a[1])}, 0, ${m(s.b[0])}, ${m(s.b[1])}, 0, ${s.ccw ? 1 : -1}`;
}
const expect = (s) => `${num(s.volume_after)}, ${num(s.center_after[0])}, ${num(s.center_after[1])}, ${num(s.center_after[2])}`;

function stepSub(i, step) {
  const label = ascii(step.name, step.id);
  const lines = [`Sub Step${i}()`];
  if (step.kind === "fillet" || step.kind === "chamfer") {
    lines.push("    Part.ClearSelection2 True");
    for (const [x, y, z] of step.edge_points) lines.push(`    PickEdge ${m(x)}, ${m(y)}, ${m(z)}`);
    lines.push(`    ${step.kind === "fillet" ? "FinishFillet" : "FinishChamfer"} "${label}", ${m(step.size)}, ${expect(step)}`);
  } else {
    const idx = { Front: 0, Top: 1, Right: 2 }[step.plane];
    lines.push("    Dim nm As String", `    BeginSketch OffsetPlane(${idx}, ${m(Math.max(step.offset, 0))})`);
    for (const loop of step.loops) for (const s of loop) lines.push(entity(s));
    if (step.axis) {
      const [[ax, ay], [bx, by]] = step.axis;
      lines.push(`    sm.CreateCenterLine ${m(ax)}, ${m(ay)}, 0, ${m(bx)}, ${m(by)}, 0`);
    }
    lines.push("    nm = EndSketch()");
    if (step.kind === "revolve") {
      lines.push(`    Revolve "${label}", nm, ${vb(step.is_cut)}, ${num(rad(step.angle_deg))}, ${expect(step)}`);
    } else {
      const isCut = step.kind === "cut", both = step.direction === "both";
      const [sd, t1, t2] = isCut && step.through && both ? [false, 1, 1]
        : isCut && step.through ? [true, 1, 0] : both ? [true, 6, 0] : [true, 0, 0];
      const depth = step.through ? "0.01" : m(step.depth);
      const [t0, start] = step.offset < 0 ? [3, m(Math.abs(step.offset))] : [0, "0.0"];
      lines.push(`    Solid "${label}", nm, ${vb(isCut)}, ${vb(sd)}, ${t1}, ${t2}, ${depth}, ${num(rad(step.draft_deg))}, ${t0}, ${start}, ` +
        `${vb(step.direction === "reverse")}, ${expect(step)}`);
    }
  }
  lines.push("End Sub");
  return lines.join("\n");
}

export function render(steps, partName) {
  const fileName = ascii(partName, "AutoDesign_Part").replaceAll(" ", "_");
  const calls = steps.map((_, i) => `    Step${i + 1}`).join("\n");
  const subs = steps.map((s, i) => stepSub(i + 1, s)).join("\n\n");
  const head = `' AUTO DESIGN 3D macro for SOLIDWORKS 2018
' Tools > Macro > Run, choose this .swb file (or paste it into a new macro).
' It builds the part, then saves ${fileName}.SLDPRT next to this macro.
Option Explicit
Dim swApp As Object
Dim Part As Object
Dim fm As Object
Dim sm As Object
Dim Planes(2) As Object
Dim Problems As String

Sub main()
    Dim tpl As String, folder As String, target As String
    Set swApp = Application.SldWorks
    tpl = swApp.GetUserPreferenceStringValue(8)
    If tpl = "" Then tpl = swApp.GetDocumentTemplate(1, "", 0, 0, 0)
    Set Part = swApp.NewDocument(tpl, 0, 0, 0)
    If Part Is Nothing Then
        MsgBox "Cannot create a new part. Set the default part template in System Options."
        Exit Sub
    End If
    Set fm = Part.FeatureManager
    Set sm = Part.SketchManager
    If Not FindPlanes() Then
        MsgBox "Front, Top and Right planes were not found in the template."
        Exit Sub
    End If
${calls}
    Part.ClearSelection2 True
    Part.EditRebuild3
    folder = swApp.GetCurrentMacroPathFolder
    target = folder & "\\${fileName}.SLDPRT"
    Part.SaveAs3 target, 0, 1
    If Problems = "" Then
        MsgBox "Done. All features match the STEP model." & vbCrLf & target
    Else
        MsgBox "Saved, but check these features:" & vbCrLf & Problems & vbCrLf & target
    End If
End Sub
`;
  const text = head + "\n" + subs + "\n" + HELPERS;
  return text.split(/\r\n|\n|\r/).filter((_, i, a) => !(i === a.length - 1 && _ === "")).join("\r\n") + "\r\n";
}
