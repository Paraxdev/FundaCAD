// Imported panoramas and saved environments, between the library, the viewport
// and the document.

import type { DocumentStore } from "../document/store";
import type { DocEnvironment, EmbeddedHdr } from "../document/docEnvironment";
import {
  decodeHdr,
  deflateBase64,
  downscaleEquirect,
  encodeRgbe,
  HdrRefusal,
  hdrSize,
  inflateBase64,
  sha256Hex,
  sphereThumbnailPixels,
  type HdrImage,
} from "../viewport/hdrImage";
import { hdrStoredWidth, heldHdr, registerHdr } from "../viewport/hdrRegistry";
import { createEnvLibrary, indexedDbKv, type EnvEntry, type EnvLibrary, type StoredHdr } from "./environmentLibrary";
import {
  applyEnvSettings,
  asEnvSettings,
  ENVIRONMENTS_LIST,
  envSettingsOf,
  hdrHashOf,
  onRenderPrefsChange,
  refreshRenderPrefs,
  renderPrefs,
  setRenderPref,
  type EnvSettings,
} from "./renderPrefs";

let lib: EnvLibrary | null = null;
export function envLibrary(): EnvLibrary {
  return (lib ??= createEnvLibrary(indexedDbKv()));
}
/** For tests. */
export function useEnvLibrary(next: EnvLibrary | null) {
  lib = next;
}

const libraryListeners = new Set<() => void>();
export function onEnvLibraryChange(fn: () => void): () => void {
  libraryListeners.add(fn);
  return () => libraryListeners.delete(fn);
}
function libraryChanged() {
  for (const fn of libraryListeners) fn();
}

/** The saved environment the look came from; the document names it while it lasts. */
let activeSaved: { id: string | null; name: string } | null = null;
export function activeSavedId(): string | null {
  return activeSaved?.id ?? null;
}
function setActiveSaved(next: { id: string | null; name: string } | null) {
  if (activeSaved?.id === next?.id && activeSaved?.name === next?.name) return;
  activeSaved = next;
  libraryChanged();
}

export function chooseBuiltInEnvironment(store: DocumentStore | null, id: EnvSettings["environment"]) {
  setActiveSaved(null);
  setRenderPref("environment", id);
  if (store) void syncDocumentEnvironment(store);
}

const names = new Map<string, string>();
export function hdrName(hash: string): string | null {
  return heldHdr(hash)?.name ?? names.get(hash) ?? null;
}

/** Stored at 2k (hdrStoredWidth), hashed, kept in the library and held for the renderer. */
export async function storeHdr(img: HdrImage, name: string, library = envLibrary()): Promise<StoredHdr> {
  const stored = downscaleEquirect(img, hdrStoredWidth());
  const rgbe = encodeRgbe(stored);
  const hash = await sha256Hex(rgbe);
  const rec: StoredHdr = { hash, name, width: stored.width, height: stored.height, rgbe };
  if (!(await library.getHdr(hash))) await library.putHdr(rec);
  names.set(hash, name);
  registerHdr(hash, name, stored);
  return rec;
}

export interface ImportOptions {
  /** Asked once the panorama is stored, true leaves the look as it was. */
  leftOut?: () => boolean;
  /** Told when the panorama was kept smaller than the file, with a sentence saying so. */
  onNote?: (note: string) => void;
}

/** The sentence for a panorama kept at `kept` from a `source` sized file, or null when nothing was dropped. */
export function keptSmallerNote(
  name: string,
  source: { width: number; height: number } | null,
  kept: { width: number; height: number },
): string | null {
  if (!source || source.width <= kept.width) return null;
  return (
    `${name} is ${source.width} x ${source.height}. It lights the scene from a ${kept.width} x ${kept.height} ` +
    `copy, the size kept for lighting and saved documents (Preferences, Experimental).`
  );
}

