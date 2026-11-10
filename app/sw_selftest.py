"""Builds every example in the installed SOLIDWORKS and writes sw_test_log.txt.

Run through test_solidworks.bat. Nothing outside output/selftest is touched.
"""
from __future__ import annotations

import faulthandler
import json
import sys
import traceback
from datetime import datetime
from pathlib import Path

from . import cad_engine as E, plan as P, sw_backend as S, sw_macro as M

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "sw_test_log.txt"


def close(year: int, *names: str) -> None:
    """Close only the test parts, so a part the user has open is never touched."""
    sw = S.com_api().dispatch(f"SldWorks.Application.{year - S.YEAR_OFFSET}")
    for name in names:
        for title in (name, f"{name}.SLDPRT"):
            try:
                sw.CloseDoc(title)
            except Exception:  # noqa: BLE001 - it may simply not be open
                pass


def run_macro(key: str, plan: P.Plan, result: E.BuildResult, year: int, out) -> bool:
    """Run the same macro a user would run, in a clean folder, and read its verdict."""
    folder = ROOT / "output" / "selftest" / f"macro_{key}"
    folder.mkdir(parents=True, exist_ok=True)
    close(year, f"{plan.name}_SW{year}", plan.name)
    for old in folder.iterdir():
        old.unlink()
    macro = folder / f"{plan.name}.swb"
    macro.write_bytes(M.render(result.steps, plan.name, quiet=True).encode("ascii"))
    api = S.com_api()
    sw = api.dispatch(f"SldWorks.Application.{year - S.YEAR_OFFSET}")
    error = api.byref_int()
    ok = sw.RunMacro2(str(macro), "", "main", 1, error)
    out(f"macro run={ok} error={error.value}")
    verdict = folder / "macro_result.txt"
    text = verdict.read_text(encoding="ascii", errors="replace").strip() if verdict.exists() else "NO RESULT"
    parts = [f.name for f in folder.glob("*.SLDPRT")]
    out(f"macro {text} files={parts}")
    return text == "PASS" and bool(parts)


def main() -> int:
    # The log is written line by line and a stuck call dumps its stack, so a hang is readable.
    log = LOG.open("w", encoding="utf-8", buffering=1)
    faulthandler.dump_traceback_later(90, repeat=True, file=log)

    def out(text: str = "") -> None:
        print(text, flush=True)
        log.write(text + "\n")

    out(f"AUTO DESIGN 3D SOLIDWORKS test {datetime.now():%Y-%m-%d %H:%M:%S}")
    out(f"python {sys.version.split()[0]} {sys.platform}")
    state = S.status()
    out(f"status: {state}")
    failed = 0
    if not state["available"]:
        failed = 1
    else:
        import pythoncom

        pythoncom.CoInitialize()
        for path in sorted((ROOT / "examples").glob("*.json")):
            out()
            out(f"=== {path.stem} ===")
            try:
                plan = P.parse_plan(json.loads(path.read_text(encoding="utf-8")))
                result = E.build(plan)
                year = state["version"]
                close(year, f"{plan.name}_SW{year}", plan.name)
                target = S.target_path(ROOT / "output" / "selftest", plan.name, year)
                report = S.Builder(S.com_api(), out, year).run(result.steps, target)
                out(f"revision {report.revision}")
                out(f"saved {report.path} exists={Path(report.path).exists()}")
                out(f"volume SOLIDWORKS {report.volume_mm3} / STEP {result.volume_mm3}")
                for row in report.steps:
                    out(f"  {row}")
                out(("PASS " if report.ok else "CHECK ") + report.message)
                failed += 0 if report.ok else 1
            except Exception:  # noqa: BLE001 - the log must hold the full error
                failed += 1
                out("FAIL")
                out(traceback.format_exc())
            try:
                failed += 0 if run_macro(path.stem, plan, result, state["version"], out) else 1
            except Exception:  # noqa: BLE001 - the log must hold the full error
                failed += 1
                out("MACRO FAIL")
                out(traceback.format_exc())
        pythoncom.CoUninitialize()
    out()
    out("RESULT: " + ("all parts passed" if not failed else f"{failed} problem(s)"))
    faulthandler.cancel_dump_traceback_later()
    log.close()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
