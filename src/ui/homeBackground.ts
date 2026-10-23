// Home's backdrop: the theme's paper, the dimmed workspace, or the user's picture. The picture is in IndexedDB on
// desktop too: the Tauri fs scope reaches no app data folder, and WebView2 keeps IndexedDB there anyway.

import { readSetting } from "./storedSetting";

export type HomeBackground = "paper" | "workspace" | "image";

export const HOME_BACKGROUNDS: readonly { id: HomeBackground; label: string }[] = [
  { id: "paper", label: "Paper" },
  { id: "workspace", label: "Workspace" },
  { id: "image", label: "Your own image" },
];

const KEY = "fundacad.homeBackground";
export const DEFAULT_HOME_BACKGROUND: HomeBackground = "paper";
export const HOME_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;
export const MAX_HOME_IMAGE_BYTES = 25 * 1024 * 1024;

export function asHomeBackground(v: unknown): HomeBackground | null {
  return v === "paper" || v === "workspace" || v === "image" ? v : null;
}

let current: HomeBackground = asHomeBackground(readSetting(KEY)) ?? DEFAULT_HOME_BACKGROUND;
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of listeners) fn();
};

export function getHomeBackground(): HomeBackground {
  return current;
}

export function setHomeBackground(v: HomeBackground) {
  const next = asHomeBackground(v);
  if (next === null || next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  notify();
}

/** Fires when the choice changes and when a new picture is stored. */
export function onHomeBackgroundChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The class Home's root wears. A picture that is not there yet falls back to the paper. */
export function homeBackgroundClass(bg: HomeBackground, imageUrl: string | null): string | undefined {
  if (bg === "workspace") return "bg-workspace";
  if (bg === "image" && imageUrl) return "bg-image";
  return undefined;
}

export function homeBackgroundStyle(bg: HomeBackground, imageUrl: string | null): Record<string, string> | undefined {
  return bg === "image" && imageUrl ? { "--home-image": `url("${imageUrl}")` } : undefined;
}

export interface HomeImageStore {
  get(): Promise<Blob | undefined>;
  put(image: Blob): Promise<void>;
}

export function memoryImageStore(): HomeImageStore {
  let image: Blob | undefined;
  return {
    get: async () => image,
    put: async (b) => {
      image = b;
    },
  };
}

export function indexedDbImageStore(name = "fundacad-home"): HomeImageStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("images")) req.result.createObjectStore("images");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opened = null;
        reject(req.error);
      };
    }));
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const tx = (await db()).transaction("images", mode);
    const req = op(tx.objectStore("images"));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? req.error);
      tx.onabort = () => reject(tx.error ?? new Error("Saving the Home picture was cancelled."));
    });
  };
  return {
    get: () => run<Blob | undefined>("readonly", (s) => s.get("image")),
    put: async (b) => {
      await run("readwrite", (s) => s.put(b, "image"));
    },
  };
}

let store: HomeImageStore | null = null;
const imageStore = () => (store ??= typeof indexedDB === "undefined" ? memoryImageStore() : indexedDbImageStore());

export function useHomeImageStore(s: HomeImageStore) {
  store = s;
}

export async function loadHomeImage(): Promise<Blob | undefined> {
  try {
    return await imageStore().get();
  } catch {
    return undefined;
  }
}

export type StoreResult = { ok: true } | { ok: false; error: string };

export async function storeHomeImage(image: Blob): Promise<StoreResult> {
  if (!(HOME_IMAGE_TYPES as readonly string[]).includes(image.type)) {
    return { ok: false, error: "Pick a PNG or JPEG picture." };
  }
  if (image.size > MAX_HOME_IMAGE_BYTES) return { ok: false, error: "That picture is over 25 MB." };
  if (typeof createImageBitmap === "function") {
    try {
      (await createImageBitmap(image)).close();
    } catch {
      return { ok: false, error: "That file could not be read as a picture." };
    }
  }
  try {
    await imageStore().put(image);
  } catch {
    return { ok: false, error: "The picture could not be saved." };
  }
  notify();
  return { ok: true };
}
