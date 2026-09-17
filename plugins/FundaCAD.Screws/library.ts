// The fasteners a person defines, kept in this browser's settings and carried between machines as a
// JSON file.

import { readSetting } from "fundacad";
import { specProblems, type FastenerSpec } from "./spec";

export const LIBRARY_KEY = "fundacad.screws.library";
export const FILE_FORMAT = "fundacad-fasteners";

export interface UserFastener {
  id: string;
  spec: FastenerSpec;
  created: number;
  updated: number;
}

export function loadLibrary(): UserFastener[] {
  const raw = readSetting(LIBRARY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter((it): it is UserFastener =>
      !!it && typeof it === "object" && typeof (it as UserFastener).id === "string" &&
      !!(it as UserFastener).spec && typeof (it as UserFastener).spec === "object");
  } catch {
    return [];
  }
}

export function saveLibrary(items: UserFastener[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({ version: 1, items }));
  } catch {
    // A full or blocked store keeps the items in memory for this session.
  }
}

export function newFastenerId(): string {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function exportLibrary(items: UserFastener[]): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, fasteners: items.map((it) => it.spec) }, null, 2);
}

/** The specs in a library file, each checked. A spec with problems is left out and said why. */
export function parseLibraryFile(text: string): { specs: FastenerSpec[]; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { specs: [], problems: ["the file is not JSON"] };
  }
  const obj = parsed as { format?: unknown; fasteners?: unknown };
  if (!obj || obj.format !== FILE_FORMAT || !Array.isArray(obj.fasteners)) {
    return { specs: [], problems: ["the file is not a fastener library"] };
  }
  const specs: FastenerSpec[] = [];
  const problems: string[] = [];
  obj.fasteners.forEach((raw, i) => {
    const spec = raw as FastenerSpec;
    const found = raw && typeof raw === "object" ? specProblems(spec) : ["not a fastener"];
    if (found.length) problems.push(`${(spec && typeof spec.name === "string" && spec.name) || `entry ${i + 1}`}: ${found.join("; ")}`);
    else specs.push(spec);
  });
  return { specs, problems };
}
