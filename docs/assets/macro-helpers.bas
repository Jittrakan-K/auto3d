
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
    DefineSketch
    sm.InsertSketch True
    EndSketch = Part.FeatureByPositionReverse(0).Name
End Function

Sub DefineSketch()
    ' Same as Tools > Dimensions > Fully Define Sketch, measured from the origin, so the
    ' sketch turns black with its sizes shown. If it fails the sketch is kept as drawn.
    ' Relations: coincident, horizontal, vertical, tangent, perpendicular, concentric.
    On Error Resume Next
    Part.ClearSelection2 True
    Part.Extension.SelectByID2 "Point1@Origin", "EXTSKETCHPOINT", 0, 0, 0, False, 6, Nothing, 0
    sm.FullyDefineSketch True, True, 606, True, 1, Nothing, 1, Nothing, 1, 1
    Part.ClearSelection2 True
    Err.Clear
    On Error GoTo 0
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
    dx = c(0) * 1000 - ex: dy = c(1) * 1000 - ey: dz = c(2) * 1000 - ez
    MatchesLoose = (Abs(v - expV) / expV <= 0.01) And (dx * dx + dy * dy + dz * dz <= 0.25)
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
            Part.EditUndo2 1
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
