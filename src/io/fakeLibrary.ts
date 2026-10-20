import type { DocumentLibrary } from "./library";

export interface FakeFile {
  path: string;
  exists?: boolean;
  mtimeMs?: number;
  thumb?: string;
}

export interface FakeLibrary extends DocumentLibrary {
  /** Every path a thumbs call asked for, in order. */
  readonly thumbRequests: string[];
}

/** A disk made of a list, for the browser e2e, which has no Tauri. */
export function fakeLibrary(files: readonly FakeFile[]): FakeLibrary {
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
