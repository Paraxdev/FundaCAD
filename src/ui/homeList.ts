import type { RecentFile } from "../io/recentFiles";
import type { FileStat } from "../io/library";

export interface HomeEntry {
  path: string;
  name: string;
  folder: string;
  openedAt: number | null;
  editedAt: number | null;
  missing: boolean;
  open: boolean;
}

const parts = (path: string) => path.split(/[\\/]/);

export function displayName(path: string): string {
  const base = parts(path).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function folderPath(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut);
}

export function folderLabel(path: string): string {
  return parts(path).slice(0, -1).filter(Boolean).slice(-2).join("/");
}

export function buildEntries(
  recents: readonly RecentFile[],
  openPath: string | null,
  stats?: ReadonlyMap<string, FileStat>,
): HomeEntry[] {
  return recents.map((r) => {
    const st = stats?.get(r.path);
    return {
      path: r.path,
      name: displayName(r.path),
      folder: folderLabel(r.path),
      openedAt: r.openedAt,
      editedAt: st?.exists ? st.mtimeMs : null,
      missing: st ? !st.exists : false,
      open: r.path === openPath,
    };
  });
}

export type SortMode = "opened" | "edited" | "name";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const byName = (a: HomeEntry, b: HomeEntry) => fold(a.name).localeCompare(fold(b.name));

export function sortEntries(entries: readonly HomeEntry[], mode: SortMode): HomeEntry[] {
  const time = (e: HomeEntry) => (mode === "opened" ? e.openedAt : e.editedAt ?? e.openedAt) ?? 0;
  return [...entries].sort((a, b) => (mode === "name" ? 0 : time(b) - time(a)) || byName(a, b));
}

/** Every word of the query is somewhere in the text, case and accents ignored. */
export function matchesQuery(text: string, query: string): boolean {
  const hay = fold(text);
  return fold(query).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function filterEntries(entries: readonly HomeEntry[], query: string): HomeEntry[] {
  return entries.filter((e) => matchesQuery(`${e.name} ${e.folder}`, query));
}

/** A folder view's cards: what the listing found, with the open time where the document is also recent. */
export function folderEntries(
  files: readonly FileStat[],
  recents: readonly RecentFile[],
  openPath: string | null,
): HomeEntry[] {
  const opened = new Map(recents.map((r) => [r.path, r.openedAt]));
  return files.map((f) => ({
    path: f.path,
    name: displayName(f.path),
    folder: folderLabel(f.path),
    openedAt: opened.get(f.path) ?? null,
    editedAt: f.mtimeMs,
    missing: false,
    open: f.path === openPath,
  }));
}

/** A folder view has no open order of its own, so it sorts by edit time instead. */
export const folderSort = (mode: SortMode): SortMode => (mode === "opened" ? "edited" : mode);

/** The last name in a folder path, the whole path for a drive root. */
export function folderName(dir: string): string {
  return parts(dir).filter(Boolean).pop() ?? dir;
}
