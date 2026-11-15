
Sub LogLine(t As String)
    ' Writes AUTO3D_log.txt next to the macro, to see what SOLIDWORKS did at each step.
    Static started As Boolean
    Dim fn As Integer, path As String
    On Error Resume Next
    path = swApp.GetCurrentMacroPathFolder & "\AUTO3D_log.txt"
    fn = FreeFile
    If started Then
        Open path For Append As #fn
    Else
        Open path For Output As #fn
        started = True
    End If
    Print #fn, t
    Close #fn
    Err.Clear
End Sub

Function FindPlanes() As Boolean
    ' Planes(0) faces Z, Planes(1) faces Y, Planes(2) faces X, whatever the template calls
    ' them, so a Z-up template builds the same part as the standard Y-up one.
    Dim f As Object, n As Long, k As Long, nv As Variant, found(2) As Object
    Set f = Part.FirstFeature
    Do While Not f Is Nothing And n < 3
        If f.GetTypeName2 = "RefPlane" Then
            Set Planes(n) = f
            n = n + 1
            nv = PlaneNormal(f)
            If IsArray(nv) Then LogLine "plane " & f.Name & " normal " & Format(nv(0), "0.00") & ", " & Format(nv(1), "0.00") & ", " & Format(nv(2), "0.00") Else LogLine "plane " & f.Name & " normal unknown"
            If IsArray(nv) Then
                For k = 0 To 2
                    If Abs(nv(2 - k)) > 0.99 Then Set found(k) = f
                Next k
            End If
        End If
        Set f = f.GetNextFeature
    Loop
    If Not found(0) Is Nothing And Not found(1) Is Nothing And Not found(2) Is Nothing Then
        For k = 0 To 2
            Set Planes(k) = found(k)
        Next k
    End If
    LogLine "using " & Planes(0).Name & " (Z), " & Planes(1).Name & " (Y), " & Planes(2).Name & " (X)"
    FindPlanes = (n = 3)
End Function

Function D3(a As Double, b As Double, c As Double) As Variant
    ' SOLIDWORKS math objects need a real Double array; Array() gives Variants and reads as zeros.
    Dim d(2) As Double
    d(0) = a: d(1) = b: d(2) = c
    D3 = d
End Function

Function PlaneNormal(pf As Object) As Variant
    ' Normal of a reference plane in model space, or Empty
    Dim mu As Object, v As Object
    On Error Resume Next
    Set mu = swApp.GetMathUtility
    Set v = mu.CreateVector(D3(0, 0, 1))
    Set v = v.MultiplyTransform(pf.GetSpecificFeature2.Transform)
    PlaneNormal = v.ArrayData
    If Abs(PlaneNormal(0)) + Abs(PlaneNormal(1)) + Abs(PlaneNormal(2)) < 0.5 Then PlaneNormal = Empty
    Err.Clear
End Function

Function PlaneOrigin(pf As Object) As Variant
    Dim mu As Object, p As Object
    On Error Resume Next
    Set mu = swApp.GetMathUtility
    Set p = mu.CreatePoint(D3(0, 0, 0))
    Set p = p.MultiplyTransform(pf.GetSpecificFeature2.Transform)
    PlaneOrigin = p.ArrayData
    Err.Clear
End Function

Function OffsetPlane(idx As Long, offM As Double) As Object
    Dim pl As Object, o As Variant
    CurPlane = idx
    If offM <= 0 Then
        Set OffsetPlane = Planes(idx)
        Exit Function
    End If
    Part.ClearSelection2 True
    Planes(idx).Select2 False, 0
    Set pl = fm.InsertRefPlane(8, offM, 0, 0, 0, 0)
    ' The offset goes along the template plane's own normal; put it on the +X/+Y/+Z side.
    o = PlaneOrigin(pl)
    If IsArray(o) Then
        If o(2 - idx) < 0 Then
            Part.ClearSelection2 True
            pl.Select2 False, 0
            Part.Extension.DeleteSelection2 0
            Part.ClearSelection2 True
            Planes(idx).Select2 False, 0
            Set pl = fm.InsertRefPlane(8 + 256, offM, 0, 0, 0, 0)
        End If
    End If
    Set OffsetPlane = pl
