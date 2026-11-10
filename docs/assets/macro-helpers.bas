
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
