// The library list: one entry per catalogue family and size, and one per user fastener, with the
// search and the filters over them.

import {
  CATEGORY_ORDER, FAMILIES, drivesOf, headLabel, lengthsFor, unitsOf, type Family,
} from "./catalogue";
import { PARTS, type FastenerSpec } from "./spec";
import type { UserFastener } from "./library";

export const CUSTOM_CATEGORY = "Custom";

export interface ListEntry {
  key: string;
  source: "catalogue" | "custom";
  familyId?: string;
  customId?: string;
  size: string;
  sizeLabel: string;
  familyName: string;
  standard: string;
  category: string;
  system: "metric" | "inch";
  drives: string[];
  head: string;
  lengths: number[];
  haystack: string;
}

export interface Filters {
  query: string;
  category: string;
  system: string;
  standard: string;
  drive: string;
  head: string;
}

export const NO_FILTERS: Filters = { query: "", category: "", system: "", standard: "", drive: "", head: "" };

function catalogueEntries(f: Family): ListEntry[] {
  const system = unitsOf(f) === "in" ? "inch" : "metric";
  const drives = drivesOf(f);
  const head = headLabel(f);
  return f.sizes.map((row) => ({
    key: `${f.id}|${row.size}`,
    source: "catalogue" as const,
    familyId: f.id,
    size: row.size,
    sizeLabel: row.label ?? row.size,
    familyName: f.name,
    standard: f.standard,
    category: f.category,
    system,
    drives,
    head,
    lengths: lengthsFor(f, row),
    haystack: [f.name, f.standard, ...f.aka, f.category, head, ...drives.map((d) => PARTS.drive[d]?.label ?? d), row.size, row.label ?? "", system]
      .join(" ").toLowerCase(),
  }));
}

function specHead(spec: FastenerSpec): string {
  if (spec.kind === "nut") return PARTS.nut[spec.nut?.type ?? ""]?.label ?? "";
  if (spec.kind === "washer") return PARTS.washer[spec.washer?.type ?? ""]?.label ?? "";
  if (spec.kind === "insert") return PARTS.insert[spec.insert?.type ?? ""]?.label ?? "";
  return PARTS.head[spec.head?.type ?? ""]?.label ?? "";
}

export function customEntry(item: UserFastener): ListEntry {
  const spec = item.spec;
  const drives = spec.drive && spec.drive.type !== "none" ? [spec.drive.type] : [];
  const system = spec.units === "in" ? "inch" : "metric";
  const size = spec.thread?.designation ?? (spec.thread ? `${spec.thread.diameter}` : "");
  return {
    key: `custom|${item.id}`,
    source: "custom",
    customId: item.id,
    size,
    sizeLabel: size,
    familyName: spec.name,
    standard: spec.standard ?? "",
    category: CUSTOM_CATEGORY,
    system,
    drives,
    head: specHead(spec),
    lengths: typeof spec.length === "number" ? [spec.length] : [],
    haystack: [spec.name, spec.standard ?? "", spec.notes ?? "", CUSTOM_CATEGORY, specHead(spec), ...drives, size, system]
      .join(" ").toLowerCase(),
  };
}

let cached: ListEntry[] | null = null;

export function listEntries(custom: UserFastener[]): ListEntry[] {
  cached ??= FAMILIES.flatMap(catalogueEntries);
  return [...custom.map(customEntry), ...cached];
}

const SIZE_TOKEN = /^(m\d+(?:\.\d+)?|st\d+(?:\.\d+)?|#\d+|\d+\/\d+)(?:x(\d+(?:\.\d+)?))?$/i;

export interface ParsedQuery {
  words: string[];
  size?: string;
  length?: number;
}

/** "m3x10 socket" -> size M3, length 10, words ["socket"]. A size is matched exactly, so M2 is
 *  not M20. */
export function parseQuery(query: string): ParsedQuery {
  const out: ParsedQuery = { words: [] };
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const m = SIZE_TOKEN.exec(token);
    if (m && out.size === undefined) {
      out.size = m[1]!.toUpperCase();
      if (m[2]) out.length = Number(m[2]);
    } else {
      out.words.push(token.toLowerCase());
    }
  }
  return out;
}

export function filterEntries(entries: ListEntry[], filters: Filters): ListEntry[] {
  const q = parseQuery(filters.query);
  return entries.filter((e) => {
    if (filters.category && e.category !== filters.category) return false;
    if (filters.system && e.system !== filters.system) return false;
    if (filters.standard && e.standard !== filters.standard) return false;
    if (filters.drive && !e.drives.includes(filters.drive)) return false;
    if (filters.head && e.head !== filters.head) return false;
    if (q.size !== undefined && e.size.toUpperCase() !== q.size && !e.size.toUpperCase().startsWith(`${q.size}-`)) return false;
    if (q.length !== undefined && !e.lengths.some((l) => Math.abs(l - q.length!) < 1e-9)) return false;
    return q.words.every((w) => e.haystack.includes(w));
  });
}

export interface Facets {
  categories: string[];
  standards: string[];
  drives: string[];
  heads: string[];
}

export function facets(entries: ListEntry[]): Facets {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const categories = uniq(entries.map((e) => e.category)).sort(
    (a, b) => rank(a) - rank(b),
  );
  return {
    categories,
    standards: uniq(entries.map((e) => e.standard)).sort(),
    drives: uniq(entries.flatMap((e) => e.drives)).sort(),
    heads: uniq(entries.map((e) => e.head)).sort(),
  };
}

function rank(category: string): number {
  if (category === CUSTOM_CATEGORY) return -1;
  const i = CATEGORY_ORDER.indexOf(category);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

export interface Group {
  category: string;
  families: { title: string; standard: string; entries: ListEntry[] }[];
}

/** Entries grouped by category, then by family, in catalogue order. */
export function groupEntries(entries: ListEntry[]): Group[] {
  const groups = new Map<string, Map<string, { title: string; standard: string; entries: ListEntry[] }>>();
  for (const e of entries) {
    const byFamily = groups.get(e.category) ?? new Map();
    groups.set(e.category, byFamily);
    const famKey = e.source === "custom" ? CUSTOM_CATEGORY : e.familyId!;
    const fam = byFamily.get(famKey) ?? {
      title: e.source === "custom" ? "Your fasteners" : e.familyName,
      standard: e.source === "custom" ? "" : e.standard,
      entries: [],
    };
    byFamily.set(famKey, fam);
    fam.entries.push(e);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([category, fams]) => ({ category, families: [...fams.values()] }));
}
