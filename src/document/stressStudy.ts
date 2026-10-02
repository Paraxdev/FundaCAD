// The Stress panel's setup as a document field. A study is display state like
// the body visibility: the rebuild never reads it, and a file is never refused
// over it. What comes off disk is checked here once, so the panel can trust it;
// anything it cannot read as a study is dropped whole, quietly, and the file
// opens as if it had none.
//
// Numbers are the forgiving part. A cleared input in the panel reads as "", and
// a hand-edited file may carry a string where a number belongs, so a number
// that is not finite falls back to the panel's default for that field rather
// than costing the user the whole setup. The structure is not forgiven: a load
// that is not an object, or a support of a kind nobody knows, means the value
// is something other than a study.

import type { AxisDirection, Selector, StressStudy, StressSupportType } from "../types";

export const AXIS_DIRECTIONS: readonly AxisDirection[] = ["-Z", "+Z", "+X", "-X", "+Y", "-Y"];
export const SUPPORT_TYPES: readonly StressSupportType[] = ["fixed", "pinned", "slider"];
const LOAD_DIRECTIONS = new Set<string>(["into", "custom", ...AXIS_DIRECTIONS]);

/** The defaults a fresh panel starts from, and what a damaged number falls back to. */
export const STUDY_DEFAULTS = {
  force: 100,
  pressure: 0.1,
  custom: [0, 0, -1] as [number, number, number],
  material: "PLA",
  E: 2000,
  nu: 0.35,
  yield: 40,
  density: 1.2,
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Three finite numbers, a point or a direction. */
export function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** One face selector in a shape the engine and the panel can both read, by the
 *  face forms of the Selector union. The panel reads a selector's point to find
 *  the face in the view, so a point that is not three numbers is as damaged as
 *  a missing one. */
function isFaceSelector(s: unknown): boolean {
  if (!isRecord(s) || s["kind"] !== "face") return false;
  if (s["body"] !== undefined && typeof s["body"] !== "string") return false;
  switch (s["by"]) {
    case "nearest":
      return isVec3(s["point"]);
    case "normal":
      return isVec3(s["dir"]);
    case "tracked":
      return isVec3(s["point"]) && isVec3(s["normal"]) && (s["center"] === undefined || isVec3(s["center"]));
    case "match": {
      const fp = s["fp"];
      const nth = s["nth"];
      if (nth !== undefined && !(typeof nth === "number" && Number.isInteger(nth))) return false;
      // The engine scores whichever fingerprint fields are there; the panel
      // needs the centroid to look for the face in the view.
      return isRecord(fp) && isVec3(fp["centroid"]) &&
        (fp["normal"] === undefined || isVec3(fp["normal"])) &&
        (fp["area"] === undefined || (typeof fp["area"] === "number" && Number.isFinite(fp["area"]))) &&
        (fp["surface"] === undefined || typeof fp["surface"] === "string");
    }
    default:
      return false;
  }
}

/** Face selectors as the engine reads them. Anything else in the list makes the
 *  list unreadable, since a face silently missing would change the answer. */
function faces(v: unknown): Selector[] | null {
  if (!Array.isArray(v) || !v.every(isFaceSelector)) return null;
  return structuredClone(v) as Selector[];
}

function id(v: unknown, i: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : i + 1;
}

/** Ids must be unique within a list for the panel to address its rows; a file
 *  with repeats is renumbered from 1 rather than refused. */
function uniqueIds<T extends { id: number }>(rows: T[]): T[] {
  const seen = new Set(rows.map((r) => r.id));
  if (seen.size === rows.length) return rows;
  return rows.map((r, i) => ({ ...r, id: i + 1 }));
}

/** A study from a parsed document's `stress`, or null for anything that is not one. */
export function normalizeStressStudy(raw: unknown): StressStudy | null {
  if (!isRecord(raw)) return null;
  const body = raw["body"] ?? null;
  if (body !== null && typeof body !== "string") return null;
  if (!Array.isArray(raw["supports"]) || !Array.isArray(raw["loads"])) return null;

  const supports: StressStudy["supports"] = [];
  for (const [i, s] of (raw["supports"] as unknown[]).entries()) {
    if (!isRecord(s)) return null;
    // A support without a type is a fixed one, as the engine reads it.
    const type = s["type"] ?? "fixed";
    if (!SUPPORT_TYPES.includes(type as StressSupportType)) return null;
    const f = faces(s["faces"]);
    if (!f) return null;
    supports.push({ id: id(s["id"], i), type: type as StressSupportType, faces: f });
  }

  const loads: StressStudy["loads"] = [];
  for (const [i, l] of (raw["loads"] as unknown[]).entries()) {
    if (!isRecord(l)) return null;
    const kind = l["kind"] ?? "force";
    if (kind !== "force" && kind !== "pressure") return null;
    const direction = l["direction"] ?? "into";
    if (typeof direction !== "string" || !LOAD_DIRECTIONS.has(direction)) return null;
    const f = faces(l["faces"]);
    if (!f) return null;
    const c = Array.isArray(l["custom"]) ? (l["custom"] as unknown[]) : [];
    const d = STUDY_DEFAULTS.custom;
    loads.push({
      id: id(l["id"], i),
      kind,
      faces: f,
      force: num(l["force"], STUDY_DEFAULTS.force),
      direction: direction as StressStudy["loads"][number]["direction"],
      custom: [num(c[0], d[0]), num(c[1], d[1]), num(c[2], d[2])],
      pressure: num(l["pressure"], STUDY_DEFAULTS.pressure),
    });
  }

  const g = raw["gravity"] ?? { on: false, direction: "-Z" };
  if (!isRecord(g)) return null;
  const gDir = g["direction"] ?? "-Z";
  if (!AXIS_DIRECTIONS.includes(gDir as AxisDirection)) return null;
  const material = raw["material"] ?? STUDY_DEFAULTS.material;
  if (typeof material !== "string" || !material) return null;
  const custom = isRecord(raw["custom"]) ? raw["custom"] : {};
  const size = raw["size"];

  return {
    body,
    supports: uniqueIds(supports),
    loads: uniqueIds(loads),
    gravity: { on: g["on"] === true, direction: gDir as AxisDirection },
    material,
    custom: {
      E: num(custom["E"], STUDY_DEFAULTS.E),
      nu: num(custom["nu"], STUDY_DEFAULTS.nu),
      yield: num(custom["yield"], STUDY_DEFAULTS.yield),
      density: num(custom["density"], STUDY_DEFAULTS.density),
    },
    size: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
  };
}