End Function

Sub BeginSketch(pl As Object)
    Dim ok As Boolean
    Part.ClearSelection2 True
    If pl Is Nothing Then
        LogLine "sketch: no plane"
    Else
        ok = pl.Select2(False, 0)
        LogLine "sketch on " & pl.Name & " selected=" & ok
    End If
    sm.InsertSketch True
    LogLine "  active sketch: " & Not (sm.ActiveSketch Is Nothing)
    sm.AddToDB = True
    sm.DisplayWhenAdded = False
    SketchAxes
End Sub

Sub SketchAxes()
    ' How this plan's sketch axes (u, v) land in the SOLIDWORKS sketch:
    ' Front u=X v=Y, Top u=X v=-Z, Right u=-Z v=Y.
    Dim mu As Object, xf As Object, o As Variant, a As Variant, b As Variant, uu As Variant, vv As Variant
    Select Case CurPlane
        Case 0: uu = D3(1, 0, 0): vv = D3(0, 1, 0)
        Case 1: uu = D3(1, 0, 0): vv = D3(0, 0, -1)
        Case Else: uu = D3(0, 0, -1): vv = D3(0, 1, 0)
    End Select
    Kox = 0: Koy = 0: Kux = 1: Kuy = 0: Kvx = 0: Kvy = 1: KMir = 1
    On Error Resume Next
    Set mu = swApp.GetMathUtility
    Set xf = sm.ActiveSketch.ModelToSketchTransform
    o = mu.CreatePoint(D3(0, 0, 0)).MultiplyTransform(xf).ArrayData
    a = mu.CreatePoint(uu).MultiplyTransform(xf).ArrayData
    b = mu.CreatePoint(vv).MultiplyTransform(xf).ArrayData
    If Err.Number = 0 And IsArray(o) And IsArray(a) And IsArray(b) Then
        Kox = o(0): Koy = o(1)
        Kux = a(0) - o(0): Kuy = a(1) - o(1)
        Kvx = b(0) - o(0): Kvy = b(1) - o(1)
        If Kux * Kvy - Kuy * Kvx < 0 Then KMir = -1
        If Abs(Kux * Kvy - Kuy * Kvx) < 0.5 Then
            ' not a usable mapping: keep the sketch axes as they are
            Kox = 0: Koy = 0: Kux = 1: Kuy = 0: Kvx = 0: Kvy = 1: KMir = 1
            LogLine "  sketch axes not usable, kept as drawn"
        End If
    Else
        LogLine "  sketch axes unknown (error " & Err.Number & ")"
    End If
    LogLine "  axes u=(" & Format(Kux, "0.00") & ", " & Format(Kuy, "0.00") & ") v=(" & Format(Kvx, "0.00") & ", " & Format(Kvy, "0.00") & ") o=(" & Format(Kox * 1000, "0.00") & ", " & Format(Koy * 1000, "0.00") & ")"
    Err.Clear
    On Error GoTo 0
End Sub

Function SX(u As Double, v As Double) As Double
    SX = Kox + u * Kux + v * Kvx
End Function

Function SY(u As Double, v As Double) As Double
    SY = Koy + u * Kuy + v * Kvy
End Function

Sub SkLine(u1 As Double, v1 As Double, u2 As Double, v2 As Double)
    If sm.CreateLine(SX(u1, v1), SY(u1, v1), 0, SX(u2, v2), SY(u2, v2), 0) Is Nothing Then LogLine "  line failed"
End Sub

Sub SkCenterLine(u1 As Double, v1 As Double, u2 As Double, v2 As Double)
    sm.CreateCenterLine SX(u1, v1), SY(u1, v1), 0, SX(u2, v2), SY(u2, v2), 0
End Sub

Sub SkCircle(cu As Double, cv As Double, r As Double)
    If sm.CreateCircleByRadius(SX(cu, cv), SY(cu, cv), 0, r) Is Nothing Then LogLine "  circle failed"