/** Light the viewport with an .hdr or .exr. Returns the refusal, or null. */
export async function importEnvironmentBytes(
  store: DocumentStore | null,
  bytes: Uint8Array,
  name: string,
  library = envLibrary(),
  opts: ImportOptions = {},
): Promise<string | null> {
  try {
    const img = await decodeHdr(bytes, name, hdrStoredWidth());
    const note = keptSmallerNote(name, hdrSize(bytes, name), img);
    const rec = await storeHdr(img, name, library);
    if (opts.leftOut) {
      // Ready before the look changes, so the document write that follows has no library read for an open to slip
      // into. Held only once the look is taken, the cache keeps the open document's panorama.
      const embed = store ? (embedded.get(rec.hash) ?? (await readEmbed(rec.hash, library))) : null;
      if (opts.leftOut()) return null;
      if (embed) holdEmbed(embed);
    }
    setActiveSaved(null);
    setRenderPref("environment", `hdr:${rec.hash}`);
    if (store) await syncDocumentEnvironment(store, library);
    if (note) opts.onNote?.(note);
    return null;
  } catch (err) {
    if (err instanceof HdrRefusal) return err.message;
    return `Couldn't use ${name} as the environment: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function importEnvironmentFile(
  store: DocumentStore | null,
  file: File,
  opts: ImportOptions = {},
): Promise<string | null> {
  return importEnvironmentBytes(store, new Uint8Array(await file.arrayBuffer()), file.name, envLibrary(), opts);
}

/** Make sure the panorama the settings name is decoded, then redraw. */
export async function ensureHdrLoaded(hash: string, library = envLibrary()): Promise<boolean> {
  if (heldHdr(hash)) return true;
  const rec = await library.getHdr(hash).catch(() => null);
  if (!rec) return false;
  const img = await decodeHdr(rec.rgbe, `${rec.name}.hdr`);
  names.set(hash, rec.name);
  registerHdr(hash, rec.name, img);
  refreshRenderPrefs();
  return true;
}

const embedded = new Map<string, EmbeddedHdr>();

async function embedFor(hash: string, library: EnvLibrary): Promise<EmbeddedHdr | null> {
  const held = embedded.get(hash);
  if (held) return held;
  const e = await readEmbed(hash, library);
  if (e) holdEmbed(e);
  return e;
}

async function readEmbed(hash: string, library: EnvLibrary): Promise<EmbeddedHdr | null> {
  const rec = await library.getHdr(hash);
  if (!rec) return null;
  return {
    name: rec.name,
    width: rec.width,
    height: rec.height,
    encoding: "rgbe-deflate-base64",
    sha256: rec.hash,
    data: deflateBase64(rec.rgbe),
  };
}

function holdEmbed(e: EmbeddedHdr) {
  embedded.clear();
  embedded.set(e.sha256, e);
}

/** What the document should carry for the current look: an imported panorama
 *  embedded, a saved environment by name, or nothing for a plain built in room. */
export async function documentEnvironmentFor(
  settings: EnvSettings,
  savedName: string | null,
  library = envLibrary(),
): Promise<DocEnvironment | null> {
  const hash = hdrHashOf(settings.environment);
  if (!hash && !savedName) return null;
  const env: DocEnvironment = { settings: { ...settings } };
  if (savedName) env.name = savedName;
  if (hash) {
    const hdr = await embedFor(hash, library);
    if (hdr) env.hdr = hdr;
  }
  return env;
}

let syncing: Promise<void> = Promise.resolve();

/** Serialised, and the look is read when its turn comes, so an embed still
 *  being prepared can never land after a newer one. */
export function syncDocumentEnvironment(
  store: DocumentStore,
  library = envLibrary(),
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const run = syncing.then(async () => {
    const env = await documentEnvironmentFor(envSettingsOf(renderPrefs()), activeSaved?.name ?? null, library);
    store.setDocumentEnvironment(env, opts);
  });
  syncing = run.catch(() => {});
  return run;
}

let applying = false;

/** Light the viewport the way an opened document was saved. */
export async function applyDocumentEnvironment(
  env: Readonly<DocEnvironment> | null,
  library = envLibrary(),
): Promise<void> {
  if (!env) return;
  const settings = asEnvSettings(env.settings, renderPrefs());
  const hash = hdrHashOf(settings.environment);
  if (hash && env.hdr && env.hdr.sha256 === hash && !heldHdr(hash)) {
    const rgbe = inflateBase64(env.hdr.data);
    const img = await decodeHdr(rgbe, env.hdr.name);
    if (!(await library.getHdr(hash).catch(() => null))) {
      await library.putHdr({ hash, name: env.hdr.name, width: img.width, height: img.height, rgbe }).catch(() => {});
    }
    names.set(hash, env.hdr.name);
    registerHdr(hash, env.hdr.name, img);
  } else if (hash) {
    await ensureHdrLoaded(hash, library);
  }
  if (hash && !heldHdr(hash)) return;
  const name = env.name ?? null;
  const entry = name ? (await library.list().catch(() => [])).find((e) => e.name === name) : undefined;
  setActiveSaved(name ? { id: entry?.id ?? null, name } : null);
  applying = true;
  try {
    applyEnvSettings(settings);
  } finally {
    applying = false;
  }
}

export const THUMB_SIZE = 128;

function canvasThumb(img: HdrImage): string {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = THUMB_SIZE;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.putImageData(new ImageData(sphereThumbnailPixels(img, THUMB_SIZE), THUMB_SIZE, THUMB_SIZE), 0, 0);
    return c.toDataURL("image/png");
  } catch {
    return "";
  }
}

const thumbs = new Map<string, string>();

/** The tile picture of a held panorama, a chrome ball in it, or "" until it is loaded. */
export function hdrThumb(hash: string): string {
  const had = thumbs.get(hash);
  if (had) return had;
  const h = heldHdr(hash);
  if (!h) return "";
  const t = canvasThumb(h.light);
  if (t) {
    if (thumbs.size > 8) thumbs.clear();
    thumbs.set(hash, t);
  }
  return t;
}

export function thumbFor(settings: EnvSettings): string {
  const hash = hdrHashOf(settings.environment);
  if (hash) return hdrThumb(hash);
  return ENVIRONMENTS_LIST.find((e) => e.id === settings.environment)?.swatch ?? "";
}

export async function saveEnvironmentAs(
  store: DocumentStore | null,
  name: string,
  library = envLibrary(),
): Promise<EnvEntry> {
  const settings = envSettingsOf(renderPrefs());
  const entry = await library.save(name, settings, thumbFor(settings));
  setActiveSaved({ id: entry.id, name: entry.name });
  libraryChanged();
  if (store) await syncDocumentEnvironment(store, library);
  return entry;
}

export async function applySavedEnvironment(store: DocumentStore | null, entry: EnvEntry, library = envLibrary()) {
  const hash = hdrHashOf(entry.settings.environment);
  if (hash && !(await ensureHdrLoaded(hash, library))) {
    throw new Error(`The panorama ${entry.name} lights with is no longer in the library.`);
  }
  setActiveSaved({ id: entry.id, name: entry.name });
  applyEnvSettings(asEnvSettings(entry.settings, renderPrefs()));
  if (store) await syncDocumentEnvironment(store, library);
}

export async function renameSavedEnvironment(id: string, name: string, library = envLibrary()) {
  const renamed = await library.rename(id, name);
  if (renamed && activeSaved?.id === id) setActiveSaved({ id, name: renamed.name });
  libraryChanged();
}

export async function deleteSavedEnvironment(id: string, library = envLibrary()) {
  await library.remove(id, hdrHashOf(renderPrefs().environment));
  if (activeSaved?.id === id) setActiveSaved(null);
  libraryChanged();
}

/** Load the panorama the stored settings name, keep the document's copy of
 *  the look current, and follow opened documents. */
export function installEnvironmentSync(store: DocumentStore): () => void {
  const hash = hdrHashOf(renderPrefs().environment);
  if (hash) {
    // A panorama gone from this machine's library, or unreadable, lights with the default room.
    void ensureHdrLoaded(hash)
      .catch(() => false)
      .then((ok) => {
        if (!ok) setRenderPref("environment", "studio");
      });
  }
  let look = JSON.stringify(envSettingsOf(renderPrefs()));
  const offPrefs = onRenderPrefsChange(() => {
    const next = JSON.stringify(envSettingsOf(renderPrefs()));
    if (next === look) return;
    look = next;
    if (!applying) void syncDocumentEnvironment(store).catch(() => {});
  });
  const offOpen = store.onOpen(() => {
    // onOpen fires before load() has restored the document's own state.
    queueMicrotask(() => {
      const env = store.documentEnvironment;
      const done = env
        ? applyDocumentEnvironment(env)
        : // Carried quietly: opening a document is not an edit, but its next save keeps this light.
          syncDocumentEnvironment(store, envLibrary(), { quiet: true });
      void done.catch(() => {});
    });
  });
  return () => {
    offPrefs();
    offOpen();
  };
}
