export interface FileStat {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}

export interface FolderListing {
  files: FileStat[];
  /** The folder holds more documents than one listing returns (2000). */
  truncated: boolean;
}

/** What Home reads from the disk. The desktop app answers through Rust, dev
 *  builds can swap in a fake for the browser e2e. */
export interface DocumentLibrary {
  stat(paths: string[]): Promise<FileStat[]>;
  /** The documents in a folder and its subfolders, four levels deep. Rejects for a folder that is gone. */
  list(dir: string): Promise<FolderListing>;
  /** A folder the user picks, null when they cancel. */
  pickFolder(): Promise<string | null>;
  /** The cached preview of each path, null where there is none or the file changed since. At most 48 per call. */
  thumbs(paths: string[]): Promise<(string | null)[]>;
  putThumb(path: string, dataUrl: string): Promise<void>;
}

export const tauriLibrary: DocumentLibrary = {
  async stat(paths) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<FileStat[]>("library_stat", { paths });
  },
  async list(dir) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<FolderListing>("library_list", { dir });
  },
  async pickFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "Add folder to Home" });
    return typeof picked === "string" ? picked : null;
  },
  async thumbs(paths) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<(string | null)[]>("thumb_get", { paths });
  },
  async putThumb(path, dataUrl) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("thumb_put", { path, dataUrl });
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