End Sub

Sub SkArc(cu As Double, cv As Double, au As Double, av As Double, bu As Double, bv As Double, d As Long)
    If sm.CreateArc(SX(cu, cv), SY(cu, cv), 0, SX(au, av), SY(au, av), 0, SX(bu, bv), SY(bu, bv), 0, d * KMir) Is Nothing Then LogLine "  arc failed"
End Sub

Function EndSketch() As String
    sm.AddToDB = False
    sm.DisplayWhenAdded = True
    On Error Resume Next
    LogLine "  segments: " & sm.ActiveSketch.GetSketchSegmentCount
    On Error GoTo 0
    sm.InsertSketch True
    EndSketch = Part.FeatureByPositionReverse(0).Name
    LogLine "  closed as " & EndSketch
End Function

Sub DefineAllSketches()
    ' After the part is built and checked: Tools > Dimensions > Fully Define Sketch on every
    ' sketch, measured from the origin, so sketches turn black with their sizes shown.
    ' Relations: coincident, horizontal, vertical, tangent, perpendicular, concentric.
    ' Any sketch that cannot be defined is left as drawn.
    Dim f As Object, s As Object
    On Error Resume Next
    Set f = Part.FirstFeature
    Do While Not f Is Nothing
        If f.GetTypeName2 = "ProfileFeature" Then DefineOne f
        Set s = f.GetFirstSubFeature
        Do While Not s Is Nothing
            If s.GetTypeName2 = "ProfileFeature" Then DefineOne s
            Set s = s.GetNextSubFeature
        Loop
        Set f = f.GetNextFeature
    Loop
    Part.ClearSelection2 True
    Part.EditRebuild3
    Err.Clear
    On Error GoTo 0
End Sub

Sub DefineOne(sk As Object)
    On Error Resume Next
    Part.ClearSelection2 True
    If Not sk.Select2(False, 0) Then Exit Sub
    Part.EditSketch
    If sm.ActiveSketch Is Nothing Then Exit Sub
    Part.ClearSelection2 True
    Part.Extension.SelectByID2 "Point1@Origin", "EXTSKETCHPOINT", 0, 0, 0, False, 6, Nothing, 0
    sm.FullyDefineSketch True, True, 606, True, 1, Nothing, 1, Nothing, 1, 1
    Part.ClearSelection2 True
    sm.InsertSketch True
    Err.Clear
End Sub

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
    If Not IsArray(c) Or v <= 0 Then Exit Function
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
    Dim useDraft As Boolean, nA As Long, nB As Long, made As Boolean, got As String
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
                    made = True
                    Part.EditRebuild3
                    If Matches(expV, ex, ey, ez) Then
                        On Error Resume Next
                        f.Name = label
                        On Error GoTo 0
                        Exit Sub
                    End If
                    got = VolumeNow()
                    Part.EditUndo2 1
                    Part.EditRebuild3
                End If
            Next c
        Next b
    Next a
    LogLine "  " & label & ": made=" & made & " got " & got
    If made Then
        Problems = Problems & label & " (got " & got & ", expected " & Format(expV, "0.0") & " mm3 at " & _
            Format(ex, "0.00") & ", " & Format(ey, "0.00") & ", " & Format(ez, "0.00") & ")" & vbCrLf
    Else
        Problems = Problems & label & " (SOLIDWORKS did not create it, sketch " & nm & ")" & vbCrLf
    End If
End Sub

Function VolumeNow() As String
    Dim mp As Object
    VolumeNow = "none"
    On Error Resume Next
    Set mp = Part.Extension.CreateMassProperty
    Dim c As Variant
    c = mp.CenterOfMass
    VolumeNow = Format(mp.Volume * 1E+09, "0.0") & " mm3 at " & Format(c(0) * 1000, "0.00") & ", " & _
        Format(c(1) * 1000, "0.00") & ", " & Format(c(2) * 1000, "0.00")
    Err.Clear
End Function

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

