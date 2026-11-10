"""Asks Claude for a CAD plan, builds it, and feeds any failure back for correction."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Callable, Optional

import anthropic
from pydantic import ValidationError

from . import cad_engine as E
from . import plan as P

DEFAULT_MODEL = "claude-opus-5-5"
MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]
MAX_ATTEMPTS = 4
MAX_TOKENS = 32000
TOOL_NAME = "submit_cad_plan"

SYSTEM = """You are a senior mechanical design engineer. You turn a request or an engineering \
drawing into a feature plan for one solid part, and you always deliver it by calling the \
submit_cad_plan tool. Never answer with the plan as text.

COORDINATES (SOLIDWORKS convention, Y is up, millimetres)
- Front plane: sketch x=+X, sketch y=+Y, normal +Z
- Top plane: sketch x=+X, sketch y=-Z, normal +Y
- Right plane: sketch x=-Z, sketch y=+Y, normal +X
A sketch sits on its plane, moved `offset` mm along the plane normal. direction "normal" goes \
along the normal, "reverse" goes against it, "both" is symmetric about the plane.
To cut down from a top surface at height H: plane Top, offset H, direction reverse.

MODELLING RULES
- Build the way an experienced engineer would: main body first, then cuts, then holes, then \
fillets and chamfers last.
- Everything must join into one solid. Each feature must add or remove real material.
- Use extrude, revolve, cut, hole, fillet, chamfer. Use revolve for round parts, with the axis \
in the sketch and the profile on one side of it.
- Use hole for round holes, including bolt_circle and grid. Use a slot entity for slots.
- A sketch may hold several entities. A closed loop inside another becomes an opening.
- Fillet and chamfer edges are chosen with the selector: parallel_to, on, kind, near. Use near \
with global XYZ points when a single edge is meant.

PARAMETERS
- Put every driving dimension in `parameters` with a short Thai `label`, then reference it in \
features as a string such as "=L/2". The user edits these values to change the model.
- For drawings, set `source` (which view or note) and `confidence`: high when clearly printed, \
medium when derived from other dimensions, low when estimated.

HONESTY ABOUT DRAWINGS
- Read every view, section, dimension, note, tolerance, scale and unit before planning. Use the \
printed dimensions, never scaled measurements from the picture, unless no dimension exists.
- When a dimension is missing or unreadable, choose a sensible value, mark it confidence "low", \
and add it to `questions` in Thai. Never hide a guess.
- List every assumption in `assumptions` in Thai. Threads are modelled as their tap drill or \
nominal hole; note that as an assumption.
- If the part needs something these features cannot make (loft, sweep, sheet metal, draft on \
faces, assemblies), model the closest honest version and state what is missing in `assumptions`.

MODIFYING A PLAN
When a current plan is supplied, keep what was not asked to change: same ids, names and \
parameters, and change only what the request needs.

`name` must be short, in English letters, digits and underscores. Use `density_g_cm3` for the \
stated material (steel 7.85, aluminium 2.7, brass 8.5, POM 1.41, ABS 1.05).

