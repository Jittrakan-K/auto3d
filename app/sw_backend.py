"""Drives the installed SOLIDWORKS through COM to save a native .SLDPRT.

SOLIDWORKS builds the part itself, so the file has a real Feature Tree. A .SLDPRT always
carries the format of the SOLIDWORKS that saved it, so a 2018 file needs SOLIDWORKS 2018;
SOLIDWORKS 2018 is preferred when installed, otherwise the newest version is used and the
page says so. After every feature the mass properties are compared with the value
from the STEP engine. Where the API direction is ambiguous (cut direction, start offset,
draft side) each variant is tried, wrong ones are undone, and the matching one is kept.
"""
from __future__ import annotations

import math
import os
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .cad_engine import Step

YEAR_OFFSET = 1992  # RevisionNumber major 26 is SOLIDWORKS 2018, 33 is 2025
WANTED_YEAR = 2018
PLANE_ORDER = ["Front", "Top", "Right"]
VOLUME_TOL = 0.0005  # 0.05 %
CENTER_TOL_MM = 0.05

_lock = threading.Lock()


class SolidworksError(Exception):
    pass


@dataclass
class SwApi:
    """COM access points, replaceable so the logic can be tested without SOLIDWORKS."""

    dispatch: Callable[[str], Any]
    null_dispatch: Callable[[], Any]
    double_array: Callable[[list[float]], Any]
    byref_int: Callable[[], Any]


@dataclass
class SwReport:
    ok: bool
    path: str = ""
    revision: str = ""
    volume_mm3: float = 0.0
    steps: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""


def com_api() -> SwApi:
    import pythoncom
    import win32com.client

    V = win32com.client.VARIANT
    return SwApi(
        dispatch=win32com.client.Dispatch,
        null_dispatch=lambda: V(pythoncom.VT_DISPATCH, None),
        double_array=lambda v: V(pythoncom.VT_ARRAY | pythoncom.VT_R8, v),
        byref_int=lambda: V(pythoncom.VT_BYREF | pythoncom.VT_I4, 0),
    )


def status() -> dict[str, Any]:
    """Check availability without starting SOLIDWORKS."""
    if sys.platform != "win32":
        return {"available": False, "reason": "ต้องรันบน Windows ที่ติดตั้ง SOLIDWORKS"}
    try:
        import win32com.client  # noqa: F401
    except ImportError:
        return {"available": False, "reason": "ยังไม่ได้ติดตั้ง pywin32"}
    import winreg

    found = []
    for major in range(20, 36):
        try:
            winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, f"SldWorks.Application.{major}"))
            found.append(1992 + major)
        except OSError:
            pass
    if not found:
        return {"available": False, "reason": "ไม่พบ SOLIDWORKS ในเครื่องนี้", "versions": [], "version": None}
    year = WANTED_YEAR if WANTED_YEAR in found else max(found)
    reason = f"ใช้ SOLIDWORKS {year}"
    if year != WANTED_YEAR:
        reason += " ไฟล์ SLDPRT จะเป็นรุ่นนี้และเปิดใน 2018 ไม่ได้ ถ้าต้องการรุ่น 2018 ให้รันมาโครบนเครื่องที่มี 2018"
    return {"available": True, "reason": reason, "versions": found, "version": year}


def value(obj: Any, name: str, *args: Any) -> Any:
    """Call a member that late binding may expose as a method or as a property."""
    attr = getattr(obj, name)
    if args:
        return attr(*args)
    if hasattr(attr, "_oleobj_"):  # already the result; COM objects look callable in Python
        return attr
    return attr() if callable(attr) else attr


def _m(mm: float) -> float:
    return float(mm) / 1000.0


