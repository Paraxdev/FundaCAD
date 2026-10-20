import { library } from "./library";

type Source = () => string | null;

let source: Source | null = null;

/** The viewport's picture taker, set once the viewport exists. */
export function setThumbnailSource(fn: Source | null): void {
  source = fn;
}

/** Synchronous on purpose: a save captures before its first await, so the
 *  picture shows exactly what is being written. */
export function captureThumbnail(): string | null {
  if (!source || !library()) return null;
  try {
    return source();
  } catch (err) {
    console.warn("[home] preview capture failed", err);
    return null;
  }
}

export async function storeThumbnail(path: string, dataUrl: string | null): Promise<void> {
  const lib = library();
  if (!lib || !dataUrl) return;
  try {
    await lib.putThumb(path, dataUrl);
  } catch (err) {
    console.warn("[home] preview not stored", err);
  }
}

interface OpenedStore {
  readonly dirty: boolean;
  readonly filePath: string | null;
  onBuild(fn: (s: { building: boolean; result: unknown }) => void): () => void;
  onOpen(fn: () => void): () => void;
}

/** Fills the cache for a document opened without a fresh picture (an old file,
 *  one saved by another tool), once its first build is on screen. Only while
 *  the document is still the file, unchanged. */
export function captureAfterOpen(store: OpenedStore, path: string): void {
  const lib = library();
  if (!lib || !source) return;
  let replay = true;
  let done = false;
  const stop = () => {
    done = true;
    offBuild();
    offOpen();
  };
  const offOpen = store.onOpen(stop);
  const offBuild = store.onBuild((s) => {
    if (replay || done || s.building || !s.result) return;
    stop();
    requestAnimationFrame(() => void take());
  });
  replay = false;
  const same = () => !store.dirty && store.filePath === path;
  const take = async () => {
    if (!same()) return;
    let cached: (string | null)[];
    try {
      cached = await lib.thumbs([path]);
    } catch {
      return;
    }
    if (cached[0] || !same()) return;
    await storeThumbnail(path, captureThumbnail());
  };
}
