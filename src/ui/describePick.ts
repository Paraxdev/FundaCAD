// One set of words for a picked face, edge or plane, shared by the list, the readout and the announcer. Any fact may be
// missing, its words are then left out.

import type { TopologyFace, Vec3 } from "../types";
import { t } from "../i18n";
import { spellNumber } from "./measure";
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
  /** The readout's parts folded for the voice, with no glyph between them. */
  aloud: string;
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
type As = "hint" | "readout" | "spoken";

const known = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v);
const every = (make: (as: As) => string): Required<Fact> => ({
  hint: make("hint"),
  readout: make("readout"),
  spoken: make("spoken"),
});
const lengthIn = (as: As, mm: number) => (as === "spoken" ? spokenLength(mm) : fmtLength(mm));
const shown = (screen: string, spoken: string): Required<Fact> => ({ hint: screen, readout: screen, spoken });

const facing = (n: Vec3 | undefined): Fact | null => {
  const f = n ? facingOf(n) : null;
  if (!f) return null;
  return every((as) => t("pick.fact.facing", { as, tilted: f.tilt ? "yes" : "no", deg: f.tilt, dir: f.word }));
};

// An axis is a line, its sign means nothing.
const AXIS_LINE: Record<FacingWord, string> = {
  up: "up",
  down: "up",
  front: "frontBack",
  back: "frontBack",
  left: "leftRight",
  right: "leftRight",
};
const axisFact = (axis: Vec3 | undefined): Fact | null => {
  const f = axis ? facingOf(axis) : null;
  if (!f) return null;
  return { spoken: t("pick.fact.axis", { tilted: f.tilt ? "yes" : "no", deg: f.tilt, line: AXIS_LINE[f.word] }) };
};

const diameter = (radius: number, tube = false): Fact =>
  every((as) => t("pick.fact.diameter", { as, tube: tube ? "yes" : "no", size: lengthIn(as, radius * 2) }));
const radiusFact = (radius: number): Fact => every((as) => t("pick.fact.radius", { as, size: lengthIn(as, radius) }));
const longFact = (mm: number) => every((as) => t("pick.fact.long", { size: lengthIn(as, mm) }));
const areaFact = (mm2: number) => shown(fmtArea(mm2), spokenArea(mm2));

const sizeFact = (size: [number, number] | undefined): Fact | null => {
  if (!size || !known(size[0]) || !known(size[1])) return null;
  const w = spellNumber(displayValue(size[0]));
  return every((as) => t("pick.fact.size", { w, h: lengthIn(as, size[1]) }));
};

// A body named as its feature, "Box" from Box, is said once.
const ownerFact = (owner: string | null | undefined, body: string | undefined): Fact | null =>
  owner ? { hint: owner, ...(owner === body ? {} : { spoken: t("pick.fact.from", { owner }) }) } : null;
const bodyFact = (body: string | undefined): Fact | null => (body ? { spoken: body } : null);

// A flat face as wide as long whose area is the circle's inside that square: a rounded square or a ring falls short.
function isDisc({ size, area }: FaceFacts): boolean {
  if (!size || !known(size[0]) || !known(size[1]) || !known(area) || size[0] <= 0) return false;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(a, b);
  return near(size[0], size[1]) && near(area, (Math.PI / 4) * size[0] * size[1]);
}

type FaceType = "flat" | "round" | "hole" | "cylinder" | "cone" | "sphere" | "torus" | "curved";
type EdgeType = "straight" | "round" | "curved";

function faceType(f: FaceFacts): FaceType | null {
  switch (f.surface) {
    case "plane":
      return "flat";
    case "cylinder":
      if (f.full === false) return "round";
      return f.full && f.concave ? "hole" : "cylinder";
    case "cone":
    case "sphere":
    case "torus":
      return f.surface;
    case "bspline":
    case "curved":
      return "curved";
    default:
      return null;
  }
}

function faceFacts(f: FaceFacts, type: FaceType | null): (Fact | null)[] {
  const isFlat = f.surface === "plane";
  const main: (Fact | null)[] = [];
  if (isFlat) main.push(isDisc(f) ? diameter(f.size![0] / 2) : sizeFact(f.size));
  if (known(f.radius)) {
    if (f.surface === "torus") main.push(diameter(f.radius, true));
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
    level && known(f.centroid?.[2]) ? { spoken: t("pick.fact.height", { h: spokenLength(f.centroid![2]) }) } : null,
    f.surface === "cylinder" || f.surface === "cone" ? axisFact(f.axis) : null,
    known(f.pieces) && f.pieces > 1 ? every(() => t("pick.fact.pieces", { n: f.pieces! })) : null,
    bodyFact(f.body),
    ownerFact(f.owner, f.body),
  ];
}

const EDGE_TYPE: Record<EdgeFacts["curve"], EdgeType> = {
  line: "straight",
  circle: "round",
  arc: "round",
  curve: "curved",
};

const joinFacts = (parts: string[]): string =>
  parts.length ? parts.reduce((before, after) => t("pick.list.more", { before, after })) : "";

const listed = (parts: string[]): string =>
  parts.length > 1
    ? t("pick.list.last", { before: joinFacts(parts.slice(0, -1)), last: parts[parts.length - 1]! })
    : (parts[0] ?? "");

function edgeFaces(faces: number[] | undefined): Fact | null {
  if (!faces?.length) return null;
  const on = (as: As) => t("pick.fact.onFace", { as, n: faces[0]! });
  if (faces.length === 1) return { hint: on("hint"), spoken: on("spoken") };
  const between = (as: As, nums: string[]) => t("pick.fact.betweenFaces", { as, faces: listed(nums) });
  return {
    hint: between("hint", faces.map(String)),
    spoken: between(
      "spoken",
      faces.map((n) => t("pick.fact.faceNumber", { n })),
    ),
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
// What the readout shows, in the words of the voice.
const aloudOf = (facts: (Fact | null)[]): string[] => facts.flatMap((f) => (f?.readout ? [f.spoken ?? f.readout] : []));

export function describePick(f: PickFacts): PickWords {
  if (f.kind === "plane") {
    const label = f.origin ? t("pick.plane.name", { name: f.name }) : f.name;
    const where = t("pick.plane.where", { where: f.origin ? "origin" : "datum" });
    const look = facing(f.normal);
    const aloud = joinFacts([label, where, ...channel([look], "spoken")]);
    return {
      label,
      hint: where,
      readout: [label, where, ...channel([look], "readout")].join(" · "),
      spoken: t("pick.plane.spoken", { facts: aloud }),
      aloud,
    };
  }
  const type = f.kind === "face" ? faceType(f) : EDGE_TYPE[f.curve];
  const facts = f.kind === "face" ? faceFacts(f, type as FaceType | null) : edgeFacts(f);
  const label = t(f.kind === "face" ? "pick.name.face" : "pick.name.edge", { type: type ?? "other", n: f.number });
  const head = t(f.kind === "face" ? "pick.head.face" : "pick.head.edge", { type: type ?? "other" });
  const shownFacts = channel(facts, "readout");
  return {
    label,
    hint: joinFacts(channel(facts, "hint")),
    readout: [head, ...shownFacts].join(" · "),
    spoken: joinFacts([label, ...channel(facts, "spoken")]),
    aloud: joinFacts([...head.split(" · "), ...aloudOf(facts)]),
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
