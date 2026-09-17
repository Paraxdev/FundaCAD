// The standard catalogue: families read from catalogue/*.json and expanded into complete specs.
//
// Adding a family or a size is an edit to metric.json or inch.json: `fixed` sets the values every
// member shares, `columns` maps a row's columns onto spec fields, `threadLength` says how long the
// thread is, and `lengths` names a series in threads.json that each row's `L` range filters.

import METRIC from "./catalogue/metric.json";
import INCH from "./catalogue/inch.json";
import THREADS from "./catalogue/threads.json";
import { KINDS, PARTS, PART_LABELS, getPath, setPath, type FastenerSpec, type Kind, type Part, type Units } from "./spec";

export type ThreadTable = "metric" | "inch" | "tapping";

export interface ThreadLengthRule {
  full?: boolean;
  column?: string;
  /** [longest length the step covers or null for the rest, a, c]: b = a * d + c. */
  steps?: [number | null, number, number][];
  /** Fully threaded when no more than this many pitches of plain shank would be left. */
  fullWithin?: number;
  fullUpTo?: number;
}

export interface SizeRow {
  size: string;
  label?: string;
  L?: [number, number];
  lengths?: number[];
  [column: string]: string | number | number[] | undefined;
}

export interface Family {
  id: string;
  name: string;
  standard: string;
  aka: string[];
  category: string;
  threads: ThreadTable;
  fixed: Record<string, string | number>;
  columns: Record<string, string>;
  drives?: string[];
  threadLength?: ThreadLengthRule;
  lengths?: string;
  lengthPath?: string;
  /** What a name starts with, when the standard's own name is not what people call it. */
  prefix?: string;
  sizes: SizeRow[];
}

export interface ThreadSize { d: number; coarse?: number; fine?: number[]; unc?: number; unf?: number }
export interface HoleSizes { close: number; medium?: number; free: number; tap: number }

const TABLES = THREADS as unknown as Record<ThreadTable, { standard: string; units: Units; sizes: Record<string, ThreadSize> }>;
export const HOLES = THREADS.holes as Record<string, HoleSizes>;
const SERIES = THREADS.lengthSeries as Record<string, number[]>;

export const FAMILIES: Family[] = [...(METRIC as unknown as Family[]), ...(INCH as unknown as Family[])];

export const CATEGORY_ORDER = [
  "Socket screws", "Machine screws", "Bolts", "Set screws", "Special screws",
  "Tapping and wood screws", "Nuts", "Washers", "Inserts",
];

export function familyById(id: string): Family | undefined {
  return FAMILIES.find((f) => f.id === id);
}

export function unitsOf(f: Family): Units {
  return TABLES[f.threads].units;
}

export function threadSize(f: Family, size: string): ThreadSize | undefined {
  return TABLES[f.threads].sizes[size];
}

export function kindOf(f: Family): Kind {
  return f.fixed["kind"] as Kind;
}

/** A family's defining type: the head for a screw, else the nut, washer or insert type. */
export function headTypeOf(f: Family): string {
  const kind = kindOf(f);
  const part = kind === "screw" || kind === "shoulderScrew" ? "head" : kind;
  return String(f.fixed[`${part}.type`] ?? "");
}

export function headLabel(f: Family): string {
  const kind = kindOf(f);
  const part = (kind === "screw" || kind === "shoulderScrew" ? "head" : kind) as keyof typeof PARTS;
  return PARTS[part][headTypeOf(f)]?.label ?? headTypeOf(f);
}

export function drivesOf(f: Family): string[] {
  if (f.drives?.length) return f.drives;
  const fixed = f.fixed["drive.type"];
  return typeof fixed === "string" ? [fixed] : [];
}

export function lengthsFor(f: Family, row: SizeRow): number[] {
  if (row.lengths) return row.lengths;
  if (!f.lengths || !row.L) return [];
  const [lo, hi] = row.L;
  return (SERIES[f.lengths] ?? []).filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);
}

export interface PitchChoice { pitch: number; label: string; fine: boolean }

/** Coarse first, then the fine pitches the thread standard defines for this size. */
export function pitchesFor(f: Family, size: string): PitchChoice[] {
  const t = threadSize(f, size);
  if (!t) return [];
  if (f.threads === "inch") {
    const out: PitchChoice[] = [];
    if (t.unc) out.push({ pitch: 1 / t.unc, label: `${t.unc} TPI (UNC)`, fine: false });
    if (t.unf) out.push({ pitch: 1 / t.unf, label: `${t.unf} TPI (UNF)`, fine: true });
    return out;
  }
  const out: PitchChoice[] = [];
  if (t.coarse) out.push({ pitch: t.coarse, label: `${t.coarse} mm coarse`, fine: false });
  for (const p of t.fine ?? []) out.push({ pitch: p, label: `${p} mm fine`, fine: true });
  return out;
}

const INCH_FRACTIONS = 32;

