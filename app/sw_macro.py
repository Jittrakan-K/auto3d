"""Writes a SOLIDWORKS macro that rebuilds the part inside the user's own SOLIDWORKS.

It uses late binding only, so the text runs as a .swb macro or pasted into any VBA module
of SOLIDWORKS 2018, without references. Same self-check as the COM backend.
"""
from __future__ import annotations

import math
import re

from .cad_engine import Step

HELPERS = r'''
Function FindPlanes() As Boolean
    Dim f As Object, n As Long
    Set f = Part.FirstFeature
    Do While Not f Is Nothing And n < 3
        If f.GetTypeName2 = "RefPlane" Then
            Set Planes(n) = f
            n = n + 1
        End If
        Set f = f.GetNextFeature
    Loop
    FindPlanes = (n = 3)
End Function

Function OffsetPlane(idx As Long, offM As Double) As Object
    If offM <= 0 Then
        Set OffsetPlane = Planes(idx)
        Exit Function
    End If
    Part.ClearSelection2 True
    Planes(idx).Select2 False, 0
    Set OffsetPlane = fm.InsertRefPlane(8, offM, 0, 0, 0, 0)
End Function

Sub BeginSketch(pl As Object)
    Part.ClearSelection2 True
    pl.Select2 False, 0
    sm.InsertSketch True
    sm.AddToDB = True
    sm.DisplayWhenAdded = False
End Sub

Function EndSketch() As String
    sm.AddToDB = False
    sm.DisplayWhenAdded = True
    sm.InsertSketch True
    EndSketch = Part.FeatureByPositionReverse(0).Name
End Function

Function Matches(expV As Double, ex As Double, ey As Double, ez As Double) As Boolean
    Dim mp As Object, c As Variant, v As Double, dx As Double, dy As Double, dz As Double
    Matches = False
    On Error Resume Next
    Set mp = Part.Extension.CreateMassProperty
    v = mp.Volume * 1E+09
    c = mp.CenterOfMass
    If Err.Number <> 0 Then
        Err.Clear
        Exit Function
    End If
    On Error GoTo 0
    dx = c(0) * 1000 - ex: dy = c(1) * 1000 - ey: dz = c(2) * 1000 - ez
    Matches = (Abs(v - expV) / expV <= 0.0005) And (dx * dx + dy * dy + dz * dz <= 0.0025)
End Function

Function PickSketch(nm As String) As Boolean
    Part.ClearSelection2 True
    PickSketch = Part.Extension.SelectByID2(nm, "SKETCH", 0, 0, 0, False, 0, Nothing, 0)
End Function

Sub Solid(label As String, nm As String, isCut As Boolean, sd As Boolean, t1 As Long, t2 As Long, d1 As Double, _
          dang As Double, t0 As Long, startM As Double, firstDir As Boolean, _
          expV As Double, ex As Double, ey As Double, ez As Double)
    Dim f As Object, a As Long, b As Long, c As Long, dirFlag As Boolean, fs As Boolean, dOut As Boolean
    Dim useDraft As Boolean, nA As Long, nB As Long
    useDraft = (dang > 0)
    nA = 0: If t0 = 3 Then nA = 1
    nB = 0: If useDraft Then nB = 1
    For a = 0 To nA
        For b = 0 To nB
            For c = 0 To 1
                fs = (a = 1): dOut = (b = 1)
                dirFlag = firstDir: If c = 1 Then dirFlag = Not firstDir
                PickSketch nm
                Set f = Nothing
                On Error Resume Next
                If isCut Then
                    Set f = fm.FeatureCut4(sd, False, dirFlag, t1, t2, d1, 0.01, useDraft, False, dOut, False, _
                        IIf(useDraft, dang, 0.0175), 0.0175, False, False, False, False, False, True, True, _
                        True, True, False, t0, startM, fs, False)
                Else
                    Set f = fm.FeatureExtrusion2(sd, False, dirFlag, t1, t2, d1, 0, useDraft, False, dOut, False, _
                        IIf(useDraft, dang, 0.0175), 0.0175, False, False, False, False, True, True, True, _
                        t0, startM, fs)
                End If
                On Error GoTo 0
                If Not f Is Nothing Then
                    Part.EditRebuild3
                    If Matches(expV, ex, ey, ez) Then
                        On Error Resume Next
                        f.Name = label
                        On Error GoTo 0
                        Exit Sub
                    End If
                    Part.EditUndo2 1
                    Part.EditRebuild3
                End If
            Next c
        Next b
    Next a
    Problems = Problems & label & vbCrLf
End Sub

Sub Revolve(label As String, nm As String, isCut As Boolean, ang As Double, expV As Double, ex As Double, ey As Double, ez As Double)
    Dim f As Object, c As Long
    For c = 0 To 1
        PickSketch nm
        Set f = fm.FeatureRevolve2(True, True, False, isCut, (c = 1), False, 0, 0, ang, 0, False, False, 0, 0, 0, 0, 0, True, True, True)
        If Not f Is Nothing Then
            Part.EditRebuild3
            If Matches(expV, ex, ey, ez) Then
                On Error Resume Next
                f.Name = label
                On Error GoTo 0
                Exit Sub
            End If
            Part.EditUndo2 1
            Part.EditRebuild3
        End If
    Next c
    Problems = Problems & label & vbCrLf
End Sub

Sub PickEdge(x As Double, y As Double, z As Double)
    ' Pick by geometry so the result does not depend on the current view.
    Dim b As Variant, e As Variant, p As Variant, sd As Object, i As Long
    Dim dx As Double, dy As Double, dz As Double
    b = Part.GetBodies2(0, False)
    e = b(0).GetEdges
    Set sd = Part.SelectionManager.CreateSelectData
    sd.Mark = 1
    For i = 0 To UBound(e)
        p = e(i).GetClosestPointOn(x, y, z)
        dx = p(0) - x: dy = p(1) - y: dz = p(2) - z
        If dx * dx + dy * dy + dz * dz < 0.000000000001 Then
            e(i).Select4 True, sd
            Exit Sub
        End If
    Next i
End Sub

Sub FinishFillet(label As String, r As Double, expV As Double, ex As Double, ey As Double, ez As Double)
    Dim a0(0) As Double, v As Variant, f As Object
    a0(0) = 0
    v = a0
    Set f = fm.FeatureFillet3(195, r, r, 0, 0, 0, 0, v, v, v, v, v, v, v)
    Part.EditRebuild3
    If Matches(expV, ex, ey, ez) Then
        If Not f Is Nothing Then f.Name = label
    Else
        Problems = Problems & label & vbCrLf
    End If
End Sub

Sub FinishChamfer(label As String, d As Double, expV As Double, ex As Double, ey As Double, ez As Double)
    Dim f As Object
    Set f = fm.InsertFeatureChamfer(6, 1, d, 0.785398163397448, 0, 0, 0, 0)
    Part.EditRebuild3
    If Matches(expV, ex, ey, ez) Then
        If Not f Is Nothing Then f.Name = label
    Else
        Problems = Problems & label & vbCrLf
    End If
End Sub
'''


