// Asks Claude for a plan straight from the browser with the user's own API key,
// builds it, and sends any failure back so Claude can correct it (same loop as app/ai_planner.py).
import { parsePlan, PlanError } from "./plan.js?v=202611121912";
import { build, BuildError } from "./cad.js?v=202611121912";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];
const TOOL = "submit_cad_plan";
const MAX_ATTEMPTS = 4;
const MAX_IMAGE_EDGE = 2800;
const MAX_PDF_BYTES = 30_000_000;

export class AiError extends Error {}

export function tryBuild(raw) {
  try {
    const plan = parsePlan(raw);
    return { plan, result: build(plan) };
  } catch (e) {
    if (e instanceof PlanError) return { error: e.message };
    if (e instanceof BuildError) return { error: `Geometry failed at feature ${e.featureId}: ${e.detail}` };
    return { error: `The plan could not be built: ${e.message}` };
  }
}

// ---------- attachments ----------
const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function imageBlock(file) {
  const bmp = await createImageBitmap(file).catch(() => { throw new AiError(`Could not open the image ${file.name}`); });
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let type = "image/png";
  let data = canvas.toDataURL(type).split(",")[1];
  if (data.length > 6_000_000) { type = "image/jpeg"; data = canvas.toDataURL(type, 0.88).split(",")[1]; }
  return [{ type: "image", source: { type: "base64", media_type: type, data } }];
}

function dxfSummary(text, DxfParser) {
  let doc;
  try { doc = new DxfParser().parseSync(text); } catch (e) { throw new AiError(`Could not read the DXF: ${e.message}`); }
  const f = (p) => `(${+p.x.toPrecision(4)},${+p.y.toPrecision(4)})`;
  const lines = [`DXF units code: ${doc.header?.$INSUNITS ?? 0} (4 = mm, 1 = inch, 0 = unspecified)`];
  const dims = [], notes = [], geom = [];
  for (const e of doc.entities || []) {
    if (e.type === "DIMENSION") dims.push(`DIM layer=${e.layer} measured=${e.actualMeasurement ?? ""} text='${e.text ?? ""}'`);
    else if (e.type === "TEXT" || e.type === "MTEXT") notes.push(String(e.text).trim());
    else if (e.type === "LINE") geom.push(`LINE ${f(e.vertices[0])}-${f(e.vertices[1])} [${e.layer}]`);
    else if (e.type === "CIRCLE") geom.push(`CIRCLE c${f(e.center)} r=${+e.radius.toPrecision(4)} [${e.layer}]`);
    else if (e.type === "ARC") geom.push(`ARC c${f(e.center)} r=${+e.radius.toPrecision(4)} ${+(e.startAngle * 180 / Math.PI).toFixed(2)}..${+(e.endAngle * 180 / Math.PI).toFixed(2)} [${e.layer}]`);
    else if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") geom.push(`POLYLINE closed=${!!e.shape} ${e.vertices.map(f).join(" ")} [${e.layer}]`);
  }
  if (dims.length) lines.push("", "Dimensions:", ...dims);
  if (notes.length) lines.push("", "Text notes:", ...notes);
  if (geom.length) lines.push("", "Geometry:", ...geom.slice(0, 1500));
  return lines.join("\n");
}

export async function toBlocks(file, DxfParser) {
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "pdf") {
    if (file.size > MAX_PDF_BYTES) throw new AiError(`${file.name} is larger than 30 MB`);
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(await file.arrayBuffer()) }, title: file.name }];
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return imageBlock(file);
  if (ext === "dxf") return [{ type: "text", text: `Exact data extracted from ${file.name}:\n${dxfSummary(await file.text(), DxfParser)}` }];
  if (ext === "dwg") throw new AiError("DWG is not supported yet. Save it as DXF or PDF first");
  throw new AiError(`${file.name} is not supported. Use PDF, PNG, JPG or DXF`);
}

// ---------- the request loop ----------
async function call(key, body) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiError("Could not reach Claude. Check the connection and try again");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AiError("The Claude API key is not valid");
  if (res.status === 429) throw new AiError("Too many requests or no credit left. Wait a moment and try again");
  if (!res.ok) throw new AiError(`Claude returned an error: ${data.error?.message || res.status}`);
  return data;
}

export async function makePlan({ key, model, system, schema, prompt, blocks, currentPlan, onStatus = () => {} }) {
  if (!key) throw new AiError("No Claude API key yet. Add one in Settings");
  let text = prompt.trim() || "Model the part shown in the attached drawing.";
  if (currentPlan) text = `Current plan:\n${JSON.stringify(currentPlan)}\n\nRequested change:\n${text}`;
  const messages = [{ role: "user", content: [...blocks, { type: "text", text }] }];
  const tools = [{
    name: TOOL,
    description: "Submit the complete feature plan for one solid part. It is validated and built with a real CAD kernel. If it fails, the error comes back and you must submit a corrected plan.",
    input_schema: schema,
  }];
  let lastError = "Claude did not return a plan";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onStatus(`Designing, attempt ${attempt}`);
    const response = await call(key, { model, max_tokens: 16000, system, tools, messages });
    if (response.stop_reason === "refusal") throw new AiError("Claude declined this request");
    messages.push({ role: "assistant", content: response.content });
    const use = response.content.find((b) => b.type === "tool_use" && b.name === TOOL);
    if (!use) {
      lastError = response.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim() || lastError;
      messages.push({ role: "user", content: `Deliver the plan by calling ${TOOL}.` });
      continue;
    }
    onStatus(`Checking the plan, attempt ${attempt}`);
    const built = tryBuild(use.input);
    if (!built.error) return { raw: use.input, ...built, attempts: attempt };
    lastError = built.error;
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, is_error: true, content: built.error }] });
  }
  throw new AiError(`Still could not build after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
