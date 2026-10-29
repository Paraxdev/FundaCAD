// The Stress panel's setup, display state the rebuild never reads. Unreadable structure drops the whole study quietly;
// a non-finite number (a cleared input reads as "") falls back to that field's default.

import type { AxisDirection, Selector, StressSpot, StressStudy, StressSupportType } from "../types";

export const AXIS_DIRECTIONS: readonly AxisDirection[] = ["-Z", "+Z", "+X", "-X", "+Y", "-Y"];
export const SUPPORT_TYPES: readonly StressSupportType[] = ["fixed", "pinned", "slider"];
const LOAD_DIRECTIONS = new Set<string>(["into", "custom", ...AXIS_DIRECTIONS]);

export const STUDY_DEFAULTS = {
  force: 100,
  pressure: 0.1,
  custom: [0, 0, -1] as [number, number, number],
  material: "PLA",
  E: 2000,
  nu: 0.35,
  yield: 40,
  density: 1.2,
  // mm, a spot's radius when the file's is not a size.
  radius: 5,
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

// The panel finds the face by its selector's point, so a point that is not three numbers is as damaged as none.
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
      // The engine scores whichever fingerprint fields exist; the panel needs the centroid to find the face.
      return (
        isRecord(fp) &&
        isVec3(fp["centroid"]) &&
        (fp["normal"] === undefined || isVec3(fp["normal"])) &&
        (fp["area"] === undefined || (typeof fp["area"] === "number" && Number.isFinite(fp["area"]))) &&
        (fp["surface"] === undefined || typeof fp["surface"] === "string")
      );
    }
    default:
      return false;
  }
}

// Anything else makes the list unreadable, since a silently missing face would change the answer.
function faces(v: unknown): Selector[] | null {
  if (!Array.isArray(v) || !v.every(isFaceSelector)) return null;
  return structuredClone(v) as Selector[];
}

// A spot with no point is unreadable, as a missing place would change the answer; a bad radius falls back.
function spots(v: unknown): StressSpot[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: StressSpot[] = [];
  for (const s of v) {
    if (!isRecord(s) || !isVec3(s["at"])) return null;
    const r = num(s["radius"], STUDY_DEFAULTS.radius);
    const n = s["normal"];
    out.push({
      at: [...s["at"]],
      radius: r > 0 ? r : STUDY_DEFAULTS.radius,
      ...(isVec3(n) ? { normal: [...n] as [number, number, number] } : {}),
    });
  }
  return out;
}

function id(v: unknown, i: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : i + 1;
}

// The panel addresses rows by id, so a file with repeats is renumbered from 1 rather than refused.
function uniqueIds<T extends { id: number }>(rows: T[]): T[] {
  const seen = new Set(rows.map((r) => r.id));
  if (seen.size === rows.length) return rows;
  return rows.map((r, i) => ({ ...r, id: i + 1 }));
}

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
    const at = spots(s["spots"]);
    if (!f || !at) return null;
    supports.push({
      id: id(s["id"], i),
      type: type as StressSupportType,
      faces: f,
      ...(at.length ? { spots: at } : {}),
    });
  }

  const loads: StressStudy["loads"] = [];
  for (const [i, l] of (raw["loads"] as unknown[]).entries()) {
    if (!isRecord(l)) return null;
    const kind = l["kind"] ?? "force";
    if (kind !== "force" && kind !== "pressure") return null;
    const direction = l["direction"] ?? "into";
    if (typeof direction !== "string" || !LOAD_DIRECTIONS.has(direction)) return null;
    const f = faces(l["faces"]);
    const at = spots(l["spots"]);
    if (!f || !at) return null;
    const c = Array.isArray(l["custom"]) ? (l["custom"] as unknown[]) : [];
    const d = STUDY_DEFAULTS.custom;
    loads.push({
      id: id(l["id"], i),
      kind,
      faces: f,
      ...(at.length ? { spots: at } : {}),
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
  const refine = raw["refine"];

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
    ...(refine === "fine" || refine === "off" ? { refine } : {}),
  };
}
