"""Turns attached drawings into content blocks for Claude.

DXF is the most accurate input: its dimensions and coordinates are exact numbers, so
they are sent as text, together with a rendered picture so the views can be understood.
"""
from __future__ import annotations

import base64
import io
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image

MAX_IMAGE_EDGE = 2800
MAX_IMAGE_BYTES = 4_500_000
MAX_PDF_BYTES = 30_000_000
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
MAX_DXF_ENTITIES = 1500


class DrawingError(Exception):
    pass


def _image_block(data: bytes, media_type: str) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": base64.b64encode(data).decode()},
    }


def image_blocks(name: str, data: bytes) -> list[dict[str, Any]]:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:
        raise DrawingError(f"เปิดรูป {name} ไม่ได้: {e}") from e
    if img.mode not in ("RGB", "L"):
        background = Image.new("RGB", img.size, "white")
        rgba = img.convert("RGBA")
        background.paste(rgba, mask=rgba.split()[-1])
        img = background
    if max(img.size) > MAX_IMAGE_EDGE:
        img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.convert("RGB").save(out, "PNG", optimize=True)
    if out.tell() <= MAX_IMAGE_BYTES:
        return [_image_block(out.getvalue(), "image/png")]
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=88)
    return [_image_block(out.getvalue(), "image/jpeg")]


def pdf_blocks(name: str, data: bytes) -> list[dict[str, Any]]:
    if len(data) > MAX_PDF_BYTES:
        raise DrawingError(f"{name} ใหญ่เกิน 30 MB")
    return [
        {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(data).decode()},
            "title": name,
        }
    ]


def _fmt(p: Any) -> str:
    return f"({p[0]:.4g},{p[1]:.4g})"


def dxf_summary(doc: Any) -> str:
    msp = doc.modelspace()
    counts = Counter(e.dxftype() for e in msp)
    lines = [
        f"DXF units code: {doc.header.get('$INSUNITS', 0)} (4 = mm, 1 = inch, 0 = unspecified)",
        "Entity counts: " + ", ".join(f"{k}={v}" for k, v in counts.most_common()),
    ]
    dims, texts, geometry = [], [], []
    for e in msp:
        kind = e.dxftype()
        try:
            if kind == "DIMENSION":
                measured = e.dxf.get("actual_measurement", None)
                try:
                    measured = e.get_measurement()
                except Exception:  # noqa: BLE001 - not every dimension subtype supports it
                    pass
                dims.append(f"DIM layer={e.dxf.layer} measured={measured} text='{e.dxf.get('text', '')}'")
            elif kind in ("TEXT", "MTEXT"):
                raw = e.dxf.text if kind == "TEXT" else e.text
                texts.append(raw.strip())
            elif kind == "LINE":
                geometry.append(f"LINE {_fmt(e.dxf.start)}-{_fmt(e.dxf.end)} [{e.dxf.layer}]")
            elif kind == "CIRCLE":
                geometry.append(f"CIRCLE c{_fmt(e.dxf.center)} r={e.dxf.radius:.4g} [{e.dxf.layer}]")
            elif kind == "ARC":
                geometry.append(
                    f"ARC c{_fmt(e.dxf.center)} r={e.dxf.radius:.4g} "
                    f"{e.dxf.start_angle:.4g}..{e.dxf.end_angle:.4g} [{e.dxf.layer}]"
                )
            elif kind == "LWPOLYLINE":
                pts = " ".join(_fmt(p) for p in e.get_points("xy"))
                geometry.append(f"POLYLINE closed={e.closed} {pts} [{e.dxf.layer}]")
        except Exception:  # noqa: BLE001 - skip one unreadable entity, keep the rest
            continue
    if dims:
        lines += ["", "Dimensions:"] + dims
    if texts:
        lines += ["", "Text notes:"] + texts
    if geometry:
        lines += ["", "Geometry:"] + geometry[:MAX_DXF_ENTITIES]
        if len(geometry) > MAX_DXF_ENTITIES:
            lines.append(f"... {len(geometry) - MAX_DXF_ENTITIES} more entities omitted")
    return "\n".join(lines)


def _render_dxf(doc: Any) -> bytes:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend

    fig = plt.figure(figsize=(12, 9), dpi=170)
    ax = fig.add_axes([0, 0, 1, 1])
    Frontend(RenderContext(doc), MatplotlibBackend(ax)).draw_layout(doc.modelspace(), finalize=True)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor="white")
    plt.close(fig)
    return buf.getvalue()


def dxf_blocks(name: str, data: bytes) -> list[dict[str, Any]]:
    import ezdxf

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "input.dxf"
        path.write_bytes(data)
        try:
            doc = ezdxf.readfile(path)
        except Exception:
            try:
                from ezdxf import recover

                doc, _ = recover.readfile(path)
            except Exception as e:
                raise DrawingError(f"อ่าน DXF {name} ไม่ได้: {e}") from e
    blocks: list[dict[str, Any]] = [
        {"type": "text", "text": f"Exact data extracted from {name}:\n{dxf_summary(doc)}"}
    ]
    try:
        blocks += image_blocks(name, _render_dxf(doc))
    except Exception:  # noqa: BLE001 - the exact text data is still usable on its own
        pass
    return blocks


def to_blocks(name: str, data: bytes) -> list[dict[str, Any]]:
    ext = Path(name).suffix.lower()
    if ext == ".pdf":
        return pdf_blocks(name, data)
    if ext in IMAGE_TYPES:
        return image_blocks(name, data)
    if ext == ".dxf":
        return dxf_blocks(name, data)
    if ext == ".dwg":
        raise DrawingError("ยังอ่าน DWG ไม่ได้ กรุณา Save As เป็น DXF หรือ PDF ก่อน")
    raise DrawingError(f"ไม่รองรับไฟล์ {name} ใช้ PDF, PNG, JPG หรือ DXF")