EXAMPLE of a valid plan:
""" + json.dumps(
    {
        "name": "Base_Plate",
        "density_g_cm3": 7.85,
        "parameters": [
            {"name": "L", "value": 120, "label": "ความยาว", "source": "คำสั่ง", "confidence": "high"},
            {"name": "T", "value": 10, "label": "ความหนา", "source": "คำสั่ง", "confidence": "high"},
        ],
        "features": [
            {"id": "F1", "type": "extrude", "name": "Plate", "plane": "Top",
             "sketch": [{"type": "rect", "w": "=L", "h": 80}], "depth": "=T"},
            {"id": "F2", "type": "hole", "name": "Mount holes", "plane": "Top", "offset": "=T",
             "direction": "reverse", "grid": {"nx": 2, "ny": 2, "dx": "=L-20", "dy": 60},
             "diameter": 9, "through": True},
            {"id": "F3", "type": "fillet", "name": "Corners", "radius": 5,
             "edges": {"parallel_to": "Y"}},
        ],
        "assumptions": ["ใช้เหล็กกล้า เพราะคำสั่งไม่ได้ระบุวัสดุ"],
        "questions": [],
    },
    ensure_ascii=False,
)


class PlannerError(Exception):
    pass


@dataclass
class PlanResult:
    raw_plan: dict[str, Any]
    plan: P.Plan
    build: E.BuildResult
    attempts: int
    model: str
    input_tokens: int
    output_tokens: int


def tool_definition() -> dict[str, Any]:
    return {
        "name": TOOL_NAME,
        "description": (
            "Submit the complete feature plan for one solid part. It is validated and built with a "
            "real CAD kernel. If it fails, the error comes back and you must submit a corrected plan."
        ),
        "input_schema": P.llm_schema(),
    }


def try_build(raw: dict[str, Any]) -> tuple[Optional[tuple[P.Plan, E.BuildResult]], str]:
    """Return (plan, result) or a message that tells Claude exactly what to fix."""
    try:
        plan = P.parse_plan(raw)
    except ValidationError as e:
        items = [f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:12]]
        return None, "The plan does not match the schema:\n" + "\n".join(items)
    except (ValueError, KeyError, TypeError) as e:
        return None, f"The plan could not be read: {e}"
    try:
        return (plan, E.build(plan)), ""
    except E.BuildError as e:
        return None, f"Geometry failed at feature {e.feature_id}: {e.message}"


def _user_content(
    prompt: str, attachments: list[dict[str, Any]], current_plan: Optional[dict[str, Any]]
) -> list[dict[str, Any]]:
    content = list(attachments)
    text = prompt.strip() or "Model the part shown in the attached drawing."
    if current_plan:
        text = (
            "Current plan:\n" + json.dumps(current_plan, ensure_ascii=False) + "\n\nRequested change:\n" + text
        )
    content.append({"type": "text", "text": text})
    return content


def make_plan(
    prompt: str,
    attachments: list[dict[str, Any]],
    current_plan: Optional[dict[str, Any]] = None,
    model: Optional[str] = None,
    client: Optional[anthropic.Anthropic] = None,
    on_status: Callable[[str], None] = lambda _: None,
) -> PlanResult:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if client is None:
        if not key:
            raise PlannerError("ยังไม่ได้ใส่ Claude API key ไปที่ปุ่มตั้งค่าก่อน")
        client = anthropic.Anthropic(api_key=key, timeout=600.0)
    model = model or os.environ.get("AUTODESIGN_MODEL") or DEFAULT_MODEL

    messages: list[dict[str, Any]] = [
        {"role": "user", "content": _user_content(prompt, attachments, current_plan)}
    ]
    tools = [tool_definition()]
    tokens_in = tokens_out = 0
    last_error = "Claude did not return a plan"

    for attempt in range(1, MAX_ATTEMPTS + 1):
        on_status(f"ออกแบบรอบที่ {attempt}")
        try:
            with client.messages.stream(
                model=model, max_tokens=MAX_TOKENS, system=SYSTEM, tools=tools, messages=messages
            ) as stream:
                response = stream.get_final_message()
        except anthropic.AuthenticationError as e:
            raise PlannerError("Claude API key ไม่ถูกต้อง") from e
        except anthropic.APIError as e:
            raise PlannerError(f"เรียก Claude ไม่สำเร็จ: {e}") from e

        tokens_in += response.usage.input_tokens
        tokens_out += response.usage.output_tokens
        if response.stop_reason == "refusal":
            raise PlannerError("Claude ปฏิเสธคำขอนี้")

        call = next(
            (b for b in response.content if b.type == "tool_use" and b.name == TOOL_NAME), None
        )
        messages.append({"role": "assistant", "content": response.content})
        if call is None:
            text = " ".join(b.text for b in response.content if b.type == "text").strip()
            last_error = text or last_error
            messages.append({"role": "user", "content": f"Deliver the plan by calling {TOOL_NAME}."})
            continue

        raw = call.input
        built, error = try_build(raw)
        if built:
            plan, result = built
            return PlanResult(raw, plan, result, attempt, model, tokens_in, tokens_out)
        last_error = error
        messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": call.id, "is_error": True, "content": error}
                ],
            }
        )

    raise PlannerError(f"ลอง {MAX_ATTEMPTS} รอบแล้วยังสร้างโมเดลไม่ได้: {last_error}")