class Builder:
    def __init__(self, api: SwApi, log: Callable[[str], None] = lambda _: None, year: int = WANTED_YEAR):
        self.api = api
        self.year = year
        self.log = log
        self.sw: Any = None
        self.part: Any = None
        self.fm: Any = None
        self.sm: Any = None
        self.planes: dict[str, Any] = {}
        self.ref_planes: dict[tuple[str, float], Any] = {}
        self.ref_count = 0

    # ----- session -----
    def connect(self) -> str:
        self.sw = self.api.dispatch(f"SldWorks.Application.{self.year - YEAR_OFFSET}")
        revision = str(value(self.sw, "RevisionNumber"))
        actual = int(revision.split(".")[0]) + YEAR_OFFSET
        if actual != self.year:
            raise SolidworksError(f"เชื่อมต่อได้ SOLIDWORKS {actual} แต่ต้องการ {self.year}")
        self.sw.Visible = True
        return revision

    def _template(self) -> str:
        """Find a part template. A fresh install may leave the default preference empty."""
        found: list[str] = [os.environ.get("AUTODESIGN_SW_TEMPLATE", "")]
        try:
            found.append(str(value(self.sw, "GetUserPreferenceStringValue", 8) or ""))
        except Exception:  # noqa: BLE001 - other sources follow
            pass
        try:
            found.append(str(self.sw.GetDocumentTemplate(1, "", 0, 0, 0) or ""))
        except Exception:  # noqa: BLE001 - other sources follow
            pass
        for root in (
            Path(rf"C:\ProgramData\SOLIDWORKS\SOLIDWORKS {self.year}\templates"),
            Path(rf"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\data\templates"),
            Path(r"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\lang"),
        ):
            if root.is_dir():
                found += sorted(str(f) for f in root.rglob("*.prtdot"))
        for path in found:
            if path and Path(path).is_file():
                return path
        raise SolidworksError("ไม่พบเทมเพลต Part ตั้งค่า AUTODESIGN_SW_TEMPLATE ในไฟล์ .env")

    def new_part(self) -> None:
        path = self._template()
        self.log(f"template {path}")
        self.part = value(self.sw, "NewDocument", path, 0, 0, 0)
        if self.part is None:
            raise SolidworksError(f"สร้างไฟล์ Part จากเทมเพลตไม่สำเร็จ: {path}")
        self.log("new part ready")
        self.fm = value(self.part, "FeatureManager")
        self.sm = value(self.part, "SketchManager")
        self.planes = self._base_planes()
        self.log("planes found")

    def _base_planes(self) -> dict[str, Any]:
        """Find planes by tree order, so a localized SOLIDWORKS still works."""
        found: list[Any] = []
        feature = value(self.part, "FirstFeature")
        while feature is not None and len(found) < 3:
            if value(feature, "GetTypeName2") == "RefPlane":
                found.append(feature)
            feature = value(feature, "GetNextFeature")
        if len(found) < 3:
            raise SolidworksError("ไม่พบระนาบ Front/Top/Right ในเทมเพลต")
        return dict(zip(PLANE_ORDER, found))

    def clear(self) -> None:
        self.part.ClearSelection2(True)

    def rebuild(self) -> None:
        value(self.part, "EditRebuild3")

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        err: Optional[Exception] = None
        try:
            if value(self.part, "SaveAs3", str(path), 0, 1) == 0 and path.exists():
                return
        except Exception as e:  # noqa: BLE001 - fall back to the newer call
            err = e
        ext = value(self.part, "Extension")
        ok = ext.SaveAs(
            str(path), 0, 1, self.api.null_dispatch(), self.api.byref_int(), self.api.byref_int()
        )
        if not ok:
            raise SolidworksError(f"เซฟไฟล์ไม่สำเร็จ: {path} {err or ''}")

    # ----- measuring -----
    def measure(self) -> tuple[float, list[float]]:
        ext = value(self.part, "Extension")
        mp = value(ext, "CreateMassProperty")
        v = value(mp, "Volume") * 1e9
        c = [float(x) * 1000 for x in value(mp, "CenterOfMass")]
        return v, c

    def error_of(self, step: Step) -> tuple[float, float]:
        """Relative volume error and centre-of-mass distance in mm."""
        try:
            v, c = self.measure()
        except Exception:  # noqa: BLE001 - an empty part has no mass properties
            return (math.inf, math.inf)
        return abs(v - step.volume_after) / step.volume_after, math.dist(c, step.center_after)

    @staticmethod
    def matches(err: tuple[float, float]) -> bool:
        return err[0] <= VOLUME_TOL and err[1] <= CENTER_TOL_MM

    # ----- sketches -----
    def _sketch_plane(self, step: Step) -> Any:
        if step.offset <= 0:
            return self.planes[step.plane]
        key = (step.plane, round(step.offset, 6))
        if key not in self.ref_planes:
            self.clear()
            self.planes[step.plane].Select2(False, 0)
            feature = self.fm.InsertRefPlane(8, _m(step.offset), 0, 0, 0, 0)
            if feature is None:
                raise SolidworksError(f"{step.id}: สร้างระนาบ offset {step.offset} mm ไม่สำเร็จ")
            self.ref_count += 1
            self.ref_planes[key] = feature
        return self.ref_planes[key]

    def draw(self, step: Step) -> str:
        plane = self._sketch_plane(step)
        self.clear()
        plane.Select2(False, 0)
        self.sm.InsertSketch(True)
        self.sm.AddToDB = True
        self.sm.DisplayWhenAdded = False
        for loop in step.loops:
            for s in loop:
                self._entity(s)
        if step.axis:
            (ax, ay), (bx, by) = step.axis
            self.sm.CreateCenterLine(_m(ax), _m(ay), 0, _m(bx), _m(by), 0)
        self.sm.AddToDB = False
        self.sm.DisplayWhenAdded = True
        self.sm.InsertSketch(True)
        sketch = self.part.FeatureByPositionReverse(0)
        return str(value(sketch, "Name"))

    def _entity(self, s: dict[str, Any]) -> None:
        if s["t"] == "line":
            ok = self.sm.CreateLine(_m(s["a"][0]), _m(s["a"][1]), 0, _m(s["b"][0]), _m(s["b"][1]), 0)
        elif s["t"] == "circle":
            ok = self.sm.CreateCircleByRadius(_m(s["c"][0]), _m(s["c"][1]), 0, _m(s["r"]))
        else:
            ok = self.sm.CreateArc(
                _m(s["c"][0]), _m(s["c"][1]), 0,
                _m(s["a"][0]), _m(s["a"][1]), 0,
                _m(s["b"][0]), _m(s["b"][1]), 0,
                1 if s["ccw"] else -1,
            )
        if ok is None:
            raise SolidworksError(f"วาดเส้นในสเก็ตช์ไม่สำเร็จ: {s}")

    def select_sketch(self, name: str) -> bool:
        self.clear()
        ext = value(self.part, "Extension")
        return bool(ext.SelectByID2(name, "SKETCH", 0, 0, 0, False, 0, self.api.null_dispatch(), 0))

    # ----- feature calls -----
    def _extrude_call(self, step: Step, flip_dir: bool, flip_start: bool, draft_out: bool) -> Any:
        both = step.direction == "both"
        start = abs(step.offset) if step.offset < 0 else 0.0
        t0 = 3 if step.offset < 0 else 0
        draft = step.draft_deg > 0
        dang = math.radians(step.draft_deg) if draft else 0.0175
        if both:  # mid-plane
            sd, t1, t2, d1, d2 = True, 6, 0, _m(step.depth), 0.0
        else:
            sd, t1, t2, d1, d2 = True, 0, 0, _m(step.depth), 0.0
        return self.fm.FeatureExtrusion2(
            sd, False, flip_dir, t1, t2, d1, d2, draft, False, draft_out, False, dang, 0.0175,
            False, False, False, False, True, True, True, t0, _m(start), flip_start,
        )

    def _cut_call(self, step: Step, flip_dir: bool, flip_start: bool, draft_out: bool, scope: bool) -> Any:
        start = abs(step.offset) if step.offset < 0 else 0.0
        t0 = 3 if step.offset < 0 else 0
        draft = step.draft_deg > 0
        dang = math.radians(step.draft_deg) if draft else 0.0175
        if step.through and step.direction == "both":
            sd, t1, t2 = False, 1, 1
        elif step.through:
            sd, t1, t2 = True, 1, 0
        else:
            sd, t1, t2 = True, 0, 0
        depth = 0.01 if step.through else _m(step.depth)
        return self.fm.FeatureCut4(
            sd, False, flip_dir, t1, t2, depth, 0.01, draft, False, draft_out, False, dang, 0.0175,
            False, False, False, False, False, True, True, scope, scope, False,
            t0, _m(start), flip_start, False,
        )

    def _revolve_call(self, step: Step, flip_dir: bool) -> Any:
        return self.fm.FeatureRevolve2(
            True, True, False, step.is_cut, flip_dir, False, 0, 0, math.radians(step.angle_deg), 0.0,
            False, False, 0.0, 0.0, 0, 0.0, 0.0, True, True, True,
        )

    def _variants(self, step: Step) -> Iterable[tuple[str, Callable[[], Any]]]:
        offs = [False, True] if step.offset < 0 else [False]
        drafts = [False, True] if step.draft_deg > 0 else [False]
        if step.kind == "revolve":
            for flip in [False, True]:
                yield f"reverse={flip}", lambda f=flip: self._revolve_call(step, f)
            return
        dirs = [False] if step.direction == "both" else [False, True]
        if step.direction == "reverse":
            dirs = [True, False]
        for fs in offs:
            for dr in drafts:
                for flip in dirs:
                    tag = f"dir={flip} start={fs} draft={dr}"
                    if step.kind == "extrude":
                        yield tag, lambda f=flip, s=fs, d=dr: self._extrude_call(step, f, s, d)
                    else:
                        yield tag, lambda f=flip, s=fs, d=dr: self._cut_call(step, f, s, d, True)
                        yield tag + " scope", lambda f=flip, s=fs, d=dr: self._cut_call(step, f, s, d, False)

    def sketched_feature(self, step: Step) -> dict[str, Any]:
        sketch = self.draw(step)
        best: Optional[tuple[tuple[float, float], Callable[[], Any], str]] = None
        last_error = ""
        for tag, attempt in self._variants(step):
            if not self.select_sketch(sketch):
                raise SolidworksError(f"{step.id}: เลือกสเก็ตช์ {sketch} ไม่ได้")
            try:
                feature = attempt()
            except Exception as e:  # noqa: BLE001 - try the next variant
                feature, last_error = None, str(e)
            if feature is None:
                continue
            self.rebuild()
            err = self.error_of(step)
            if self.matches(err):
                self._rename(feature, step.name)
                return self._row(step, "ok", err, tag)
            if best is None or err < best[0]:
                best = (err, attempt, tag)
            self.part.EditUndo2(1)
            self.rebuild()
        if best is None:
            raise SolidworksError(f"{step.id} ({step.name}): SOLIDWORKS สร้างฟีเจอร์ไม่สำเร็จ {last_error}")
        # Nothing matched exactly: keep the closest result and flag it for review.
        self.select_sketch(sketch)
        feature = best[1]()
        self.rebuild()
        if feature is not None:
            self._rename(feature, step.name)
        return self._row(step, "mismatch", self.error_of(step), best[2])

    def _select_edges_by_geometry(self, step: Step) -> int:
        """Pick each edge by the point that lies on it, independent of the current view."""
        self.clear()
        mgr = value(self.part, "SelectionManager")
        bodies = self.part.GetBodies2(0, False)
        edges = list(value(bodies[0], "GetEdges"))
        data = value(mgr, "CreateSelectData")
        data.Mark = 1
        for x, y, z in step.edge_points:
            target = (_m(x), _m(y), _m(z))
            for edge in edges:
                p = edge.GetClosestPointOn(*target)
                if math.dist((p[0], p[1], p[2]), target) < 1e-6:
                    edge.Select4(True, data)
                    break
        return int(value(mgr, "GetSelectedObjectCount2", -1))

    def _select_edges_by_point(self, step: Step) -> int:
        """Fallback. A pick by point follows the view, so it can land on an edge behind."""
        self.clear()
        ext = value(self.part, "Extension")
        for x, y, z in step.edge_points:
            ext.SelectByID2("", "EDGE", _m(x), _m(y), _m(z), True, 1, self.api.null_dispatch(), 0)
        return int(value(value(self.part, "SelectionManager"), "GetSelectedObjectCount2", -1))

    def _edge_call(self, step: Step) -> Any:
        if step.kind == "fillet":
            r = _m(step.size)
            arr = self.api.double_array([0.0])
            return self.fm.FeatureFillet3(195, r, r, 0, 0, 0, 0, arr, arr, arr, arr, arr, arr, arr)
        return self.fm.InsertFeatureChamfer(6, 1, _m(step.size), math.pi / 4, 0, 0, 0, 0)

    def edge_feature(self, step: Step) -> dict[str, Any]:
        best: Optional[tuple[tuple[float, float], Callable[[Step], int], str]] = None
        last_error = ""
        for how, pick in (("geometry", self._select_edges_by_geometry), ("point", self._select_edges_by_point)):
            try:
                picked = pick(step)
                if picked < len(step.edge_points):
                    last_error = f"เลือกขอบได้ {picked} จาก {len(step.edge_points)}"
                    continue
                feature = self._edge_call(step)
            except Exception as e:  # noqa: BLE001 - try the other way of picking
                last_error = str(e)
                continue
            if feature is None:
                continue
            self.rebuild()
            err = self.error_of(step)
            tag = f"{how} edges={picked}"
            if self.matches(err):
                self._rename(feature, step.name)
                return self._row(step, "ok", err, tag)
            if best is None or err < best[0]:
                best = (err, pick, tag)
            self.part.EditUndo2(1)
            self.rebuild()
        if best is None:
            raise SolidworksError(f"{step.id} ({step.name}): สร้าง {step.kind} ไม่สำเร็จ {last_error}")
        best[1](step)
        feature = self._edge_call(step)
        self.rebuild()
        if feature is not None:
            self._rename(feature, step.name)
        return self._row(step, "mismatch", self.error_of(step), best[2])

    def _rename(self, feature: Any, name: str) -> None:
        try:
            feature.Name = name
        except Exception:  # noqa: BLE001 - a rejected name keeps the SOLIDWORKS default
            pass

    @staticmethod
    def _row(step: Step, state: str, err: tuple[float, float], how: str) -> dict[str, Any]:
        return {
            "id": step.id,
            "name": step.name,
            "state": state,
            "volume_error_percent": round(err[0] * 100, 4) if math.isfinite(err[0]) else None,
            "center_error_mm": round(err[1], 4) if math.isfinite(err[1]) else None,
            "variant": how,
        }

    def run(self, steps: list[Step], path: Path) -> SwReport:
        revision = self.connect()
        self.log(f"เชื่อมต่อ SOLIDWORKS rev {revision}")
        self.new_part()
        rows = []
        for step in steps:
            self.log(f"{step.id}: {step.name}")
            row = self.edge_feature(step) if step.kind in ("fillet", "chamfer") else self.sketched_feature(step)
            rows.append(row)
        self.clear()
        self.rebuild()
        self.save(path)
        volume, _ = self.measure()
        bad = [r["id"] for r in rows if r["state"] != "ok"]
        msg = "สร้างครบ ค่าปริมาตรและจุดศูนย์ถ่วงตรงกับไฟล์ STEP ทุกฟีเจอร์"
        if bad:
            msg = f"เซฟแล้ว แต่ฟีเจอร์ {', '.join(bad)} ค่าไม่ตรงกับไฟล์ STEP ควรตรวจใน SOLIDWORKS"
        return SwReport(not bad, str(path), revision, round(volume, 2), rows, msg)


def target_path(folder: Path, stem: str, year: int) -> Path:
    """Put the version in the name so a 2025 file is never mistaken for a 2018 one."""
    return folder / f"{stem}_SW{year}.SLDPRT"


def build_sldprt(steps: list[Step], folder: Path, stem: str, log: Callable[[str], None] = lambda _: None) -> SwReport:
    """Entry point for the web server. SOLIDWORKS handles one job at a time."""
    state = status()
    if not state["available"]:
        raise SolidworksError(state["reason"])
    import pythoncom

    with _lock:
        pythoncom.CoInitialize()
        try:
            year = state["version"]
            return Builder(com_api(), log, year).run(steps, target_path(folder, stem, year))
        finally:
            pythoncom.CoUninitialize()
