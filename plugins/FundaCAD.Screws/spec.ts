// A fastener spec: everything the geometry needs to build one fastener, for a catalogue entry and a
// user-defined one alike. catalogue/fields.json says which numbers each kind and part type needs, and
// geometry/scr_spec.py reads the same file, so the form, this check and the kernel agree.

import FIELDS from "./catalogue/fields.json";

export type Units = "mm" | "in";
export type Kind = "screw" | "shoulderScrew" | "nut" | "washer" | "insert";
export type PartName = "head" | "drive" | "point" | "shoulder" | "thread" | "nut" | "washer" | "insert";

export interface Part {
  type: string;
  [field: string]: string | number | boolean | undefined;
}

export interface ThreadPart extends Part {
  diameter: number;
  pitch: number;
  hand?: "right" | "left";
  length?: number;
  modelled?: boolean;
  designation?: string;
}

export interface FastenerSpec {
  kind: Kind;
  units: Units;
  name: string;
  notes?: string;
  standard?: string;
  length?: number;
  head?: Part;
  drive?: Part;
  point?: Part;
  shoulder?: Part;
  thread?: ThreadPart;
  nut?: Part;
  washer?: Part;
  insert?: Part;
  /** Shown in the spec table, never read by the geometry. */
  info?: Record<string, string | number>;
}

interface FieldDef { label: string; fields: [string, string][] }
interface KindDef { label: string; parts: PartName[]; fields: [string, string][] }

export const KINDS = FIELDS.kinds as unknown as Record<Kind, KindDef>;
export const PARTS = FIELDS.parts as unknown as Record<PartName, Record<string, FieldDef>>;
export const HANDS = FIELDS.hands as ("right" | "left")[];

export const PART_LABELS: Record<PartName, string> = {
  head: "Head", drive: "Drive", point: "Point", shoulder: "Shoulder", thread: "Thread",
  nut: "Nut", washer: "Washer", insert: "Insert",
};

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

export function fieldPhrase(partName: PartName, label: string): string {
  const part = PART_LABELS[partName].toLowerCase();
  const text = label.toLowerCase();
  return text.includes(part) ? text : `${part} ${text}`;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Every field the spec's kind and part types need that is missing or not a positive number. */
export function missingFields(spec: Partial<FastenerSpec>): string[] {
  const out: string[] = [];
  const kind = spec.kind ? KINDS[spec.kind] : undefined;
  if (!kind) return ["the fastener kind"];
  if (spec.units !== "mm" && spec.units !== "in") out.push("the units (mm or in)");
  if (!spec.name || !String(spec.name).trim()) out.push("a name");
  for (const partName of kind.parts) {
    const part = spec[partName] as Part | undefined;
    const types = PARTS[partName];
    const def = part && typeof part.type === "string" ? types[part.type] : undefined;
    if (!def) {
      out.push(`${PART_LABELS[partName].toLowerCase()} type`);
      continue;
    }
    for (const [field, label] of def.fields) {
      if (!positive(part![field])) out.push(fieldPhrase(partName, label));
    }
  }
  for (const [path, label] of kind.fields) {
    if (!positive(getPath(spec, path))) out.push(label.toLowerCase());
  }
  if (spec.thread && spec.thread.hand !== undefined && !HANDS.includes(spec.thread.hand)) out.push("thread hand");
  return out;
}

const n = (v: unknown) => (typeof v === "number" ? v : NaN);

/** Physical sanity, for a spec whose fields are all present. Mirrors geometry/scr_spec.py `sanity`. */
export function sanityProblems(spec: FastenerSpec): string[] {
  const out: string[] = [];
  const t = spec.thread;
  const d = n(t?.diameter);
  const head = spec.head;
  const drive = spec.drive;
  if (t) {
    if (n(t.pitch) * 0.6134 >= d / 2 * 0.8) out.push("the pitch is too coarse for the thread diameter");
  }
  if (spec.kind === "screw" || spec.kind === "shoulderScrew") {
    const L = n(spec.length);
    const shank = spec.kind === "shoulderScrew" ? n(spec.shoulder?.diameter) : d;
    if (spec.kind === "shoulderScrew" && !(shank > d)) out.push("the shoulder must be wider than the thread");
    if (head && head.type !== "none") {
      const across = head.type === "hex" || head.type === "hexFlange" ? n(head.acrossFlats) : n(head.diameter);
      if (!(across > shank)) out.push("the head must be wider than the shank");
    }
    if (head?.type === "hexFlange") {
      if (!(n(head.flangeDiameter) > n(head.acrossFlats))) out.push("the flange must be wider than the hex");
      if (!(n(head.flangeThickness) < n(head.height))) out.push("the flange must be thinner than the head");
    }
    if (head?.type === "knurled") {
      if (!(n(head.collarDiameter) > shank && n(head.collarDiameter) <= n(head.diameter))) {
        out.push("the collar must be wider than the shank and no wider than the knurl");
      }
      if (!(n(head.collarHeight) < n(head.height))) out.push("the collar must be lower than the head");
    }
    const sunk = head?.type === "countersunk" ? n(head.height) : 0;
    if (sunk && !(sunk < L)) out.push("the countersunk head must be shorter than the overall length");
    if (spec.kind === "screw" && n(t?.length) > L - sunk + 1e-9) out.push("the thread cannot be longer than the shank");
    if (drive && drive.type !== "none") {
      const size = n(drive.size);
      const room = head && head.type !== "none"
        ? (head.type === "hex" || head.type === "hexFlange" ? n(head.acrossFlats) : n(head.diameter))
        : d;
      const reach = drive.type === "hex" ? size * 1.1547 : drive.type === "square" ? size * 1.4142 : size;
      if (drive.type === "slot" ? !(size < room / 2) : !(reach < room)) out.push("the drive does not fit in the head");
      const allowed = head && head.type !== "none" ? n(head.height) + d / 2 : n(spec.length) * 0.6;
      if (!(n(drive.depth) < allowed)) out.push("the drive recess is too deep");
    }
    const pt = spec.point;
    if (pt && (pt.type === "flat" || pt.type === "cup") && !(n(pt.diameter) < d)) {
      out.push("the point diameter must be smaller than the thread");
    }
  }
  if (spec.kind === "nut" && spec.nut) {
    const nut = spec.nut;
    if (!(n(nut.acrossFlats) > d * 1.05)) out.push("the nut must be wider than its thread");
    if (nut.type === "nyloc" && !(n(nut.hexHeight) < n(nut.height))) out.push("the hex must be lower than the whole nut");
    if (nut.type === "flange") {
      if (!(n(nut.flangeDiameter) > n(nut.acrossFlats))) out.push("the flange must be wider than the hex");
      if (!(n(nut.flangeThickness) < n(nut.height))) out.push("the flange must be thinner than the nut");
    }
  }
  if (spec.kind === "washer" && spec.washer) {
    if (!(n(spec.washer.outer) > n(spec.washer.inner))) out.push("the outer diameter must be larger than the inner");
  }
  if (spec.kind === "insert" && spec.insert) {
    if (!(n(spec.insert.outer) > d * 1.1)) out.push("the insert must be wider than its thread");
  }
  return out;
}

/** Everything wrong with a spec, completeness first, as sentences a form can show. */
export function specProblems(spec: Partial<FastenerSpec>): string[] {
  const missing = missingFields(spec);
  if (missing.length) return [`Missing: ${missing.join(", ")}`];
  return sanityProblems(spec as FastenerSpec);
}
