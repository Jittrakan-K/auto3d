"""Exercises the COM logic with a stand-in, since SOLIDWORKS cannot run in tests.
It proves call order, argument counts and the retry logic, not SOLIDWORKS behaviour."""
import json, types
from pathlib import Path
import pytest
from app import cad_engine as E, plan as P, sw_backend as S, sw_macro as M

EX = Path(__file__).parent.parent / "examples"

class Feat:
    def __init__(self, sw, name, type_name="Boss"):
        self.sw, self.Name, self.type = sw, name, type_name
    GetTypeName2 = property(lambda s: s.type)
    GetNextFeature = property(lambda s: s.sw.next_of(s))
    def Select2(self, append, mark): return True

class FakeSM:
    def __init__(self, sw): self.sw = sw; self.AddToDB = False; self.DisplayWhenAdded = True; self.ops = []; self.open = False
    def InsertSketch(self, b):
        self.open = not self.open
        if not self.open:
            self.sw.count += 1; self.sw.tree.append(Feat(self.sw, f"Sketch{self.sw.count}", "ProfileFeature"))
    def CreateLine(self, *a): assert len(a) == 6 and self.AddToDB and self.open; return object()
    def CreateCircleByRadius(self, *a): assert len(a) == 4; return object()
    def CreateArc(self, *a): assert len(a) == 10 and a[-1] in (1, -1); return object()
    def CreateCenterLine(self, *a): assert len(a) == 6; return object()

class FakeFM:
    def __init__(self, sw): self.sw = sw
    def InsertRefPlane(self, *a):
        assert len(a) == 6 and a[0] == 8 and a[1] > 0
        f = Feat(self.sw, "Plane", "RefPlane"); self.sw.tree.append(f); return f
    def _made(self, correct):
        self.sw.pending.append(correct)
        step = self.sw.steps[self.sw.done]
        v, c = (step.volume_after, step.center_after) if correct else (step.volume_after * 1.5, [999, 0, 0])
        self.sw.state.append((v / 1e9, [x / 1000 for x in c]))
        f = Feat(self.sw, "Feature"); self.sw.tree.append(f); return f
    def FeatureExtrusion2(self, *a):
        assert len(a) == 23
        return self._made(a[2] == self.sw.want_dir(self.sw.steps[self.sw.done]))
    def FeatureCut4(self, *a):
        assert len(a) == 27
        return self._made(a[2] == self.sw.want_dir(self.sw.steps[self.sw.done]))
    def FeatureRevolve2(self, *a):
        assert len(a) == 20
        return self._made(True)
    def FeatureFillet3(self, *a):
        assert len(a) == 14 and a[1] > 0
        return self._made(True)
    def InsertFeatureChamfer(self, *a):
        assert len(a) == 8 and a[1] == 1
        return self._made(True)

class FakeSW:
    """Pretends cuts go the opposite way to the API default, forcing the retry path."""
    def __init__(self, steps, tmp):
        self.steps, self.tree, self.state, self.count, self.done, self.pending = steps, [], [], 0, 0, []
        self.Visible = False; self.undos = 0; self.saved = None
        self.fm, self.sm = FakeFM(self), FakeSM(self)
        for n in ("Front Plane", "Top Plane", "Right Plane"):
            self.tree.append(Feat(self, n, "RefPlane"))
    RevisionNumber = "26.5.0"
    def want_dir(self, step): return step.kind == "cut"
    def next_of(self, f):
        i = self.tree.index(f); return self.tree[i + 1] if i + 1 < len(self.tree) else None
    def GetUserPreferenceStringValue(self, n): assert n == 8; return ""
    def GetDocumentTemplate(self, *a): assert len(a) == 5; return str(Path(__file__))
    def NewDocument(self, *a): return FakePart(self)

class FakeMP:
    def __init__(self, sw): self.sw = sw
    Volume = property(lambda s: s.sw.state[-1][0])
    CenterOfMass = property(lambda s: s.sw.state[-1][1])