def _ascii(text: str, fallback: str) -> str:
    """VBA source is ANSI, so keep labels ASCII. Quotes would also break the string."""
    clean = re.sub(r"[^A-Za-z0-9 _.\-]", "", text).strip()
    return clean or fallback


def _num(v: float) -> str:
    return repr(round(float(v), 12))


def _m(mm: float) -> str:
    return _num(float(mm) / 1000)


def _vb(flag: bool) -> str:
    return "True" if flag else "False"


def _entity(s: dict) -> str:
    if s["t"] == "line":
        a, b = s["a"], s["b"]
        return f"    sm.CreateLine {_m(a[0])}, {_m(a[1])}, 0, {_m(b[0])}, {_m(b[1])}, 0"
    if s["t"] == "circle":
        return f"    sm.CreateCircleByRadius {_m(s['c'][0])}, {_m(s['c'][1])}, 0, {_m(s['r'])}"
    c, a, b = s["c"], s["a"], s["b"]
    return (
        f"    sm.CreateArc {_m(c[0])}, {_m(c[1])}, 0, {_m(a[0])}, {_m(a[1])}, 0, "
        f"{_m(b[0])}, {_m(b[1])}, 0, {1 if s['ccw'] else -1}"
    )


def _expect(step: Step) -> str:
    c = step.center_after
    return f"{_num(step.volume_after)}, {_num(c[0])}, {_num(c[1])}, {_num(c[2])}"


