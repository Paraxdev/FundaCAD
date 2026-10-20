export interface FileStat {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}

/** What Home reads from the disk. The desktop app answers through Rust, dev
 *  builds can swap in a fake for the browser e2e. */
export interface DocumentLibrary {
  stat(paths: string[]): Promise<FileStat[]>;
}

export const tauriLibrary: DocumentLibrary = {
  async stat(paths) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<FileStat[]>("library_stat", { paths });
  },
};

let current: DocumentLibrary | null =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriLibrary : null;

/** Null in the plain browser build, which has no paths to list. */
export function library(): DocumentLibrary | null {
  return current;
}

export function setLibrary(lib: DocumentLibrary | null): void {
  current = lib;
}
