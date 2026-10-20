// The project folders the user added to Home. Only paths, the folders themselves
// are never touched: removing one from Home leaves it on disk.

const KEY = "fundacad.home.folders";
const MAX = 50;

export interface HomeFolder {
  path: string;
  addedAt: number;
}

export function getFolders(): HomeFolder[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    return list.filter((r): r is HomeFolder => {
      const ok = !!r && typeof r.path === "string" && r.path !== "" && typeof r.addedAt === "number" && !seen.has(r.path);
      if (ok) seen.add(r.path);
      return ok;
    });
  } catch {
    return [];
  }
}

/** False when the folder is already there or the list is full. */
export function addFolder(path: string): boolean {
  const list = getFolders();
  if (list.some((f) => f.path === path) || list.length >= MAX) return false;
  return write([...list, { path, addedAt: Date.now() }]);
}

export function removeFolder(path: string): void {
  write(getFolders().filter((f) => f.path !== path));
}

function write(list: HomeFolder[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
