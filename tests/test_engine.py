import json, math
from pathlib import Path
import pytest
from app import cad_engine as E, plan as P

EX = Path(__file__).parent.parent / "examples"

def load(n, **ov):
    d = json.loads((EX / f"{n}.json").read_text(encoding="utf-8"))
    for k, v in ov.items():
        next(p for p in d["parameters"] if p["name"] == k)["value"] = v
    return d

@pytest.mark.parametrize("name", ["bracket", "flange", "din_cover", "shaft"])
def test_examples_build_and_reimport(name, tmp_path):
    r = E.build(P.parse_plan(load(name)))
    assert r.solids == 1 and r.volume_mm3 > 0
    files = E.export(r, tmp_path, name)
    v = E.verify_step(files["step"], r.volume_mm3)
    assert v["ok"], v

def test_box_volume_exact():
    plan = P.parse_plan({"name": "b", "features": [
        {"id": "F1", "type": "extrude", "plane": "Top", "sketch": [{"type": "rect", "w": 10, "h": 20}], "depth": 30}]})
    r = E.build(plan)
    assert r.volume_mm3 == pytest.approx(6000)
    assert r.bbox == pytest.approx([-5, 0, -10, 5, 30, 10])

def test_plane_mapping_matches_solidworks():
    # A rectangle at sketch (+10, +20) must land at SOLIDWORKS global coordinates.
    def box(plane):
        return E.build(P.parse_plan({"name": "b", "features": [{"id": "F1", "type": "extrude", "plane": plane,
            "sketch": [{"type": "rect", "cx": 10, "cy": 20, "w": 2, "h": 2}], "depth": 1}]})).bbox
    assert box("Front") == pytest.approx([9, 19, 0, 11, 21, 1])
    assert box("Top") == pytest.approx([9, 0, -21, 11, 1, -19])
    assert box("Right") == pytest.approx([0, 19, -11, 1, 21, -9])

def test_flange_volume_matches_hand_calc():
    r = E.build(P.parse_plan({"name": "f", "features": [
        {"id": "F1", "type": "revolve", "plane": "Front", "axis_a": [0, 0], "axis_b": [0, 10],
         "sketch": [{"type": "rect", "cx": 30, "cy": 5, "w": 20, "h": 10}]},
        {"id": "F2", "type": "hole", "plane": "Top", "offset": 10, "direction": "reverse",
         "bolt_circle": {"pcd": 60, "count": 4}, "diameter": 6, "through": True}]}))
    expect = math.pi * (40**2 - 20**2) * 10 - 4 * math.pi * 9 * 10
    assert r.volume_mm3 == pytest.approx(expect, rel=1e-6)

def test_nested_sketch_loop_makes_hollow():
    r = E.build(P.parse_plan({"name": "t", "features": [{"id": "F1", "type": "extrude", "plane": "Front",
        "sketch": [{"type": "circle", "d": 20}, {"type": "circle", "d": 10}], "depth": 10}]}))
    assert r.volume_mm3 == pytest.approx(math.pi * (100 - 25) * 10, rel=1e-6)

def test_countersink_volume():
    r = E.build(P.parse_plan({"name": "c", "features": [
        {"id": "F1", "type": "extrude", "plane": "Top", "sketch": [{"type": "rect", "w": 40, "h": 40}], "depth": 10},
        {"id": "F2", "type": "hole", "plane": "Top", "offset": 10, "direction": "reverse", "points": [[0, 0]],
         "diameter": 4, "through": True, "csk_d": 8}]}))
    h = 2.0
    cone = math.pi * h / 3 * (4**2 + 4 * 2 + 2**2)
    expect = 16000 - math.pi * 4 * (10 - h) - cone
    assert r.volume_mm3 == pytest.approx(expect, rel=1e-4)

def test_parameters_change_geometry():
    a = E.build(P.parse_plan(load("bracket"))).volume_mm3
    b = E.build(P.parse_plan(load("bracket", W=140))).volume_mm3
    assert b > a

def test_cut_missing_part_is_error():
    with pytest.raises(E.BuildError, match="removed no material"):
        E.build(P.parse_plan({"name": "x", "features": [
            {"id": "F1", "type": "extrude", "plane": "Top", "sketch": [{"type": "rect", "w": 10, "h": 10}], "depth": 5},
            {"id": "F2", "type": "cut", "plane": "Top", "offset": 50, "sketch": [{"type": "circle", "d": 2}], "depth": 1}]}))

def test_disconnected_body_is_error():
    with pytest.raises(E.BuildError, match="separate bodies"):
        E.build(P.parse_plan({"name": "x", "features": [
            {"id": "F1", "type": "extrude", "plane": "Top", "sketch": [{"type": "rect", "w": 10, "h": 10}], "depth": 5},
            {"id": "F2", "type": "extrude", "plane": "Top", "offset": 50, "sketch": [{"type": "rect", "w": 10, "h": 10}], "depth": 5}]}))

def test_expression_cannot_run_code():
    for bad in ["__import__('os')", "(1).__class__", "open('x')", "W.real"]:
        with pytest.raises(P.ExpressionError):
            P.evaluate(bad, {"W": 1.0})
    assert P.evaluate("sqrt(9)+2*W", {"W": 3.0}) == 9
