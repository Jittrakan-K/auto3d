"""The online page may reach only the status check and the SLDPRT build of the local app."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import main, sw_backend

EX = Path(__file__).parent.parent / "examples"
WEB = "https://jittrakan-k.github.io"
client = TestClient(main.app, base_url="http://127.0.0.1:8765")


def test_web_page_can_check_status():
    r = client.get("/api/status", headers={"Origin": WEB})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == WEB


def test_preflight_allows_private_network():
    r = client.options("/api/web/sldprt", headers={
        "Origin": WEB, "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true"})
    assert r.status_code == 204
    assert r.headers["access-control-allow-private-network"] == "true"


def test_web_page_cannot_reach_other_endpoints():
    assert client.post("/api/settings", json={"api_key": "x"}, headers={"Origin": WEB}).status_code == 403
    assert client.get("/api/examples", headers={"Origin": WEB}).status_code == 403


def test_other_sites_are_blocked():
    assert client.get("/api/status", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/status", headers={"Origin": "https://jittrakan-k.github.io.evil.example"}).status_code == 403


def test_sldprt_comes_back_as_a_file(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "OUTPUT", tmp_path)

    def fake_build(steps, folder, stem, log=None):
        path = sw_backend.target_path(folder, stem, 2018)
        path.write_bytes(b"SLDPRT")
        return sw_backend.SwReport(True, str(path), "26.0.0", 1.0, [], "สร้างครบ")

    monkeypatch.setattr(sw_backend, "build_sldprt", fake_build)
    plan = json.loads((EX / "bracket.json").read_text(encoding="utf-8"))
    r = client.post("/api/web/sldprt", json={"plan": plan}, headers={"Origin": WEB})
    assert r.status_code == 200, r.text
    assert r.content == b"SLDPRT"
    assert r.headers["x-sw-year"] == "2018" and r.headers["x-sw-ok"] == "1"
    assert "_SW2018.SLDPRT" in r.headers["content-disposition"]
    assert "x-sw-year" in r.headers["access-control-expose-headers"]


def test_missing_solidworks_is_a_readable_error(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "OUTPUT", tmp_path)
    monkeypatch.setattr(sw_backend, "status", lambda: {"available": False, "reason": "ไม่พบ SOLIDWORKS ในเครื่องนี้"})
    plan = json.loads((EX / "bracket.json").read_text(encoding="utf-8"))
    r = client.post("/api/web/sldprt", json={"plan": plan}, headers={"Origin": WEB})
    assert r.status_code == 409 and "SOLIDWORKS" in r.json()["error"]
