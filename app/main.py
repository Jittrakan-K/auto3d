"""Local web server. It listens on this computer only."""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, urlparse

from dotenv import load_dotenv, set_key
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai_planner, cad_engine as E, drawing_input, plan as P, sw_backend, sw_macro

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
ENV_FILE = ROOT / ".env"
OUTPUT = Path(os.environ.get("AUTODESIGN_OUTPUT", ROOT / "output"))
EXAMPLES = ROOT / "examples"
MAX_UPLOAD = 40_000_000
JOB_ID = re.compile(r"^[0-9]{8}_[0-9]{6}_[0-9a-f]{4}$")
LOCAL_HOSTS = {"127.0.0.1", "localhost"}
# Web pages on these sites may ask this app to build a .SLDPRT, nothing else.
WEB_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get("AUTODESIGN_WEB_ORIGINS", "https://jittrakan-k.github.io").split(",")
    if o.strip()
}
WEB_PATHS = {"/api/status", "/api/web/sldprt"}

load_dotenv(ENV_FILE)
app = FastAPI(title="AUTO DESIGN 3D", docs_url=None, redoc_url=None)


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Blocks other websites from reaching this server through the user's browser.

    The GitHub Pages site is the one exception, and only for the status check and
    the SLDPRT build, so the online page can use the SOLIDWORKS on this computer.
    """
    host = (request.headers.get("host") or "").split(":")[0]
    origin = (request.headers.get("origin") or "").rstrip("/")
    if host not in LOCAL_HOSTS:
        return JSONResponse({"error": "local access only"}, status_code=403)
    if origin and urlparse(origin).hostname not in LOCAL_HOSTS:
        if origin not in WEB_ORIGINS or request.url.path not in WEB_PATHS:
            return JSONResponse({"error": "local access only"}, status_code=403)
        cors = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Expose-Headers": "content-disposition, x-sw-ok, x-sw-year, x-sw-message",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=cors)
        response = await call_next(request)
        response.headers.update(cors)
        return response
    return await call_next(request)


def safe_stem(name: str) -> str:
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "part"
    return stem[:80]


def new_job_folder() -> tuple[str, Path]:
    job = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + os.urandom(2).hex()
    folder = OUTPUT / job
    folder.mkdir(parents=True, exist_ok=True)
    return job, folder


def job_folder(job: str) -> Path:
    if not JOB_ID.match(job):
        raise HTTPException(404, "ไม่พบงานนี้")
    folder = OUTPUT / job
    if not folder.is_dir():
        raise HTTPException(404, "ไม่พบงานนี้")
    return folder


def publish(raw: dict[str, Any], plan: P.Plan, result: E.BuildResult, extra: dict[str, Any]) -> dict[str, Any]:
    """Write every file for one model and describe them to the page."""
    job, folder = new_job_folder()
    stem = safe_stem(plan.name)
    files = E.export(result, folder, stem)
    verify = E.verify_step(files["step"], result.volume_mm3)
    macro = folder / f"{stem}.swb"
    macro.write_bytes(sw_macro.render(result.steps, plan.name).encode("ascii"))
    (folder / "plan.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "id": job,
        "name": plan.name,
        "stem": stem,
        "raw_plan": raw,
        "description": plan.description,
        "parameters": [p.model_dump() for p in plan.parameters],
        "assumptions": plan.assumptions,
        "questions": plan.questions,
        "features": [
            {"id": s.id, "kind": s.kind, "name": s.name, "volume_after": s.volume_after} for s in result.steps
        ],
        "summary": result.summary(),
        "verify": verify,
        "files": {"step": files["step"].name, "stl": files["stl"].name, "macro": macro.name},
        "folder": str(folder),
        **extra,
    }


def build_or_400(raw: dict[str, Any]) -> tuple[P.Plan, E.BuildResult]:
    built, error = ai_planner.try_build(raw)
    if not built:
        raise HTTPException(422, error)
    return built


# ---------- status and settings ----------
@app.get("/api/status")
def status() -> dict[str, Any]:
    return {
        "api_key": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()),
        "model": os.environ.get("AUTODESIGN_MODEL") or ai_planner.DEFAULT_MODEL,
        "models": ai_planner.MODELS,
        "solidworks": sw_backend.status(),
    }


class Settings(BaseModel):
    api_key: Optional[str] = None
    model: Optional[str] = None


@app.post("/api/settings")
def settings(body: Settings) -> dict[str, Any]:
    ENV_FILE.touch(exist_ok=True)
    if body.api_key is not None and body.api_key.strip():
        key = body.api_key.strip()
        if not re.fullmatch(r"[A-Za-z0-9_\-]{20,300}", key):
            raise HTTPException(422, "รูปแบบ API key ไม่ถูกต้อง")
        set_key(str(ENV_FILE), "ANTHROPIC_API_KEY", key)
        os.environ["ANTHROPIC_API_KEY"] = key
    if body.model:
        if body.model not in ai_planner.MODELS:
            raise HTTPException(422, "ไม่รู้จักโมเดลนี้")
        set_key(str(ENV_FILE), "AUTODESIGN_MODEL", body.model)
        os.environ["AUTODESIGN_MODEL"] = body.model
    return status()


# ---------- models ----------
@app.get("/api/examples")
def examples() -> list[dict[str, Any]]:
    out = []
    for path in sorted(EXAMPLES.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        out.append({"key": path.stem, "name": raw["name"], "description": raw.get("description", ""), "plan": raw})
    return out


class BuildRequest(BaseModel):
    plan: dict[str, Any]


@app.post("/api/build")
def build(body: BuildRequest) -> dict[str, Any]:
    plan, result = build_or_400(body.plan)
    return publish(body.plan, plan, result, {"source": "manual"})


@app.post("/api/generate")
def generate(
    prompt: str = Form(""),
    current_plan: str = Form(""),
    model: str = Form(""),
    files: list[UploadFile] = File(default=[]),
) -> dict[str, Any]:
    if not prompt.strip() and not files:
        raise HTTPException(422, "พิมพ์คำสั่งหรือแนบ Drawing อย่างน้อยหนึ่งอย่าง")
    blocks: list[dict[str, Any]] = []
    try:
        for f in files:
            data = f.file.read(MAX_UPLOAD + 1)
            if len(data) > MAX_UPLOAD:
                raise drawing_input.DrawingError(f"{f.filename} ใหญ่เกิน 40 MB")
            blocks += drawing_input.to_blocks(f.filename or "drawing", data)
    except drawing_input.DrawingError as e:
        raise HTTPException(422, str(e)) from e
    current = json.loads(current_plan) if current_plan.strip() else None
    try:
        r = ai_planner.make_plan(prompt, blocks, current, model or None)
    except ai_planner.PlannerError as e:
        raise HTTPException(502, str(e)) from e
    return publish(
        r.raw_plan,
        r.plan,
        r.build,
        {
            "source": "ai",
            "attempts": r.attempts,
            "model": r.model,
            "usage": {"input_tokens": r.input_tokens, "output_tokens": r.output_tokens},
        },
    )


@app.post("/api/jobs/{job}/sldprt")
def make_sldprt(job: str) -> dict[str, Any]:
    folder = job_folder(job)
    raw = json.loads((folder / "plan.json").read_text(encoding="utf-8"))
    plan, result = build_or_400(raw)
    try:
        report = sw_backend.build_sldprt(result.steps, folder, safe_stem(plan.name))
    except sw_backend.SolidworksError as e:
        raise HTTPException(409, str(e)) from e
    except Exception as e:  # noqa: BLE001 - COM errors reach the page as readable text
        raise HTTPException(500, f"SOLIDWORKS ขัดข้อง: {e}") from e
    return {
        "ok": report.ok,
        "file": Path(report.path).name,
        "revision": report.revision,
        "volume_mm3": report.volume_mm3,
        "steps": report.steps,
        "message": report.message,
    }


@app.post("/api/web/sldprt")
def web_sldprt(body: BuildRequest) -> Response:
    """Build the plan from the online page in SOLIDWORKS and send the .SLDPRT back."""
    plan, result = build_or_400(body.plan)
    job, folder = new_job_folder()
    stem = safe_stem(plan.name)
    (folder / "plan.json").write_text(json.dumps(body.plan, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        report = sw_backend.build_sldprt(result.steps, folder, stem)
    except sw_backend.SolidworksError as e:
        raise HTTPException(409, str(e)) from e
    except Exception as e:  # noqa: BLE001 - COM errors reach the page as readable text
        raise HTTPException(500, f"SOLIDWORKS ขัดข้อง: {e}") from e
    path = Path(report.path)
    if not path.is_file():
        raise HTTPException(500, "SOLIDWORKS ไม่ได้บันทึกไฟล์")
    year = int(report.revision.split(".")[0]) + sw_backend.YEAR_OFFSET
    return Response(
        path.read_bytes(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(path.name)}",
            "X-SW-Ok": "1" if report.ok else "0",
            "X-SW-Year": str(year),
            "X-SW-Message": quote(report.message),
        },
    )


@app.post("/api/jobs/{job}/open")
def open_folder(job: str) -> dict[str, bool]:
    folder = job_folder(job)
    if sys.platform == "win32":
        os.startfile(folder)  # noqa: S606 - a fixed folder under the app's output
        return {"opened": True}
    return {"opened": False}


@app.get("/api/jobs/{job}/files/{name}")
def download(job: str, name: str, inline: bool = False) -> FileResponse:
    folder = job_folder(job)
    path = (folder / name).resolve()
    if path.parent != folder.resolve() or not path.is_file():
        raise HTTPException(404, "ไม่พบไฟล์")
    return FileResponse(path, filename=None if inline else name)


@app.exception_handler(HTTPException)
async def errors(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")


def _open_browser(port: int) -> None:
    """Open the page once the server answers."""
    import socket
    import time
    import webbrowser

    for _ in range(120):
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                webbrowser.open(f"http://127.0.0.1:{port}/")
                return
        time.sleep(0.5)


def run() -> None:
    import threading

    import uvicorn

    port = int(os.environ.get("AUTODESIGN_PORT", "8765"))
    if os.environ.get("AUTODESIGN_NO_BROWSER") != "1":
        threading.Thread(target=_open_browser, args=(port,), daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    run()
