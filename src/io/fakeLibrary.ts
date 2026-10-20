import type { DocumentLibrary } from "./library";

export interface FakeFile {
  path: string;
  exists?: boolean;
  mtimeMs?: number;
}

/** A disk made of a list, for the browser e2e, which has no Tauri. */
export function fakeLibrary(files: readonly FakeFile[]): DocumentLibrary {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    async stat(paths) {
      return paths.map((path) => {
        const f = byPath.get(path);
        return f && f.exists !== false
          ? { path, exists: true, mtimeMs: f.mtimeMs ?? null, size: 1 }
          : { path, exists: false, mtimeMs: null, size: null };
      });
    },
  };
}