class FakeExt:
    def __init__(self, sw): self.sw = sw
    CreateMassProperty = property(lambda s: FakeMP(s.sw))
    def SelectByID2(self, *a): assert len(a) == 9; self.sw.selected = getattr(self.sw, "selected", 0) + 1; return True

class FakeSel:
    def __init__(self, sw): self.sw = sw
    def GetSelectedObjectCount2(self, m): return self.sw.selected

class FakePart:
    def __init__(self, sw):
        self.sw = sw; self.FeatureManager = sw.fm; self.SketchManager = sw.sm
        self.Extension = FakeExt(sw); self.SelectionManager = FakeSel(sw)
    FirstFeature = property(lambda s: s.sw.tree[0])
    EditRebuild3 = property(lambda s: True)
    def ClearSelection2(self, b): self.sw.selected = 0
    def FeatureByPositionReverse(self, i): return self.sw.tree[-1]
    def EditUndo2(self, n): self.sw.state.pop(); self.sw.tree.pop(); self.sw.undos += 1; self.sw.pending.pop()
    def SaveAs3(self, p, v, o): Path(p).write_bytes(b"x"); self.sw.saved = p; return 0

class Advancing(S.Builder):
    def sketched_feature(self, step):
        r = super().sketched_feature(step); self.sw.done += 1; return r
    def edge_feature(self, step):
        r = super().edge_feature(step); self.sw.done += 1; return r

def api(sw):
    return S.SwApi(dispatch=lambda p: sw, null_dispatch=lambda: None, double_array=list, byref_int=lambda: 0)

@pytest.mark.parametrize("name", ["bracket", "flange", "din_cover", "shaft"])
def test_flow_and_retry(name, tmp_path):
    plan = P.parse_plan(json.loads((EX / f"{name}.json").read_text(encoding="utf-8")))
    steps = E.build(plan).steps
    sw = FakeSW(steps, tmp_path)
    b = Advancing(api(sw))
    report = b.run(steps, tmp_path / "out.SLDPRT")
    assert report.ok and (tmp_path / "out.SLDPRT").exists()
    assert len(report.steps) == len(steps)
    assert sw.done == len(steps)

def test_retry_actually_undoes_wrong_direction(tmp_path):
    plan = P.parse_plan(json.loads((EX / "bracket.json").read_text(encoding="utf-8")))
    steps = E.build(plan).steps
    sw = FakeSW(steps, tmp_path)
    sw.want_dir = lambda s: s.direction != "reverse" if s.kind == "cut" else False
    Advancing(api(sw)).run(steps, tmp_path / "o.SLDPRT")
    assert sw.undos > 0

def test_version_mismatch_is_refused(tmp_path):
    sw = FakeSW([], tmp_path); sw.__class__ = type("Newer", (FakeSW,), {"RevisionNumber": "33.1.0"})
    with pytest.raises(S.SolidworksError, match="2025"):
        S.Builder(api(sw), year=2018).connect()

def test_year_selects_progid(tmp_path):
    seen = []
    sw = FakeSW([], tmp_path); sw.__class__ = type("Newer", (FakeSW,), {"RevisionNumber": "33.1.0"})
    a = api(sw); a.dispatch = lambda p: (seen.append(p), sw)[1]
    S.Builder(a, year=2025).connect()
    assert seen == ["SldWorks.Application.33"]

def test_file_name_states_version(tmp_path):
    assert S.target_path(tmp_path, "Part", 2025).name == "Part_SW2025.SLDPRT"

@pytest.mark.parametrize("name", ["bracket", "flange", "din_cover", "shaft"])
def test_macro_text(name):
    plan = P.parse_plan(json.loads((EX / f"{name}.json").read_text(encoding="utf-8")))
    steps = E.build(plan).steps
    text = M.render(steps, plan.name)
    assert text.isascii()
    assert text.count("Sub Step") == len(steps)
    for i in range(1, len(steps) + 1):
        assert f"    Step{i}\r\n" in text
    opens = sum(1 for l in text.splitlines() if l.strip().startswith(("Sub ", "Function ")))
    closes = sum(1 for l in text.splitlines() if l.strip() in ("End Sub", "End Function"))
    assert opens == closes
