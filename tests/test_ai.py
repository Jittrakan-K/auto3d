import base64, io, json, types
from pathlib import Path
import ezdxf, pytest
from PIL import Image
from app import ai_planner as A, drawing_input as D, plan as P

EX = Path(__file__).parent.parent / "examples"
GOOD = json.loads((EX / "bracket.json").read_text(encoding="utf-8"))

def block(**kw): return types.SimpleNamespace(**kw)
def reply(*content, stop="tool_use"):
    return types.SimpleNamespace(content=list(content), stop_reason=stop,
                                 usage=types.SimpleNamespace(input_tokens=10, output_tokens=5))
def call(data, id="t1"): return block(type="tool_use", name=A.TOOL_NAME, id=id, input=data)

class Stream:
    def __init__(self, r): self.r = r
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get_final_message(self): return self.r

class Client:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []
        self.messages = self
    def stream(self, **kw):
        self.calls.append(json.loads(json.dumps(kw, default=lambda o: "obj")))
        assert "tool_choice" not in kw  # forced tools return 400 on these models
        return Stream(self.replies.pop(0))

def test_first_try():
    r = A.make_plan("bracket", [], client=Client([reply(call(GOOD))]))
    assert r.attempts == 1 and r.build.solids == 1

def test_repairs_after_geometry_error():
    bad = json.loads(json.dumps(GOOD))
    bad["features"][2]["offset"] = 500
    bad["features"][2]["direction"] = "normal"
    c = Client([reply(call(bad, "a")), reply(call(GOOD, "b"))])
    r = A.make_plan("bracket", [], client=c)
    assert r.attempts == 2
    last = c.calls[1]["messages"][-1]["content"][0]
    assert last["type"] == "tool_result" and last["is_error"] and last["tool_use_id"] == "a"
    assert "F3" in last["content"]

def test_repairs_after_schema_error():
    c = Client([reply(call({"name": "x", "features": []})), reply(call(GOOD))])
    assert A.make_plan("x", [], client=c).attempts == 2

def test_text_reply_is_nudged_to_the_tool():
    c = Client([reply(block(type="text", text="ok"), stop="end_turn"), reply(call(GOOD))])
    assert A.make_plan("x", [], client=c).attempts == 2

def test_gives_up_with_reason():
    with pytest.raises(A.PlannerError, match="4 รอบ"):
        A.make_plan("x", [], client=Client([reply(call({"name": "x", "features": []})) for _ in range(4)]))

def test_refusal():
    with pytest.raises(A.PlannerError):
        A.make_plan("x", [], client=Client([reply(block(type="text", text="no"), stop="refusal")]))

def test_current_plan_is_sent():
    c = Client([reply(call(GOOD))])
    A.make_plan("เพิ่มรู", [], current_plan=GOOD, client=c)
    assert "Mounting_Bracket" in c.calls[0]["messages"][0]["content"][-1]["text"]

def test_schema_clean():
    s = json.dumps(P.llm_schema())
    assert "discriminator" not in s and '"pattern": "^="' in s
    json.loads(s)

def test_example_in_system_prompt_is_valid():
    start = A.SYSTEM.index('{"name": "Base_Plate"')
    built, err = A.try_build(json.loads(A.SYSTEM[start:]))
    assert built, err

def test_image_block_downsizes():
    buf = io.BytesIO(); Image.new("RGB", (5000, 3000), "white").save(buf, "PNG")
    b = D.to_blocks("a.png", buf.getvalue())[0]
    img = Image.open(io.BytesIO(base64.b64decode(b["source"]["data"])))
    assert max(img.size) <= D.MAX_IMAGE_EDGE

def test_pdf_block():
    b = D.to_blocks("a.pdf", b"%PDF-1.4")[0]
    assert b["type"] == "document" and b["source"]["media_type"] == "application/pdf"

def test_dxf_block_keeps_exact_numbers(tmp_path):
    doc = ezdxf.new(setup=True); msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0)); msp.add_circle((50, 25), 4.5)
    msp.add_linear_dim(base=(0, -10), p1=(0, 0), p2=(100, 0)).render()
    msp.add_text("MATERIAL SS400")
    p = tmp_path / "d.dxf"; doc.saveas(p)
    blocks = D.to_blocks("d.dxf", p.read_bytes())
    text = blocks[0]["text"]
    assert "r=4.5" in text and "SS400" in text and "measured=100" in text
    assert blocks[1]["type"] == "image"

def test_dwg_gets_clear_message():
    with pytest.raises(D.DrawingError, match="DXF"):
        D.to_blocks("a.dwg", b"x")
