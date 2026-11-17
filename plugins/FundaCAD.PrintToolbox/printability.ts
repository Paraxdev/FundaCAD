// The pure half of the Printability panel. Nothing here touches the viewport or the store, so it is testable in node.

import { numberText } from "fundacad";
import type {
  PrintabilityCheck,
  PrintabilityFinding,
  PrintabilityKind,
  PrintabilityOptions,
  PrintabilityReply,
  PrintabilityUp,
} from "fundacad";
import { t, toolLabel } from "./lines";

export interface PrintabilitySetup {
  /** mm whatever the display unit: these are nozzle-sized numbers, and the
   *  engine's report quotes them in mm. Null while a field holds no number. */
  nozzle: number | null;
  layer: number | null;
  /** Degrees past vertical a face may lean before it needs support. */
  overhang: number | null;
  minGap: number | null;
  maxBridge: number | null;
  up: PrintabilityUp;
  /** Lay each body on its largest flat face instead of turning it by `up`. */
  layFlat: boolean;
  checks: Record<PrintabilityCheck, boolean>;
}

/** Read when the list is drawn, so the first label follows the language. */
export function upChoices(): { value: PrintabilityUp; label: string }[] {
  return [
    { value: "+Z", label: t("up.modelled") },
    { value: "-Z", label: "-Z" },
    { value: "+X", label: "+X" },
    { value: "-X", label: "-X" },
    { value: "+Y", label: "+Y" },
    { value: "-Y", label: "-Y" },
  ];
}

export const CHECK_IDS: readonly PrintabilityCheck[] = ["overhang", "wall", "gap", "bridge", "open"];

function checkLabel(id: PrintabilityCheck): string {
  switch (id) {
    case "overhang":
      return t("check.overhang");
    case "wall":
      return t("check.wall");
    case "gap":
      return t("check.gap");
    case "bridge":
      return t("check.bridge");
    case "open":
      return t("check.open");
  }
}

export function checkChoices(): { value: PrintabilityCheck; label: string }[] {
  return CHECK_IDS.map((value) => ({ value, label: checkLabel(value) }));
}

export function newPrintabilitySetup(): PrintabilitySetup {
  return {
    nozzle: 0.4,
    layer: 0.2,
    overhang: 45,
    minGap: 0.2,
    maxBridge: 10,
    up: "+Z",
    layFlat: false,
    checks: { overhang: true, wall: true, gap: true, bridge: true, open: true },
  };
}

/** One tint per kind, in the view and beside the legend. Clear of the app's
 *  hover amber and selection orange, which mark the finding a row puts forward. */
export const KIND_COLORS: Record<PrintabilityKind, number> = {
  overhang: 0xff5c8a,
  bridge: 0xb48cff,
  wall: 0x3fa9f5,
  floor: 0x3fd0c9,
  gap: 0x8bd450,
  fused: 0xe23b3b,
  meshHole: 0xf0e442,
  flatTriangle: 0x8d6e63,
};

/** A tint as a CSS colour, for the legend's swatches. */
export function cssHex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export function kindLabel(kind: PrintabilityKind): string {
  switch (kind) {
    case "overhang":
      return t("kind.overhang");
    case "bridge":
      return t("kind.bridge");
    case "wall":
      return t("kind.wall");
    case "floor":
      return t("kind.floor");
    case "gap":
      return t("kind.gap");
    case "fused":
      return t("kind.fused");
    case "meshHole":
      return t("kind.meshHole");
    case "flatTriangle":
      return t("kind.flatTriangle");
  }
}

export type PrintabilityRequest = { ok: true; options: PrintabilityOptions } | { ok: false; message: string };

/** The panel's settings as the op's options for `bodies` (empty checks every body), or the first thing in the way,
 *  phrased for the status line. Every setting is sent, so the engine checks against what the panel shows. */
