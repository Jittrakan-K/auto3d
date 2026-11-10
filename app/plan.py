"""CAD feature plan: the one format shared by the AI, the STEP engine and SOLIDWORKS.

The AI never writes executable code. It writes this JSON, which is validated here,
so a bad answer can only produce a validation error, never run anything on the PC.

Coordinates follow SOLIDWORKS (Y is up). All lengths are millimetres.
  Front plane: sketch x = +X, sketch y = +Y, normal +Z
  Top plane:   sketch x = +X, sketch y = -Z, normal +Y
  Right plane: sketch x = -Z, sketch y = +Y, normal +X
"""
from __future__ import annotations

import ast
import copy
import math
import operator
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

Point = tuple[float, float]
Plane = Literal["Front", "Top", "Right"]
Direction = Literal["normal", "reverse", "both"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------- sketch entities ----------
class Rect(Strict):
    type: Literal["rect"]
    cx: float = 0
    cy: float = 0
    w: float = Field(gt=0, description="Size along sketch x")
    h: float = Field(gt=0, description="Size along sketch y")


class Circle(Strict):
    type: Literal["circle"]
    cx: float = 0
    cy: float = 0
    d: float = Field(gt=0, description="Diameter")


class Slot(Strict):
    type: Literal["slot"]
    cx: float = 0
    cy: float = 0
    length: float = Field(gt=0, description="Overall length, tip to tip")
    width: float = Field(gt=0)
    angle_deg: float = 0

    @model_validator(mode="after")
    def _check(self) -> "Slot":
        if self.length <= self.width:
            raise ValueError("slot length must be greater than width")
        return self


class RegularPolygon(Strict):
    type: Literal["regular_polygon"]
    cx: float = 0
    cy: float = 0
    sides: int = Field(ge=3, le=64)
    d: float = Field(gt=0, description="Across-corners diameter")
    angle_deg: float = 0


class LineTo(Strict):
    line_to: Point


class ArcTo(Strict):
    arc_to: Point
    center: Point
    ccw: bool = True


class Profile(Strict):
    """Closed outline made of lines and arcs. It closes itself back to start."""

    type: Literal["profile"]
    start: Point
    segments: list[Union[LineTo, ArcTo]] = Field(min_length=2)


SketchEntity = Annotated[
    Union[Rect, Circle, Slot, RegularPolygon, Profile], Field(discriminator="type")
]


# ---------- features ----------
class Base(Strict):
    id: str = Field(description="Short unique id such as F1")
    name: str = Field(default="", description="Readable name shown in the feature tree")


class Extrude(Base):
    type: Literal["extrude"]
    plane: Plane
    offset: float = Field(default=0, description="Sketch plane distance along the plane normal")
    sketch: list[SketchEntity] = Field(min_length=1)
    depth: float = Field(gt=0, description="For direction 'both' this is the total depth")
    direction: Direction = "normal"


class Cut(Base):
    type: Literal["cut"]
    plane: Plane
    offset: float = 0
    sketch: list[SketchEntity] = Field(min_length=1)
    depth: Optional[float] = Field(default=None, gt=0, description="Omit when through is true")
    through: bool = False
    direction: Direction = "normal"

    @model_validator(mode="after")
    def _check(self) -> "Cut":
        if self.through == (self.depth is not None):
            raise ValueError("cut needs either depth or through=true, not both")
        if self.direction == "both" and not self.through:
            raise ValueError("direction 'both' on a cut is only allowed with through=true")
        return self


class Revolve(Base):
    type: Literal["revolve"]
    plane: Plane
    sketch: list[SketchEntity] = Field(min_length=1, description="Must stay on one side of the axis")
    axis_a: Point
    axis_b: Point
    angle_deg: float = Field(default=360, gt=0, le=360)
    cut: bool = False


class BoltCircle(Strict):
    cx: float = 0
    cy: float = 0
    pcd: float = Field(gt=0)
    count: int = Field(ge=1, le=256)
    start_deg: float = 0


class Grid(Strict):
    cx: float = 0
    cy: float = 0
    nx: int = Field(ge=1, le=256)
    ny: int = Field(ge=1, le=256)
    dx: float = 0
    dy: float = 0


class Hole(Base):
    type: Literal["hole"]
    plane: Plane
    offset: float = 0
    direction: Literal["normal", "reverse"] = "normal"
    points: list[Point] = Field(default_factory=list)
    bolt_circle: Optional[BoltCircle] = None
    grid: Optional[Grid] = None
    diameter: float = Field(gt=0)
    depth: Optional[float] = Field(default=None, gt=0)
    through: bool = False
    cbore_d: Optional[float] = Field(default=None, gt=0)
    cbore_depth: Optional[float] = Field(default=None, gt=0)
    csk_d: Optional[float] = Field(default=None, gt=0)
    csk_angle_deg: float = Field(default=90, gt=0, lt=180)

    @model_validator(mode="after")
    def _check(self) -> "Hole":
        if self.through == (self.depth is not None):
            raise ValueError("hole needs either depth or through=true, not both")
        if not (self.points or self.bolt_circle or self.grid):
            raise ValueError("hole needs points, bolt_circle or grid")
        if (self.cbore_d is None) != (self.cbore_depth is None):
            raise ValueError("counterbore needs both cbore_d and cbore_depth")
        if self.cbore_d and self.csk_d:
            raise ValueError("a hole cannot be both counterbored and countersunk")
        if self.cbore_d and self.cbore_d <= self.diameter:
            raise ValueError("cbore_d must be larger than diameter")
        if self.csk_d and self.csk_d <= self.diameter:
            raise ValueError("csk_d must be larger than diameter")
        return self

    def all_points(self) -> list[Point]:
        pts = list(self.points)
        if self.bolt_circle:
            b = self.bolt_circle
            for i in range(b.count):
                a = math.radians(b.start_deg + 360 * i / b.count)
                pts.append((b.cx + b.pcd / 2 * math.cos(a), b.cy + b.pcd / 2 * math.sin(a)))
        if self.grid:
            g = self.grid
            for i in range(g.nx):
                for j in range(g.ny):
                    pts.append(
                        (g.cx + (i - (g.nx - 1) / 2) * g.dx, g.cy + (j - (g.ny - 1) / 2) * g.dy)
                    )
        return pts


class OnPlane(Strict):
    axis: Literal["X", "Y", "Z"]
    at: Union[float, Literal["max", "min"]]


class EdgeSelector(Strict):
    """All filled conditions must match. An empty selector means every edge."""

    parallel_to: Optional[Literal["X", "Y", "Z"]] = None
    on: Optional[OnPlane] = None
    kind: Optional[Literal["line", "circle"]] = None
    near: list[tuple[float, float, float]] = Field(
        default_factory=list, description="Global XYZ points; picks the closest edge to each"
    )


class Fillet(Base):
    type: Literal["fillet"]
    radius: float = Field(gt=0)
    edges: EdgeSelector = Field(default_factory=EdgeSelector)


class Chamfer(Base):
    type: Literal["chamfer"]
    distance: float = Field(gt=0, description="Equal 45 degree chamfer leg")
    edges: EdgeSelector = Field(default_factory=EdgeSelector)


Feature = Annotated[
    Union[Extrude, Cut, Revolve, Hole, Fillet, Chamfer], Field(discriminator="type")
]


class Parameter(Strict):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    value: Union[float, str] = Field(description="A number, or an expression such as '=L/2'")
    label: str = Field(default="", description="Thai description shown to the user")
    source: str = Field(default="", description="Where it came from, e.g. 'Drawing front view'")
    confidence: Literal["high", "medium", "low"] = "high"


class Plan(Strict):
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    density_g_cm3: float = Field(default=7.85, gt=0)
    parameters: list[Parameter] = Field(default_factory=list)
    features: list[Feature] = Field(min_length=1)
    assumptions: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> "Plan":
        first = self.features[0]
        if not isinstance(first, (Extrude, Revolve)) or getattr(first, "cut", False):
            raise ValueError("the first feature must be an extrude or a non-cut revolve")
        ids = [f.id for f in self.features]
        if len(ids) != len(set(ids)):
            raise ValueError("feature ids must be unique")
        return self


# ---------- parameter expressions ----------
class ExpressionError(ValueError):
    pass


_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}
_FUNCS = {
    "sqrt": math.sqrt, "sin": lambda d: math.sin(math.radians(d)),
    "cos": lambda d: math.cos(math.radians(d)), "tan": lambda d: math.tan(math.radians(d)),
    "abs": abs, "min": min, "max": max, "round": round,
}