def _step_sub(i: int, step: Step) -> str:
    label = _ascii(step.name, step.id)
    lines = [f"Sub Step{i}()"]
    if step.kind in ("fillet", "chamfer"):
        lines.append("    Part.ClearSelection2 True")
        for x, y, z in step.edge_points:
            lines.append(f"    PickEdge {_m(x)}, {_m(y)}, {_m(z)}")
        fn = "FinishFillet" if step.kind == "fillet" else "FinishChamfer"
        lines.append(f'    {fn} "{label}", {_m(step.size)}, {_expect(step)}')
    else:
        idx = {"Front": 0, "Top": 1, "Right": 2}[step.plane]
        off = max(step.offset, 0.0)
        lines += ["    Dim nm As String", f"    BeginSketch OffsetPlane({idx}, {_m(off)})"]
        lines += [_entity(s) for loop in step.loops for s in loop]
        if step.axis:
            (ax, ay), (bx, by) = step.axis
            lines.append(f"    sm.CreateCenterLine {_m(ax)}, {_m(ay)}, 0, {_m(bx)}, {_m(by)}, 0")
        lines.append("    nm = EndSketch()")
        if step.kind == "revolve":
            lines.append(
                f'    Revolve "{label}", nm, {_vb(step.is_cut)}, {_num(math.radians(step.angle_deg))}, {_expect(step)}'
            )
        else:
            is_cut = step.kind == "cut"
            both = step.direction == "both"
            if is_cut and step.through and both:
                sd, t1, t2 = False, 1, 1
            elif is_cut and step.through:
                sd, t1, t2 = True, 1, 0
            elif both:
                sd, t1, t2 = True, 6, 0
            else:
                sd, t1, t2 = True, 0, 0
            depth = "0.01" if step.through else _m(step.depth)
            t0, start = (3, _m(abs(step.offset))) if step.offset < 0 else (0, "0.0")
            dang = _num(math.radians(step.draft_deg))
            lines.append(
                f'    Solid "{label}", nm, {_vb(is_cut)}, {_vb(sd)}, {t1}, {t2}, {depth}, {dang}, {t0}, {start}, '
                f"{_vb(step.direction == 'reverse')}, {_expect(step)}"
            )
    lines.append("End Sub")
    return "\n".join(lines)


def render(steps: list[Step], part_name: str, quiet: bool = False) -> str:
    """quiet replaces the closing message box with a text file, for unattended tests."""
    file_name = _ascii(part_name, "AutoDesign_Part").replace(" ", "_")
    calls = "\n".join(f"    Step{i}" for i in range(1, len(steps) + 1))
    subs = "\n\n".join(_step_sub(i, s) for i, s in enumerate(steps, 1))
    head = f'''' AUTO DESIGN 3D macro for SOLIDWORKS 2018
' Tools > Macro > Run, choose this .swb file (or paste it into a new macro).
' It builds the part, then saves {file_name}.SLDPRT next to this macro.
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
{calls}
    Part.ClearSelection2 True
    Part.EditRebuild3
    folder = swApp.GetCurrentMacroPathFolder
    target = folder & "\\{file_name}.SLDPRT"
    Part.SaveAs3 target, 0, 1
    If Problems = "" Then
        MsgBox "Done. All features match the STEP model." & vbCrLf & target
    Else
        MsgBox "Saved, but check these features:" & vbCrLf & Problems & vbCrLf & target
    End If
End Sub
'''
    if quiet:
        head = head.replace(
            'MsgBox "Done. All features match the STEP model." & vbCrLf & target',
            'WriteResult folder, "PASS"',
        ).replace(
            'MsgBox "Saved, but check these features:" & vbCrLf & Problems & vbCrLf & target',
            'WriteResult folder, "CHECK " & Problems',
        )
        head += """
Sub WriteResult(folder As String, text As String)
    Dim n As Integer
    n = FreeFile
    Open folder & "\\macro_result.txt" For Output As #n
    Print #n, text
    Close #n
End Sub
"""
    return "\r\n".join((head + "\n" + subs + "\n" + HELPERS).splitlines()) + "\r\n"
