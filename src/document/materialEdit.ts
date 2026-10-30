// The `materials` live edit an assistant's material tool sends beside its document, read the way a file is read:
// a row that is not ours is skipped. The MCP writes it in crates/fundacad-mcp/src/materials_doc.rs live_edit.
import { type FacePrint, isPrint } from "./faceRefs";
import { type MaterialDef, normalizeMaterial } from "./materials";

export interface MaterialEdit {
  /** The whole library after the edit, absent when it did not change. */
  library?: MaterialDef[];
  bodies: { body: string; material: string | null }[];
  faces: { body: string; face: number; material: string | null; at?: FacePrint }[];
}

const isMaterialRef = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Null for anything but a materials edit, so the caller takes the document instead. */
export function readMaterialEdit(raw: unknown): MaterialEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e["kind"] !== "materials") return null;
  const out: MaterialEdit = { bodies: [], faces: [] };
  if (Array.isArray(e["library"])) {
    const rows = e["library"].map((m, i) => normalizeMaterial(m, i)).filter((m): m is MaterialDef => m !== null);
    if (rows.length) out.library = rows;
  }
  if (e["bodies"] && typeof e["bodies"] === "object") {
    for (const [body, material] of Object.entries(e["bodies"])) {
      if (isMaterialRef(material)) out.bodies.push({ body, material });
    }
  }
  for (const row of Array.isArray(e["faces"]) ? (e["faces"] as Record<string, unknown>[]) : []) {
    const { body, face, material, print } = row ?? {};
    if (typeof body !== "string" || !Number.isSafeInteger(face) || (face as number) < 0) continue;
    if (!isMaterialRef(material)) continue;
    const at = isPrint(print) ? { at: print } : {};
    out.faces.push({ body, face: face as number, material, ...at });
  }
  return out;
}