export function buildPrintabilityRequest(s: PrintabilitySetup, bodies: string[]): PrintabilityRequest {
  // A cleared field is null, which compares as 0, so check the type first.
  if (!isNum(s.nozzle) || !(s.nozzle > 0)) return { ok: false, message: t("request.nozzle") };
  if (!isNum(s.layer) || !(s.layer > 0)) return { ok: false, message: t("request.layer") };
  if (!isNum(s.overhang) || !(s.overhang > 0 && s.overhang < 90)) {
    return { ok: false, message: t("request.overhang") };
  }
  if (!isNum(s.minGap) || !(s.minGap > 0)) return { ok: false, message: t("request.minGap") };
  if (!isNum(s.maxBridge) || !(s.maxBridge > 0)) return { ok: false, message: t("request.maxBridge") };
  const checks = CHECK_IDS.filter((c) => s.checks[c]);
  if (!checks.length) return { ok: false, message: t("request.noChecks") };
  const options: PrintabilityOptions = {
    nozzle: s.nozzle,
    layer: s.layer,
    overhang: s.overhang,
    minGap: s.minGap,
    maxBridge: s.maxBridge,
  };
  if (bodies.length) options.bodies = [...bodies];
  // Left out when all are on, so the engine runs all it has.
  if (checks.length < CHECK_IDS.length) options.checks = checks;
  if (s.layFlat) options.layFlat = true;
  else options.up = s.up;
  return { ok: true, options };
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** One finding's row: its words and where it sits in the reply's findings. */
export interface FindingRow {
  index: number;
  kind: PrintabilityKind;
  /** The words are read when drawn, so a language switch reaches a result already on screen. */
  readonly text: string;
  /** Face and height above the bed, shown under the text. */
  readonly hint: string;
  /** The text and the place, as the row is named to a screen reader. */
  readonly spoken: string;
}

/** A problem with a body as a whole, kept as data so its words follow the language. */
export type BodyFact = { kind: "openShell" | "pieces"; n: number } | { kind: "insideOut" };

export interface BodyGroup {
  body: string;
  name: string;
  facts: BodyFact[];
  /** Problems with the body as a whole, an open shell or several pieces. */
  readonly notes: string[];
  rows: FindingRow[];
}

/** The reply as the panel shows it. `findings` stays the engine's own, which
 *  the rows index into, for the faces and where to look. */
export interface PrintabilityView {
  header: string;
  groups: BodyGroup[];
  findings: PrintabilityFinding[];
  /** The kinds found, in legend order. */
  kinds: PrintabilityKind[];
  errors: string[];
}

// In mm like the settings they are held to, see PrintabilitySetup, so a line writes its own unit after the number.
const num = (v: number) => numberText(v);

function area(v: number): string {
  return v >= 10 ? String(Math.round(v)) : numberText(v);
}

/** The pieces of a sentence joined the way the language writes a list of clauses. */
function join(parts: readonly string[]): string {
  return parts.reduce((first, second) => t("text.join", { first, second }));
}

/** A finding in a few plain words. `nameOf` names the other body of a fused pair. */
export function findingText(f: PrintabilityFinding, nameOf: (id: string) => string): string {
  let text: string;
  switch (f.kind) {
    case "overhang":
      text = t("finding.overhang", { area: area(f.area), deg: Math.round(f.value) });
      break;
    case "bridge":
      text = t("finding.bridge", { value: num(f.value), limit: num(f.limit) });
      break;
    case "wall":
      text = t("finding.wall", { value: num(f.value), limit: num(f.limit) });
      break;
    case "floor":
      text = t("finding.floor", { value: num(f.value), limit: num(f.limit) });
      break;
    case "gap":
      text = t("finding.gap", { value: num(f.value) });
      break;
    case "fused": {
      const other = f.other ? nameOf(f.other.body) : t("finding.anotherBody");
      // Under a thousandth is touching, as far as the nozzle can tell.
      text = f.value >= 0.001 ? t("finding.fused", { value: num(f.value), other }) : t("finding.touches", { other });
      break;
    }
    case "meshHole":
      text = t("finding.meshHole", { n: Math.round(f.value) });
      break;
    case "flatTriangle":
      text = t("finding.flatTriangle", { n: Math.round(f.value) });
      break;
    default:
      text = String(f.kind);
  }
  return f.note ? join([text, ...noteParts(f.note)]) : text;
}

// The engine writes its notes in English and joins several with ", ", see printcheck/mod.rs and op.rs. A note it has
// not told us about shows as it came.
const NOTES: Record<string, () => string> = {
  "partly bridged": () => t("note.partlyBridged"),
  "a sideways hole: teardropHole or roofBridge fixes it": () =>
    t("note.sidewaysHole", { teardrop: toolLabel("print-teardrop"), roofBridge: toolLabel("print-roof-bridge") }),
};

export const ENGINE_NOTES: readonly string[] = Object.keys(NOTES);

function noteParts(note: string): string[] {
  return note.split(", ").map((part) => NOTES[part]?.() ?? part);
}

/** The header the engine put on the reply, rebuilt from the reply's own data so it follows the language. The engine
 *  sends no header when it has nothing to say, and one with no bodies has no bed to name. */
function headerText(r: PrintabilityReply, nameOf: (id: string) => string): string {
  if (!r.header || !r.bodies.length) return "";
  if (r.settings.layFlat) {
    const list = r.bodies.map((b) =>
      typeof b.bedFace === "number"
        ? t("header.onFace", { name: nameOf(b.id), n: b.bedFace + 1 })
        : t("header.noFlatFace", { name: nameOf(b.id) }),
    );
    return t("header.layFlat", { list: join(list) });
  }
  const up = r.settings.up;
  if (!up) return "";
  // The bed is measured along the up axis, so a down axis reads back as the coordinate it sits at.
  const bed = Math.min(...r.bodies.map((b) => b.bed)) * (up.startsWith("-") ? -1 : 1);
  const value = numberText(Math.round(bed * 1000) / 1000 + 0);
  return t("header.upAsModelled", { up, axis: up.slice(1).toLowerCase(), value });
}

/** Where a finding sits, by face number (what the Geometry tab shows) and height above its body's bed. `hint` starts
 *  with a capital, `spoken` is lower case to follow other words. A body the reply does not list has no height.
 *  An overhang is placed by its lowest point, as the engine's report does, any other finding by its middle. */
export function findingPlace(
  f: PrintabilityFinding,
  bodies: PrintabilityReply["bodies"],
  nameOf: (id: string) => string,
): { hint: string; spoken: string } {
  let faces = t("place.face", { n: f.face + 1 });
  if (f.other) {
    faces =
      f.other.body === f.body
        ? t("place.faces", { a: f.face + 1, b: f.other.face + 1 })
        : t("place.faceAndOther", { a: f.face + 1, b: f.other.face + 1, name: nameOf(f.other.body) });
  }
  const b = bodies.find((x) => x.id === f.body);
  const parts = [faces];
  if (b && (b.up[0] !== 0 || b.up[1] !== 0 || b.up[2] !== 0)) {
    // Under a thousandth of a millimetre is the bed itself.
    if (f.kind === "overhang") {
      parts.push(f.low < 0.001 ? t("place.fromBed") : t("place.aboveBedFrom", { value: num(f.low) }));
    } else {
      const h = f.at[0] * b.up[0] + f.at[1] * b.up[1] + f.at[2] * b.up[2] - b.bed;
      parts.push(h < 0.001 ? t("place.onBed") : t("place.centred", { value: num(h) }));
    }
  }
  const spoken = join(parts);
  return { hint: spoken.charAt(0).toUpperCase() + spoken.slice(1), spoken };
}

/** The kinds in the legend's order, which is also the order of KIND_COLORS. */
export const KIND_ORDER = Object.keys(KIND_COLORS) as PrintabilityKind[];

/** The reply grouped by body, in the reply's body order, each finding a row.
 *  A finding on a body the reply does not list still gets a group. */
export function formatPrintabilityResult(
  r: PrintabilityReply,
  labels: ReadonlyMap<string, string> = new Map(),
): PrintabilityView {
  const names = new Map(r.bodies.map((b) => [b.id, labels.get(b.id) ?? (b.name || b.id)]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const groups = new Map<string, BodyGroup>();
  const groupOf = (id: string): BodyGroup => {
    let g = groups.get(id);
    if (!g) {
      g = {
        body: id,
        name: nameOf(id),
        facts: [],
        get notes() {
          return this.facts.map(factText);
        },
        rows: [],
      };
      groups.set(id, g);
    }
    return g;
  };
  for (const b of r.bodies) {
    const g = groupOf(b.id);
    if (b.openEdges > 0) g.facts.push({ kind: "openShell", n: b.openEdges });
    if (b.solids > 1) g.facts.push({ kind: "pieces", n: b.solids });
    if (b.insideOut) g.facts.push({ kind: "insideOut" });
  }
  const kinds = new Set<PrintabilityKind>();
  r.findings.forEach((f, index) => {
    groupOf(f.body).rows.push({
      index,
      kind: f.kind,
      get text() {
        return findingText(f, nameOf);
      },
      get hint() {
        return findingPlace(f, r.bodies, nameOf).hint;
      },
      get spoken() {
        return join([findingText(f, nameOf), findingPlace(f, r.bodies, nameOf).spoken]);
      },
    });
    kinds.add(f.kind);
  });
  // The engine's own English, with only the feature it names set in the language's punctuation.
  const errors = (r.errors ?? []).map((e) =>
    e.feature_id ? t("result.engineError", { id: e.feature_id, message: e.message }) : e.message,
  );
  return {
    get header() {
      return headerText(r, nameOf);
    },
    groups: [...groups.values()],
    findings: r.findings,
    kinds: KIND_ORDER.filter((k) => kinds.has(k)),
    errors,
  };
}

function factText(f: BodyFact): string {
  switch (f.kind) {
    case "openShell":
      return t("note.openShell", { n: f.n });
    case "pieces":
      return t("note.pieces", { n: f.n });
    case "insideOut":
      return t("note.insideOut");
  }
}

/** How many things the check found, body-level problems included. */
export function problemCount(v: PrintabilityView): number {
  return v.groups.reduce((n, g) => n + g.notes.length + g.rows.length, 0);
}

function kindCount(kind: PrintabilityKind, n: number): string {
  switch (kind) {
    case "overhang":
      return t("count.overhang", { n });
    case "bridge":
      return t("count.bridge", { n });
    case "wall":
      return t("count.wall", { n });
    case "floor":
      return t("count.floor", { n });
    case "gap":
      return t("count.gap", { n });
    case "fused":
      return t("count.fused", { n });
    case "meshHole":
      return t("count.meshHole", { n });
    case "flatTriangle":
      return t("count.flatTriangle", { n });
  }
}

/** Whether the check found things, nothing, or could not run: what the status line colours by. */
export function printabilityOutcome(v: PrintabilityView): "problems" | "clean" | "failed" {
  if (problemCount(v)) return "problems";
  // Failures with no body checked found nothing only because nothing built.
  return !v.groups.length && v.errors.length ? "failed" : "clean";
}

/** What a screen reader hears once a Check is done: the count, each kind's share, and the largest overhang with its
 *  area and face. A tie on the area takes the first in the reply. The body is named only when the reply has several. */
export function printabilityHead(v: PrintabilityView): string {
  const outcome = printabilityOutcome(v);
  if (outcome === "problems") return t("head.found", { n: problemCount(v) });
  return outcome === "failed" ? t("head.failed") : t("head.clean");
}

const sentence = (text: string) => t("text.sentence", { text });
const sentences = (parts: readonly string[]) =>
  parts.map(sentence).reduce((first, second) => t("text.sentences", { first, second }));

export function printabilitySummary(v: PrintabilityView): string {
  const rest = printabilityDetails(v);
  const head = sentence(printabilityHead(v));
  return rest ? t("text.sentences", { first: head, second: rest }) : head;
}

/** The summary after its head, for when a toast has said the head already. */
export function printabilityDetails(v: PrintabilityView): string {
  const parts: string[] = [];
  for (const k of KIND_ORDER) {
    const c = v.findings.filter((f) => f.kind === k).length;
    if (c) parts.push(kindCount(k, c));
  }
  const notes = v.groups.reduce((n, g) => n + g.notes.length, 0);
  if (notes) parts.push(t("count.bodyNote", { n: notes }));
  if (v.errors.length) parts.push(t("count.error", { n: v.errors.length }));
  const said: string[] = [];
  if (parts.length) said.push(join(parts));
  const overhangs = v.findings.filter((f) => f.kind === "overhang");
  let largest: PrintabilityFinding | undefined;
  for (const f of overhangs) if (!largest || f.area > largest.area) largest = f;
  if (largest) {
    const body = v.groups.length > 1 ? (v.groups.find((g) => g.body === largest!.body)?.name ?? largest.body) : null;
    const args = { many: overhangs.length > 1 ? "yes" : "no", area: area(largest.area), face: largest.face + 1 };
    said.push(body === null ? t("summary.overhang", args) : t("summary.overhangOf", { ...args, name: body }));
  }
  return said.length ? sentences(said) : "";
}

/** The tints for a result in display face ids: each finding's face in its kind's colour, and the finding put forward
 *  (its face and the one across) in `emphasisColor`. `faceOf` maps a body's own face index to the viewport's id, or
 *  null for a face that cannot be drawn, on a hidden body or past the body's faces. */
export function findingMarks(
  findings: readonly PrintabilityFinding[],
  emphasis: number | null,
  emphasisColor: number,
  faceOf: (body: string, face: number) => number | null,
): { faceIds: number[]; color: number }[] {
  const forward = new Set<number>();
  const f = emphasis === null ? undefined : findings[emphasis];
  if (f) {
    const ends: [string, number][] = [[f.body, f.face]];
    if (f.other) ends.push([f.other.body, f.other.face]);
    for (const [body, face] of ends) {
      const id = faceOf(body, face);
      if (id !== null) forward.add(id);
    }
  }
  const byKind = new Map<PrintabilityKind, Set<number>>();
  // Both sides of a wall, a gap or a fused pair, as the row names both.
  for (const x of findings) {
    const ends: [string, number][] = [[x.body, x.face]];
    if (x.other) ends.push([x.other.body, x.other.face]);
    for (const [body, face] of ends) {
      const id = faceOf(body, face);
      if (id === null || forward.has(id)) continue;
      const set = byKind.get(x.kind) ?? new Set<number>();
      set.add(id);
      byKind.set(x.kind, set);
    }
  }
  const marks = KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({
    faceIds: [...byKind.get(k)!],
    color: KIND_COLORS[k],
  }));
  if (forward.size) marks.push({ faceIds: [...forward], color: emphasisColor });
  return marks;
}

/** Where to look for a finding: its point, and a view about twice its size
 *  across, never under 5 mm so a pinhole still shows what is around it. */
export function findingView(f: PrintabilityFinding): { at: [number, number, number]; size: number } {
  const e = Number.isFinite(f.extent) ? f.extent : 0;
  return { at: [f.at[0], f.at[1], f.at[2]], size: Math.max(5, 2 * e) };
}
