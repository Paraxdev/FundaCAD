import type { DocSummary, DocumentLibrary } from "./library";

export interface FakeFile {
  path: string;
  exists?: boolean;
  mtimeMs?: number;
  thumb?: string;
  /** Its history, none when left out; null stands for a file too old to summarise. */
  summary?: DocSummary | null;
}

export interface FakeLibrary extends DocumentLibrary {
  /** Every path a thumbs call asked for, in order. */
  readonly thumbRequests: string[];
}

const inside = (dir: string, path: string) => {
  const d = dir.replace(/[\\/]+$/, "");
  return path.length > d.length && path.startsWith(d) && /[\\/]/.test(path[d.length]!);
};

/** A disk made of a list, for the browser e2e, which has no Tauri. `picks` are
 *  the folders the folder dialog hands out, one per call. */
export function fakeLibrary(files: readonly FakeFile[], picks: readonly string[] = []): FakeLibrary {
  const queue = [...picks];
  const byPath = new Map(files.map((f) => [f.path, { ...f }]));
  const thumbRequests: string[] = [];
  const there = (path: string) => {
    const f = byPath.get(path);
    return f && f.exists !== false ? f : null;
  };
  return {
    thumbRequests,
    async stat(paths) {
      return paths.map((path) => {
        const f = there(path);
        return f
          ? { path, exists: true, mtimeMs: f.mtimeMs ?? null, size: 1 }
          : { path, exists: false, mtimeMs: null, size: null };
      });
    },
    async list(dir) {
      const found = [...byPath.values()].filter((f) => f.exists !== false && inside(dir, f.path));
      if (!found.length && !picks.includes(dir)) throw new Error(`${dir} was not found`);
      return { files: await this.stat(found.map((f) => f.path)), truncated: false };
    },
    async summary(path) {
      const f = there(path);
      if (!f) throw new Error(`${path} was not found`);
      if (f.summary === undefined) return { format: "funda", versions: [], branches: {}, current: "main" };
      return f.summary;
    },
    async pickFolder() {
      return queue.shift() ?? null;
    },
    async thumbs(paths) {
      thumbRequests.push(...paths);
      return paths.slice(0, 48).map((p) => there(p)?.thumb ?? null);
    },
    async putThumb(path, dataUrl) {
      const f = there(path);
      if (!f) throw new Error("the document is not on disk");
      f.thumb = dataUrl;
    },
  };
}
