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
