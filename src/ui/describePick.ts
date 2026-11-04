// One set of words for a picked face, edge or plane, shared by the list, the readout and the announcer. Any fact may be
// missing, its words are then left out.

import type { TopologyFace, Vec3 } from "../types";
import { displayValue, fmtArea, fmtLength, spokenArea, spokenLength } from "./units";

export type FacingWord = "up" | "down" | "front" | "back" | "left" | "right";

export interface FaceFacts {
  kind: "face";
  number: number;
  /** "curved" is the mesh's answer while the engine has not spoken. */
  surface: TopologyFace["surface"] | "curved";
  area?: number;
  size?: [number, number];
  normal?: Vec3;
  axis?: Vec3;
  radius?: number;
  full?: boolean;
  concave?: boolean;
  length?: number;
  centroid?: Vec3;
  body?: string;
  owner?: string | null;
  pieces?: number;
}
export interface EdgeFacts {
  kind: "edge";
  number: number;
  curve: "line" | "circle" | "arc" | "curve";
  length: number;
  radius?: number;
  /** Their numbers as the rows show them. */
  faces?: number[];
  body?: string;
  owner?: string | null;
}
export interface PlaneFacts {
  kind: "plane";
  name: string;
  origin: boolean;
  normal: Vec3;
}
export type PickFacts = FaceFacts | EdgeFacts | PlaneFacts;

export interface PickWords {
  label: string;
  hint: string;
  readout: string;
  spoken: string;
}

export const MATCH_COS = Math.cos((2 * Math.PI) / 180);
// Float noise must not decide a limit or a tie: the sine and cosine of 45 degrees can differ in the last bit.
const NOISE = 1e-9;

/** Null for a normal with no direction. A tie goes Z, then Y, then X. */
export function facingOf(n: Vec3): { word: FacingWord; tilt: number } | null {
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const [ax, ay, az] = [Math.abs(n[0]) / len, Math.abs(n[1]) / len, Math.abs(n[2]) / len];
  const onZ = az >= Math.max(ax, ay) - NOISE;
  const onY = !onZ && ay >= ax - NOISE;
  const word: FacingWord = onZ
    ? n[2] > 0
      ? "up"
      : "down"
    : onY
      ? n[1] > 0
        ? "back"
        : "front"
      : n[0] > 0
        ? "right"
        : "left";
  const main = onZ ? az : onY ? ay : ax;
  return { word, tilt: main >= MATCH_COS - NOISE ? 0 : Math.round((Math.acos(main) * 180) / Math.PI) };
}

// Where a fact is shown or said. A channel left out does not carry it.
type Fact = { hint?: string; readout?: string; spoken?: string };

const known = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v);
const shown = (screen: string, spoken: string): Required<Fact> => ({ hint: screen, readout: screen, spoken });

const facing = (n: Vec3 | undefined): Fact | null => {
  const f = n ? facingOf(n) : null;
  if (!f) return null;
  return f.tilt
    ? shown(`tilted ${f.tilt}° from ${f.word}`, `tilted ${f.tilt} degrees from ${f.word}`)
    : shown(`facing ${f.word}`, `facing ${f.word}`);
};

// An axis is a line, its sign means nothing.
const AXIS_LINE: Record<FacingWord, string> = {
  up: "up",
  down: "up",
  front: "front to back",
  back: "front to back",
  left: "left to right",
  right: "left to right",
};
const axisFact = (axis: Vec3 | undefined): Fact | null => {
  const f = axis ? facingOf(axis) : null;
  if (!f) return null;
  const line = AXIS_LINE[f.word];
  return { spoken: f.tilt ? `axis tilted ${f.tilt} degrees from ${line}` : `axis ${line}` };
};

