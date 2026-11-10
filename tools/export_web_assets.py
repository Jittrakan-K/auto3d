"""Copies the shared rules into docs/ so the GitHub Pages site uses the same ones.

Run after changing app/plan.py, app/sw_macro.py or examples/:
    python tools/export_web_assets.py
"""
import json
import shutil
from pathlib import Path

from app import ai_planner, plan as P, sw_macro

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

(DOCS / "assets").mkdir(parents=True, exist_ok=True)
(DOCS / "assets" / "plan-schema.json").write_text(json.dumps(P.llm_schema(), ensure_ascii=False), encoding="utf-8")
(DOCS / "assets" / "macro-helpers.bas").write_text(sw_macro.HELPERS, encoding="utf-8")
(DOCS / "assets" / "system-prompt.txt").write_text(ai_planner.SYSTEM, encoding="utf-8")
(DOCS / "examples").mkdir(exist_ok=True)
for path in sorted((ROOT / "examples").glob("*.json")):
    shutil.copy(path, DOCS / "examples" / path.name)
(DOCS / "examples" / "index.json").write_text(
    json.dumps(sorted(p.name for p in (ROOT / "examples").glob("*.json"))), encoding="utf-8"
)
print("docs/assets and docs/examples updated")
