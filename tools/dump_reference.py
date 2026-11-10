"""Writes tools/reference.json from the Python engine, for tools/parity.mjs."""
import json
from pathlib import Path

from app import cad_engine as E, plan as P, sw_macro as M

ROOT = Path(__file__).resolve().parent.parent
out = {}
for path in sorted((ROOT / "examples").glob("*.json")):
    plan = P.parse_plan(json.loads(path.read_text(encoding="utf-8")))
    r = E.build(plan)
    out[path.name] = {
        "volume": r.volume_mm3,
        "steps": [{"id": s.id, "v": s.volume_after, "c": s.center_after, "edges": s.edge_points} for s in r.steps],
        "macro": M.render(r.steps, plan.name),
    }
(ROOT / "tools" / "reference.json").write_text(json.dumps(out), encoding="utf-8")
print("tools/reference.json written")