const diameter = (radius: number, prefix = ""): Fact => ({
  hint: `${prefix}diameter ${fmtLength(radius * 2)}`,
  readout: `${prefix}⌀${fmtLength(radius * 2)}`,
  spoken: `${prefix}diameter ${spokenLength(radius * 2)}`,
});
const radiusFact = (radius: number): Fact => ({
  hint: `radius ${fmtLength(radius)}`,
  readout: `R${fmtLength(radius)}`,
  spoken: `radius ${spokenLength(radius)}`,
});
const longFact = (mm: number) => shown(`${fmtLength(mm)} long`, `${spokenLength(mm)} long`);
const areaFact = (mm2: number) => shown(fmtArea(mm2), spokenArea(mm2));

const sizeFact = (size: [number, number] | undefined): Fact | null => {
  if (!size || !known(size[0]) || !known(size[1])) return null;
  const first = displayValue(size[0]);
  return shown(`${first} by ${fmtLength(size[1])}`, `${first} by ${spokenLength(size[1])}`);
};

// A body named as its feature, "Box" from Box, is said once.
const ownerFact = (owner: string | null | undefined, body: string | undefined): Fact | null =>
  owner ? { hint: owner, ...(owner === body ? {} : { spoken: `from ${owner}` }) } : null;
const bodyFact = (body: string | undefined): Fact | null => (body ? { spoken: body } : null);

// A flat face as wide as long whose area is the circle's inside that square: a rounded square or a ring falls short.
function isDisc({ size, area }: FaceFacts): boolean {
  if (!size || !known(size[0]) || !known(size[1]) || !known(area) || size[0] <= 0) return false;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(a, b);
  return near(size[0], size[1]) && near(area, (Math.PI / 4) * size[0] * size[1]);
}

function faceName(f: FaceFacts): { name: string; type: string | null } {
  switch (f.surface) {
    case "plane":
      return { name: "Flat face", type: "flat" };
    case "cylinder":
      if (f.full === false) return { name: "Round face", type: "round" };
      return f.full && f.concave ? { name: "Hole", type: "hole" } : { name: "Cylinder", type: "cylinder" };
    case "cone":
      return { name: "Cone", type: "cone" };
    case "sphere":
      return { name: "Sphere", type: "sphere" };
    case "torus":
      return { name: "Torus", type: "torus" };
    case "bspline":
    case "curved":
      return { name: "Curved face", type: "curved" };
    default:
      return { name: "Face", type: null };
  }
}

function faceFacts(f: FaceFacts, type: string | null): (Fact | null)[] {
  const isFlat = f.surface === "plane";
  const main: (Fact | null)[] = [];
  if (isFlat) main.push(isDisc(f) ? diameter(f.size![0] / 2) : sizeFact(f.size));
  if (known(f.radius)) {
    if (f.surface === "torus") main.push(diameter(f.radius, "tube "));
    else main.push(f.surface === "sphere" || f.full ? diameter(f.radius) : radiusFact(f.radius));
  }
  if (known(f.length)) main.push(type === "round" ? { spoken: longFact(f.length).spoken } : longFact(f.length));
  const hasMain = main.some(Boolean);

  const area = known(f.area) ? areaFact(f.area) : null;
  const dir = isFlat && f.normal ? facingOf(f.normal) : null;
  const level = dir?.tilt === 0 && (dir.word === "up" || dir.word === "down");
  return [
    ...main,
    hasMain ? (isFlat && area ? { spoken: area.spoken } : null) : area,
    isFlat ? facing(f.normal) : null,
    level && known(f.centroid?.[2]) ? { spoken: `at height ${spokenLength(f.centroid![2])}` } : null,
    f.surface === "cylinder" || f.surface === "cone" ? axisFact(f.axis) : null,
    known(f.pieces) && f.pieces > 1 ? { hint: `in ${f.pieces} pieces`, spoken: `in ${f.pieces} pieces` } : null,
    bodyFact(f.body),
    ownerFact(f.owner, f.body),
  ];
}

const EDGE_NAME: Record<EdgeFacts["curve"], { name: string; type: string }> = {
  line: { name: "Straight edge", type: "straight" },
  circle: { name: "Round edge", type: "round" },
  arc: { name: "Round edge", type: "round" },
  curve: { name: "Curved edge", type: "curved" },
};

