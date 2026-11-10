"""Turns a Plan into real B-rep geometry with OpenCASCADE, then STEP and STL files.

Each feature becomes one or more primitive Steps. A Step keeps the exact sketch, the
volume and bounding box expected after it, and the edge points for fillets, so the
SOLIDWORKS backend can rebuild the same part and check itself feature by feature.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

import cadquery as cq
from cadquery.occ_impl.shapes import wiresToFaces

from . import plan as P

TOL = 1e-6

PLANES = {
    "Front": {"x": (1, 0, 0), "n": (0, 0, 1)},
    "Top": {"x": (1, 0, 0), "n": (0, 1, 0)},
    "Right": {"x": (0, 0, -1), "n": (1, 0, 0)},
}


Point2 = tuple[float, float]


class BuildError(Exception):
    def __init__(self, feature_id: str, message: str):
        super().__init__(f"{feature_id}: {message}")
        self.feature_id = feature_id
        self.message = message


@dataclass
class Step:
    id: str
    kind: str  # extrude | cut | revolve | fillet | chamfer
    name: str
    plane: str = ""
    offset: float = 0.0
    loops: list[list[dict[str, Any]]] = field(default_factory=list)
    depth: float = 0.0
    through: bool = False
    direction: str = "normal"
    draft_deg: float = 0.0
    axis: Optional[tuple[tuple[float, float], tuple[float, float]]] = None
    angle_deg: float = 360.0
    is_cut: bool = False
    size: float = 0.0
    edge_points: list[tuple[float, float, float]] = field(default_factory=list)
    volume_after: float = 0.0
    bbox_after: list[float] = field(default_factory=list)
    center_after: list[float] = field(default_factory=list)


@dataclass
class BuildResult:
    shape: cq.Shape
    steps: list[Step]
    volume_mm3: float
    bbox: list[float]
    size: list[float]
    mass_g: float
    surface_mm2: float
    faces: int
    solids: int
    warnings: list[str]

    def summary(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("shape", None)
        d.pop("steps", None)
        d["step_count"] = len(self.steps)
        return d


# ---------- sketch entities to closed loops ----------
def line(a: Point2, b: Point2) -> dict[str, Any]:
    return {"t": "line", "a": list(a), "b": list(b)}


def arc(c: Point2, a: Point2, b: Point2, ccw: bool) -> dict[str, Any]:
    return {"t": "arc", "c": list(c), "a": list(a), "b": list(b), "ccw": ccw}


def circle(c: Point2, r: float) -> dict[str, Any]:
    return {"t": "circle", "c": list(c), "r": r}


def _polyline(pts: list[Point2]) -> list[dict[str, Any]]:
    return [line(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]


def loops_of(entity: Any) -> list[list[dict[str, Any]]]:
    if isinstance(entity, P.Rect):
        x, y, w, h = entity.cx, entity.cy, entity.w / 2, entity.h / 2
        return [_polyline([(x - w, y - h), (x + w, y - h), (x + w, y + h), (x - w, y + h)])]
    if isinstance(entity, P.Circle):
        return [[circle((entity.cx, entity.cy), entity.d / 2)]]
    if isinstance(entity, P.RegularPolygon):
        r, a0 = entity.d / 2, math.radians(entity.angle_deg)
        return [
            _polyline(
                [
                    (
                        entity.cx + r * math.cos(a0 + 2 * math.pi * i / entity.sides),
                        entity.cy + r * math.sin(a0 + 2 * math.pi * i / entity.sides),
                    )
                    for i in range(entity.sides)
                ]
            )
        ]
    if isinstance(entity, P.Slot):
        L, R, t = (entity.length - entity.width) / 2, entity.width / 2, math.radians(entity.angle_deg)
        ux, uy, nx, ny = math.cos(t), math.sin(t), -math.sin(t), math.cos(t)
        c1 = (entity.cx + L * ux, entity.cy + L * uy)
        c2 = (entity.cx - L * ux, entity.cy - L * uy)
        p1 = (c1[0] + R * nx, c1[1] + R * ny)
        p2 = (c2[0] + R * nx, c2[1] + R * ny)
        p3 = (c2[0] - R * nx, c2[1] - R * ny)
        p4 = (c1[0] - R * nx, c1[1] - R * ny)
        return [[arc(c1, p4, p1, True), line(p1, p2), arc(c2, p2, p3, True), line(p3, p4)]]
    if isinstance(entity, P.Profile):
        segs: list[dict[str, Any]] = []
        cur = tuple(entity.start)
        for s in entity.segments:
            if isinstance(s, P.LineTo):
                segs.append(line(cur, s.line_to))
                cur = tuple(s.line_to)
            else:
                ra = math.dist(s.center, cur)
                rb = math.dist(s.center, s.arc_to)
                if abs(ra - rb) > 0.01:
                    raise ValueError(
                        f"arc center {s.center} is not equidistant from {cur} and {s.arc_to}"
                    )
                segs.append(arc(s.center, cur, s.arc_to, s.ccw))
                cur = tuple(s.arc_to)
        if math.dist(cur, entity.start) > TOL:
            segs.append(line(cur, entity.start))
        return [segs]
    raise ValueError(f"unknown sketch entity {entity!r}")


def _arc_mid(s: dict[str, Any]) -> Point2:
    c, a, b = s["c"], s["a"], s["b"]
    r = math.dist(c, a)
    a0 = math.atan2(a[1] - c[1], a[0] - c[0])
    a1 = math.atan2(b[1] - c[1], b[0] - c[0])
    sweep = (a1 - a0) % (2 * math.pi) if s["ccw"] else -((a0 - a1) % (2 * math.pi))
    m = a0 + sweep / 2
    return (c[0] + r * math.cos(m), c[1] + r * math.sin(m))


def make_plane(name: str, offset: float) -> cq.Plane:
    d = PLANES[name]
    n = cq.Vector(*d["n"])
    return cq.Plane(origin=(n * offset).toTuple(), xDir=d["x"], normal=d["n"])


def wire_of(loop: list[dict[str, Any]], pl: cq.Plane) -> cq.Wire:
    w = lambda p: pl.toWorldCoords((p[0], p[1], 0))  # noqa: E731
    if len(loop) == 1 and loop[0]["t"] == "circle":
        s = loop[0]
        return cq.Wire.assembleEdges([cq.Edge.makeCircle(s["r"], w(s["c"]), pl.zDir)])
    edges = []
    for s in loop:
        if s["t"] == "line":
            edges.append(cq.Edge.makeLine(w(s["a"]), w(s["b"])))
        else:
            edges.append(cq.Edge.makeThreePointArc(w(s["a"]), w(_arc_mid(s)), w(s["b"])))
    return cq.Wire.assembleEdges(edges)


def faces_of(loops: list[list[dict[str, Any]]], pl: cq.Plane) -> list[cq.Face]:
    return wiresToFaces([wire_of(l, pl) for l in loops])


def prism(
    faces: list[cq.Face], pl: cq.Plane, start: float, end: float, taper: float = 0.0
) -> cq.Shape:
    """Solid swept along the plane normal from z=start to z=end."""
    normal = pl.zDir
    solids = []
    for f in faces:
        base = f.translate(normal * start) if abs(start) > TOL else f
        solids.append(cq.Solid.extrudeLinear(base, normal * (end - start), taper))
    out: cq.Shape = solids[0]
    if len(solids) > 1:
        out = out.fuse(*solids[1:])
    return out


def _bbox(s: cq.Shape) -> list[float]:
    b = s.BoundingBox(tolerance=1e-3)
    return [round(v, 4) for v in (b.xmin, b.ymin, b.zmin, b.xmax, b.ymax, b.zmax)]


def _solids(s: cq.Shape) -> int:
    return len(s.Solids())


def select_edges(body: cq.Shape, sel: P.EdgeSelector) -> list[cq.Edge]:
    edges: list[cq.Edge] = body.Edges()
    bb = body.BoundingBox()
    axes = {"X": 0, "Y": 1, "Z": 2}

    def keep(e: cq.Edge) -> bool:
        geom = e.geomType()
        if sel.kind == "line" and geom != "LINE":
            return False
        if sel.kind == "circle" and geom != "CIRCLE":
            return False
        if sel.parallel_to:
            if geom != "LINE":
                return False
            d = (e.endPoint() - e.startPoint()).normalized().toTuple()
            if abs(abs(d[axes[sel.parallel_to]]) - 1) > 1e-6:
                return False
        if sel.on:
            i = axes[sel.on.axis]
            lo = (bb.xmin, bb.ymin, bb.zmin)[i]
            hi = (bb.xmax, bb.ymax, bb.zmax)[i]
            at = hi if sel.on.at == "max" else lo if sel.on.at == "min" else float(sel.on.at)
            eb = e.BoundingBox()
            vals = ((eb.xmin, eb.xmax), (eb.ymin, eb.ymax), (eb.zmin, eb.zmax))[i]
            if abs(vals[0] - at) > 1e-4 or abs(vals[1] - at) > 1e-4:
                return False
        return True

    picked = [e for e in edges if keep(e)]
    if sel.near:
        chosen = []
        for pt in sel.near:
            v = cq.Vector(*pt)
            chosen.append(min(picked or edges, key=lambda e: e.distance(cq.Vertex.makeVertex(*v.toTuple()))))
        unique: list[cq.Edge] = []
        for e in chosen:
            if not any(e.isSame(u) for u in unique):
                unique.append(e)
        picked = unique
    return picked


def _expand(feature: Any) -> list[Step]:
    """Convert a plan feature into primitive steps (geometry filled in later)."""
    name = feature.name or feature.id
    if isinstance(feature, P.Extrude):
        loops = [l for e in feature.sketch for l in loops_of(e)]
        return [
            Step(feature.id, "extrude", name, feature.plane, feature.offset, loops,
                 feature.depth, False, feature.direction)
        ]
    if isinstance(feature, P.Cut):
        loops = [l for e in feature.sketch for l in loops_of(e)]
        return [
            Step(feature.id, "cut", name, feature.plane, feature.offset, loops,
                 feature.depth or 0.0, feature.through, feature.direction)
        ]
    if isinstance(feature, P.Revolve):
        loops = [l for e in feature.sketch for l in loops_of(e)]
        return [
            Step(feature.id, "revolve", name, feature.plane, 0.0, loops, axis=(feature.axis_a, feature.axis_b),
                 angle_deg=feature.angle_deg, is_cut=feature.cut)
        ]
    if isinstance(feature, P.Hole):
        pts = feature.all_points()
        common = dict(plane=feature.plane, offset=feature.offset, direction=feature.direction)
        out = [
            Step(feature.id, "cut", name,
                 loops=[[circle(p, feature.diameter / 2)] for p in pts],
                 depth=feature.depth or 0.0, through=feature.through, **common)
        ]
        if feature.cbore_d:
            out.append(
                Step(f"{feature.id}_cbore", "cut", f"{name} counterbore",
                     loops=[[circle(p, feature.cbore_d / 2)] for p in pts],
                     depth=feature.cbore_depth or 0.0, **common)
            )
        if feature.csk_d:
            half = feature.csk_angle_deg / 2
            h = (feature.csk_d - feature.diameter) / 2 / math.tan(math.radians(half))
            out.append(
                Step(f"{feature.id}_csk", "cut", f"{name} countersink",
                     loops=[[circle(p, feature.csk_d / 2)] for p in pts],
                     depth=h, draft_deg=half, **common)
            )
        return out
    if isinstance(feature, P.Fillet):
        return [Step(feature.id, "fillet", name, size=feature.radius)]
    if isinstance(feature, P.Chamfer):
        return [Step(feature.id, "chamfer", name, size=feature.distance)]
    raise ValueError(f"unknown feature {feature!r}")


def _direction_range(step: Step, reach: float) -> tuple[float, float]:
    length = reach if step.through else step.depth
    if step.direction == "normal":
        return 0.0, length
    if step.direction == "reverse":
        return 0.0, -length
    half = reach if step.through else step.depth / 2
    return -half, half


def build(plan: P.Plan) -> BuildResult:
    body: Optional[cq.Shape] = None
    steps: list[Step] = []
    warnings: list[str] = []

    for feature in plan.features:
        try:
            expanded = _expand(feature)
        except ValueError as e:
            raise BuildError(feature.id, str(e)) from e
        for step in expanded:
            before = body.Volume() if body is not None else 0.0
            try:
                body = _apply(step, feature, body)
            except BuildError:
                raise
            except Exception as e:  # OpenCASCADE raises many low-level error types
                raise BuildError(step.id, f"geometry failed: {e}") from e
            if body is None or not body.isValid():
                raise BuildError(step.id, "result is not a valid solid")
            volume = body.Volume()
            if volume <= 0:
                raise BuildError(step.id, "result has no volume")
            if step.kind in ("cut",) or step.is_cut:
                if abs(volume - before) < 1e-6:
                    raise BuildError(step.id, "this cut removed no material; check plane, direction and position")
            if step.kind == "extrude" and steps and abs(volume - before) < 1e-6:
                raise BuildError(step.id, "this extrude added no material; it is fully inside the body")
            if _solids(body) > 1:
                raise BuildError(
                    step.id,
                    f"the part split into {_solids(body)} separate bodies; features must connect into one solid",
                )
            step.volume_after = round(volume, 4)
            step.bbox_after = _bbox(body)
            step.center_after = [round(v, 4) for v in cq.Shape.centerOfMass(body).toTuple()]
            steps.append(step)

    assert body is not None
    b = _bbox(body)
    volume = body.Volume()
    return BuildResult(
        shape=body,
        steps=steps,
        volume_mm3=round(volume, 3),
        bbox=b,
        size=[round(b[3] - b[0], 3), round(b[4] - b[1], 3), round(b[5] - b[2], 3)],
        mass_g=round(volume * plan.density_g_cm3 / 1000, 2),
        surface_mm2=round(body.Area(), 2),
        faces=len(body.Faces()),
        solids=_solids(body),
        warnings=warnings,
    )


def _apply(step: Step, feature: Any, body: Optional[cq.Shape]) -> cq.Shape:
    if step.kind in ("fillet", "chamfer"):
        if body is None:
            raise BuildError(step.id, "nothing to fillet yet")
        edges = select_edges(body, feature.edges)
        if not edges:
            raise BuildError(step.id, "the edge selector matched no edges")
        step.edge_points = [tuple(round(v, 6) for v in e.positionAt(0.5).toTuple()) for e in edges]
        if step.kind == "fillet":
            return body.fillet(step.size, edges).clean()
        return body.chamfer(step.size, None, edges).clean()

    pl = make_plane(step.plane, step.offset)
    faces = faces_of(step.loops, pl)
    if not faces:
        raise BuildError(step.id, "sketch has no closed area")

    if step.kind == "revolve":
        a, b = step.axis
        w = lambda p: pl.toWorldCoords((p[0], p[1], 0))  # noqa: E731
        tool: cq.Shape = cq.Solid.revolve(faces[0], step.angle_deg, w(a), w(b))
        for f in faces[1:]:
            tool = tool.fuse(cq.Solid.revolve(f, step.angle_deg, w(a), w(b)))
        if body is None:
            return tool
        return (body.cut(tool) if step.is_cut else body.fuse(tool)).clean()

    if step.kind == "extrude":
        z0, z1 = _direction_range(step, 0)
        tool = prism(faces, pl, z0, z1)
        return tool if body is None else body.fuse(tool).clean()

    if step.kind == "cut":
        if body is None:
            raise BuildError(step.id, "cannot cut before a body exists")
        bb = body.BoundingBox()
        reach = 2 * bb.DiagonalLength + abs(step.offset) + 1
        z0, z1 = _direction_range(step, reach)
        tool = prism(faces, pl, z0, z1, step.draft_deg)
        return body.cut(tool).clean()

    raise BuildError(step.id, f"unknown step kind {step.kind}")


def export(result: BuildResult, folder: Path, stem: str) -> dict[str, Path]:
    folder.mkdir(parents=True, exist_ok=True)
    step_path = folder / f"{stem}.step"
    stl_path = folder / f"{stem}.stl"
    cq.exporters.export(
        cq.Workplane("XY").newObject([result.shape]), str(step_path), opt={"write_pcurves": True}
    )
    result.shape.exportStl(str(stl_path), tolerance=0.05, angularTolerance=0.15)
    return {"step": step_path, "stl": stl_path}


def verify_step(path: Path, expected_volume: float) -> dict[str, Any]:
    """Read the exported file back and compare it with the built solid."""
    shape = cq.importers.importStep(str(path)).val()
    volume = shape.Volume()
    diff = abs(volume - expected_volume) / expected_volume * 100
    return {
        "ok": bool(shape.isValid() and diff < 0.01),
        "volume_mm3": round(volume, 3),
        "diff_percent": round(diff, 5),
    }