/** 0.625 -> "5/8", 1.25 -> "1-1/4", 0.086 -> "0.086". */
export function formatInch(v: number): string {
  const whole = Math.floor(v + 1e-9);
  const rest = v - whole;
  const num = Math.round(rest * INCH_FRACTIONS);
  if (Math.abs(rest * INCH_FRACTIONS - num) > 1e-6) return String(+v.toFixed(4));
  if (num === 0) return String(whole);
  let a = num;
  let b = INCH_FRACTIONS;
  while (a % 2 === 0) { a /= 2; b /= 2; }
  return whole ? `${whole}-${a}/${b}` : `${a}/${b}`;
}

export function formatLength(v: number, units: Units): string {
  return units === "in" ? `${formatInch(v)}"` : `${+v.toFixed(3)}`;
}

export function threadDesignation(f: Family, size: string, pitch: number): string {
  const t = threadSize(f, size);
  if (f.threads === "inch") {
    const tpi = Math.round(1 / pitch);
    return `${size}-${tpi} ${t?.unf === tpi && t?.unc !== tpi ? "UNF" : "UNC"}`;
  }
  if (f.threads === "tapping" || !t || Math.abs(pitch - (t.coarse ?? 0)) < 1e-9) return size;
  return `${size}x${pitch}`;
}

export function threadLengthFor(rule: ThreadLengthRule | undefined, row: SizeRow, d: number, pitch: number, L: number): number {
  if (!rule || rule.full) return L;
  if (rule.column) return Number(row[rule.column]);
  if (rule.fullUpTo !== undefined && L <= rule.fullUpTo + 1e-9) return L;
  const step = (rule.steps ?? []).find(([max]) => max === null || L <= max + 1e-9);
  if (!step) return L;
  const b = step[1] * d + step[2];
  if (L - b <= (rule.fullWithin ?? 0) * pitch + 1e-9) return L;
  return b;
}

export const DRIVE_PREFIX: Record<string, string> = { phillips: "PH", pozidriv: "PZ", torx: "T" };

export interface ItemChoice {
  familyId: string;
  size: string;
  length?: number;
  drive?: string;
  pitch?: number;
  modelled?: boolean;
  hand?: "right" | "left";
}

function round(v: number): number {
  return +v.toFixed(6);
}

/** The complete spec for one catalogue choice. Throws on a choice the table does not have. */
export function expand(choice: ItemChoice): FastenerSpec {
  const f = familyById(choice.familyId);
  if (!f) throw new Error(`unknown family ${choice.familyId}`);
  const row = f.sizes.find((r) => r.size === choice.size);
  if (!row) throw new Error(`${f.standard} has no size ${choice.size}`);
  const ts = threadSize(f, row.size);
  if (!ts) throw new Error(`no thread table entry for ${row.size}`);
  const kind = kindOf(f);
  const units = unitsOf(f);
  const spec: Record<string, unknown> = { kind, units, name: "", standard: f.standard };
  for (const [path, v] of Object.entries(f.fixed)) setPath(spec, path, v);
  for (const [col, path] of Object.entries(f.columns)) {
    const v = row[col];
    if (v !== undefined) setPath(spec, path, v);
  }
  const drives = drivesOf(f);
  const drive = choice.drive && drives.includes(choice.drive) ? choice.drive : drives[0];
  if (drive) setPath(spec, "drive.type", drive);

  const pitches = pitchesFor(f, row.size);
  const pitch = choice.pitch !== undefined && pitches.some((p) => Math.abs(p.pitch - choice.pitch!) < 1e-9)
    ? choice.pitch
    : pitches[0]!.pitch;
  const thread: Record<string, unknown> = {
    type: f.threads === "inch" ? "unified" : f.threads,
    diameter: ts.d,
    pitch: round(pitch),
    hand: choice.hand ?? "right",
    modelled: !!choice.modelled,
    designation: threadDesignation(f, row.size, pitch),
  };
  spec["thread"] = thread;

  const lengths = lengthsFor(f, row);
  let length: number | undefined;
  if (lengths.length) {
    length = choice.length !== undefined && lengths.some((l) => Math.abs(l - choice.length!) < 1e-9)
      ? choice.length
      : lengths[0]!;
    if (f.lengthPath) setPath(spec, f.lengthPath, length);
    else spec["length"] = length;
  }
  if ((kind === "screw" || kind === "shoulderScrew") && length !== undefined) {
    let b = threadLengthFor(f.threadLength, row, ts.d, pitch, length);
    const head = spec["head"] as Part | undefined;
    if (kind === "screw" && head?.type === "countersunk") b = Math.min(b, length - Number(head.height));
    if (kind === "screw") b = Math.min(b, length);
    thread["length"] = round(b);
  }

  const lenText = length !== undefined ? (units === "in" ? ` x ${formatInch(length)}` : `x${length}`) : "";
  const sizeText = String(thread["designation"]);
  const drivePrefix = drive && f.drives && f.drives.length > 1 ? ` ${DRIVE_PREFIX[drive] ?? drive}` : "";
  spec["name"] = `${f.prefix ?? f.standard} ${sizeText}${lenText}${drivePrefix}`;
  if (row.label) spec["info"] = { ...(spec["info"] as object | undefined), size: row.label };
  return spec as unknown as FastenerSpec;
}

