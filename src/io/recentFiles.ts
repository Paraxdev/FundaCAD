// Recent-files list for the Home screen. Display concern → localStorage
// (same convention as the other fundacad.* keys); paths are not secrets. Newest
// first, deduped by path, capped.

import { readSetting } from "../ui/storedSetting";

const KEY = "fundacad.recentFiles";
const LEGACY_KEYS = ["neocad.recentFiles", "sindri.recentFiles"];
const MAX = 50;

export interface RecentFile {
  path: string;
  openedAt: number; // ms since epoch
}

export function getRecentFiles(): RecentFile[] {
  try {
    const list = JSON.parse(readSetting(KEY, ...LEGACY_KEYS) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((r): r is RecentFile => !!r && typeof r.path === "string" && typeof r.openedAt === "number");
  } catch {
    return [];
  }
}

export function noteRecent(path: string): void {
  const rest = getRecentFiles().filter((r) => r.path !== path);
  write([{ path, openedAt: Date.now() }, ...rest].slice(0, MAX));
}

/** Only the user removes an entry: a file on an offline drive is not gone. */
export function forgetRecent(path: string): void {
  write(getRecentFiles().filter((r) => r.path !== path));
}

function write(list: RecentFile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* blocked storage keeps the old list */
  }
}