def evaluate(expr: str, names: dict[str, float]) -> float:
    """Evaluate arithmetic only. Anything else in the expression is rejected."""

    def walk(n: ast.AST) -> float:
        if isinstance(n, ast.Expression):
            return walk(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return float(n.value)
        if isinstance(n, ast.Name):
            if n.id == "pi":
                return math.pi
            if n.id in names:
                return names[n.id]
            raise ExpressionError(f"unknown name '{n.id}' in '{expr}'")
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            return float(_OPS[type(n.op)](walk(n.left), walk(n.right)))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return float(_OPS[type(n.op)](walk(n.operand)))
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in _FUNCS and not n.keywords:
            return float(_FUNCS[n.func.id](*[walk(a) for a in n.args]))
        raise ExpressionError(f"'{expr}' is not a plain arithmetic expression")

    if len(expr) > 200:
        raise ExpressionError("expression too long")
    try:
        return walk(ast.parse(expr, mode="eval"))
    except SyntaxError as e:
        raise ExpressionError(f"cannot read expression '{expr}'") from e
    except ZeroDivisionError as e:
        raise ExpressionError(f"division by zero in '{expr}'") from e


def resolve(raw: dict[str, Any]) -> tuple[dict[str, Any], dict[str, float]]:
    """Replace every '=expr' value in a raw plan with its number."""
    data = copy.deepcopy(raw)
    names: dict[str, float] = {}
    for p in data.get("parameters", []) or []:
        v = p.get("value")
        val = evaluate(v[1:], names) if isinstance(v, str) and v.startswith("=") else float(v)
        names[p["name"]] = val

    def walk(node: Any, key: str = "") -> Any:
        if isinstance(node, dict):
            return {k: walk(v, k) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v, key) for v in node]
        if isinstance(node, str) and node.startswith("="):
            value = evaluate(node[1:], names)
            return int(round(value)) if key in ("count", "nx", "ny", "sides") else value
        return node

    data["features"] = walk(data.get("features", []))
    return data, names


def parse_plan(raw: dict[str, Any]) -> Plan:
    data, names = resolve(raw)
    for p in data.get("parameters", []) or []:
        p["value"] = names[p["name"]]
    return Plan.model_validate(data)


def llm_schema() -> dict[str, Any]:
    """JSON schema for the AI tool. Numbers may also be '=expression' strings."""
    schema = Plan.model_json_schema()

    def widen(node: Any) -> Any:
        if isinstance(node, dict):
            if node.get("type") in ("number", "integer") and "anyOf" not in node:
                extra = {k: node[k] for k in ("description", "default") if k in node}
                return {"anyOf": [{"type": node["type"]}, {"type": "string", "pattern": "^="}], **extra}
            drop = ("discriminator", "title")  # pydantic extras that the model does not need
            return {k: widen(v) for k, v in node.items() if not (k in drop and not isinstance(v, dict))
                    and k != "discriminator"}
        if isinstance(node, list):
            return [widen(v) for v in node]
        return node

    return widen(schema)