/** One listed entry: a family, a size, a length where the family has them, and a drive. */
export interface CatalogueItem extends ItemChoice {
  key: string;
}

export function itemsOf(f: Family): CatalogueItem[] {
  const out: CatalogueItem[] = [];
  const drives = f.drives?.length ? f.drives : [undefined];
  for (const row of f.sizes) {
    const lengths = lengthsFor(f, row);
    for (const drive of drives) {
      const base = { familyId: f.id, size: row.size, ...(drive ? { drive } : {}) };
      if (!lengths.length) out.push({ ...base, key: `${f.id}|${row.size}||${drive ?? ""}` });
      for (const length of lengths) out.push({ ...base, length, key: `${f.id}|${row.size}|${length}|${drive ?? ""}` });
    }
  }
  return out;
}

export function catalogueSize(): number {
  return FAMILIES.reduce((sum, f) => sum + itemsOf(f).length, 0);
}

export interface SpecRow { label: string; value: string }

function num(v: unknown, units: Units): string {
  if (typeof v !== "number") return String(v ?? "");
  return units === "in" ? `${+v.toFixed(4)} in` : `${+v.toFixed(3)} mm`;
}

/** The spec table: standard, every dimension the spec's parts carry, the thread, and the holes. */
export function specRows(spec: FastenerSpec, opts: { size?: string; volume?: number } = {}): SpecRow[] {
  const u = spec.units;
  const rows: SpecRow[] = [];
  if (spec.standard) rows.push({ label: "Standard", value: spec.standard });
  rows.push({ label: "Type", value: KINDS[spec.kind]?.label ?? spec.kind });
  if (spec.info?.["size"]) rows.push({ label: "Size", value: String(spec.info["size"]) });
  const kind = KINDS[spec.kind];
  for (const partName of kind?.parts ?? []) {
    const part = spec[partName] as Part | undefined;
    if (!part) continue;
    const def = PARTS[partName][part.type];
    if (partName === "thread") continue;
    let typeLabel = def?.label ?? part.type;
    if (partName === "drive" && typeof part["number"] === "number") {
      typeLabel += ` ${DRIVE_PREFIX[part.type] ?? ""}${part["number"]}`;
    }
    rows.push({ label: PART_LABELS[partName], value: typeLabel });
    for (const [field, label] of def?.fields ?? []) rows.push({ label: `  ${label}`, value: num(part[field], u) });
    if (partName === "head" && typeof part["angle"] === "number") rows.push({ label: "  Countersink angle", value: `${part["angle"]} deg` });
  }
  const t = spec.thread;
  if (t) {
    rows.push({ label: "Thread", value: t.designation ?? `${num(t.diameter, u)}` });
    rows.push({ label: "  Diameter", value: num(t.diameter, u) });
    rows.push({
      label: "  Pitch",
      value: u === "in" ? `${Math.round(1 / t.pitch)} TPI` : `${+t.pitch.toFixed(4)} mm`,
    });
    if (typeof t.length === "number") rows.push({ label: "  Thread length", value: num(t.length, u) });
    rows.push({ label: "  Hand", value: t.hand === "left" ? "Left" : "Right" });
    rows.push({ label: "  Modelled", value: t.modelled ? "Helical thread" : "Simplified, plain at the nominal diameter" });
  }
  for (const [path, label] of kind?.fields ?? []) {
    if (path === "thread.length") continue;
    rows.push({ label, value: num(getPath(spec, path), u) });
  }
  const holes = opts.size ? HOLES[opts.size] : undefined;
  if (holes) {
    rows.push({ label: "Clearance hole", value: `close ${num(holes.close, u)}, free ${num(holes.free, u)}` });
    if (spec.kind !== "washer") rows.push({ label: "Tap drill", value: num(holes.tap, u) });
  }
  const head = spec.head;
  if (head && (head.type === "socketCap" || head.type === "lowHead")) {
    const extra = u === "in" ? 1 / 32 : 1;
    rows.push({ label: "Counterbore", value: `${num(Number(head.diameter) + extra, u)} dia, ${num(Number(head.height) + extra / 2, u)} deep` });
  }
  if (head?.type === "countersunk") rows.push({ label: "Countersink", value: `${num(Number(head.diameter), u)} dia` });
  if (spec.info?.["hole"] !== undefined) rows.push({ label: "Hole for printing", value: num(spec.info["hole"], u) });
  if (opts.volume !== undefined) {
    rows.push({ label: "Mass (steel)", value: `${(opts.volume * 7.85e-3).toFixed(opts.volume * 7.85e-3 < 10 ? 2 : 1)} g` });
  }
  if (spec.notes) rows.push({ label: "Notes", value: spec.notes });
  return rows;
}