Function WizFlag(Optional ByVal v As Integer = -1) As Boolean
    ' Remembers whether the last hole was made by Hole Wizard, so its counterbore step is skipped.
    Static made As Boolean
    If v >= 0 Then made = (v = 1)
    WizFlag = made
End Function

Function MatchesLoose(expV As Double, ex As Double, ey As Double, ez As Double) As Boolean
    ' Hole Wizard uses standard drill and tap sizes and drill points, so allow a little more.
    Dim mp As Object, c As Variant, v As Double, dx As Double, dy As Double, dz As Double
    MatchesLoose = False
    On Error Resume Next
    Set mp = Part.Extension.CreateMassProperty
    v = mp.Volume * 1E+09
    c = mp.CenterOfMass
    If Err.Number <> 0 Then
        Err.Clear
        Exit Function
    End If
    On Error GoTo 0
    If Not IsArray(c) Or v <= 0 Then Exit Function
    dx = c(0) * 1000 - ex: dy = c(1) * 1000 - ey: dz = c(2) * 1000 - ez
    MatchesLoose = (Abs(v - expV) / expV <= 0.02) And (dx * dx + dy * dy + dz * dz <= 1)
End Function

Function HoleWiz(label As String, gtype As Long, fastener As Long, size As String, thru As Boolean, firstEnd As Long, _
                 dia As Double, depth As Double, vals As String, pts As String, dx As Double, dy As Double, dz As Double, _
                 expV As Double, ex As Double, ey As Double, ez As Double) As Boolean
    ' Hole Wizard, standard JIS (9). Each hole is picked on the face where it starts.
    ' Through holes try Up To Next (11), then Through All (1).
    Dim v As Variant, p As Variant, q As Variant, k As Long, tries As Long, endT As Long, f As Object
    Dim a(11) As Double
    HoleWiz = False
    v = Split(vals, ",")
    For k = 0 To 11
        a(k) = Val(v(k))
    Next k
    p = Split(pts, ";")
    For tries = 0 To 1
        If thru Then
            endT = firstEnd
            If tries = 1 Then endT = IIf(firstEnd = 11, 1, 11)
            If gtype = 4 Then a(7) = IIf(endT = 1, 1, 2)
        Else
            If tries = 1 Then Exit Function
            endT = 0
        End If
        Part.ClearSelection2 True
        For k = 0 To UBound(p)
            q = Split(p(k), ",")
            Part.Extension.SelectByRay Val(q(0)) - dx * 0.0001, Val(q(1)) - dy * 0.0001, Val(q(2)) - dz * 0.0001, _
                dx, dy, dz, 0.0002, 2, True, 0, 0
        Next k
        Set f = Nothing
        On Error Resume Next
        Set f = fm.HoleWizard5(gtype, 9, fastener, size, endT, dia, depth, -1, a(0), a(1), a(2), a(3), a(4), a(5), _
            a(6), a(7), a(8), a(9), a(10), a(11), "", False, True, True, True, True, False)
        On Error GoTo 0
        If Not f Is Nothing Then
            Part.EditRebuild3
            If MatchesLoose(expV, ex, ey, ez) Then
                On Error Resume Next
                f.Name = label
                On Error GoTo 0
                Part.ClearSelection2 True
                HoleWiz = True
                Exit Function
            End If
            ' Delete exactly this hole and its position sketch; Undo could remove earlier features.
            On Error Resume Next
            Part.ClearSelection2 True
            f.Select2 False, 0
            Part.Extension.DeleteSelection2 1
            On Error GoTo 0
            Part.EditRebuild3
        End If
    Next tries
    Part.ClearSelection2 True
End Function

Sub PickEdge(x As Double, y As Double, z As Double)
    ' Pick by geometry so the result does not depend on the current view.
    Dim b As Variant, e As Variant, p As Variant, sd As Object, i As Long
    Dim dx As Double, dy As Double, dz As Double
    b = Part.GetBodies2(0, False)
    If Not IsArray(b) Then Exit Sub ' no solid yet: an earlier feature failed
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