const listed = (parts: string[]): string => `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

function edgeFaces(faces: number[] | undefined): Fact | null {
  if (!faces?.length) return null;
  if (faces.length === 1) return { hint: `face ${faces[0]}`, spoken: `on face ${faces[0]}` };
  return {
    hint: `faces ${listed(faces.map(String))}`,
    spoken: `between ${listed(faces.map((n) => `face ${n}`))}`,
  };
}

function edgeFacts(e: EdgeFacts): (Fact | null)[] {
  return [
    known(e.length) ? shown(fmtLength(e.length), spokenLength(e.length)) : null,
    known(e.radius) ? (e.curve === "circle" ? diameter(e.radius) : radiusFact(e.radius)) : null,
    edgeFaces(e.faces),
    bodyFact(e.body),
    ownerFact(e.owner, e.body),
  ];
}

const channel = (facts: (Fact | null)[], key: keyof Fact): string[] =>
  facts.flatMap((f) => (f?.[key] ? [f[key]!] : []));

export function describePick(f: PickFacts): PickWords {
  if (f.kind === "plane") {
    const label = f.origin ? `${f.name} plane` : f.name;
    const where = f.origin ? "origin" : "datum plane";
    const look = facing(f.normal);
    return {
      label,
      hint: where,
      readout: [label, where, ...channel([look], "readout")].join(" · "),
      spoken: `${[label, where, ...channel([look], "spoken")].join(", ")}. Enter starts a sketch`,
    };
  }
  const { name, type } = f.kind === "face" ? faceName(f) : EDGE_NAME[f.curve];
  const facts = f.kind === "face" ? faceFacts(f, type) : edgeFacts(f);
  const label = `${name} ${f.number}`;
  return {
    label,
    hint: channel(facts, "hint").join(", "),
    readout: [`1 ${f.kind}`, ...(type ? [type] : []), ...channel(facts, "readout")].join(" · "),
    spoken: [label, ...channel(facts, "spoken")].join(", "),
  };
}

const COUNT_NOUN: Record<string, [one: string, many: string]> = {
  f: ["face", "faces"],
  e: ["edge", "edges"],
  p: ["plane", "planes"],
  b: ["body", "bodies"],
  r: ["profile", "profiles"],
  other: ["item", "items"],
};

/** What to say for a selection change, by row keys (`f:`, `e:`, `p:`, `b:`, `r:`). Null when nothing changed. One
 *  added or removed on a body none of the rest is on says that body, by `bodyOf`. */
export function describeChange(
  prev: readonly string[],
  next: readonly string[],
  words: (key: string) => Pick<PickWords, "label" | "spoken">,
  bodyOf: (key: string) => string | null = () => null,
): string | null {
  const before = new Set(prev);
  const after = new Set(next);
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  if (!added.length && !removed.length) return null;
  if (!after.size) return "Nothing selected";
  const named = (key: string, rest: Set<string>) => {
    const body = bodyOf(key);
    const apart = body !== null && ![...rest].some((k) => bodyOf(k) === body);
    return apart ? `${words(key).label} of ${body}` : words(key).label;
  };
  if (added.length === 1 && !removed.length && before.size)
    return `${named(added[0]!, before)} added, ${after.size} selected`;
  if (removed.length === 1 && !added.length) return `${named(removed[0]!, after)} removed, ${after.size} selected`;
  if (after.size === 1) return words([...after][0]!).spoken;

  const counts = new Map<string, number>();
  for (const k of after) {
    const prefix = k.split(":", 1)[0]!;
    const kind = prefix in COUNT_NOUN ? prefix : "other";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = Object.keys(COUNT_NOUN)
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const n = counts.get(kind)!;
      return `${n} ${COUNT_NOUN[kind]![n === 1 ? 0 : 1]}`;
    });
  return `${parts.join(", ")} selected`;
}
