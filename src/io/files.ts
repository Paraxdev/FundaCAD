// File I/O: save/open the document JSON and export STEP/STL/3MF. Uses Tauri
// native dialogs + fs when running in the app; falls back to browser
// download/upload in a plain dev browser. Export always writes server-side: we
// get a path from the native save dialog and hand it to the engine, which
// writes the file directly (no fs round-trip through the webview).

import { suggestedSavePath } from "./saveFolder";
import type { CarriedSection, DocumentStore } from "../document/store";
import { asFeature } from "../types";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, ExportFormat, Feature, ImportFormat, PlaneDef } from "../types";
import { clearRecovery } from "./recovery";
import {
  clampTolerance, exportFileName, exportScopeFromSelection, FORMATS, isFlatFormat, isMeshFormat, lastExportDir, meshWire,
  loadExportSettings, rememberExportDir, saveExportSettings, type FlatSource,
} from "./exportSettings";
import { buildBodyTree, importTrees } from "../ui/browserTree";
import { referencedGeometry } from "../document/versions";
import { hashShapedStrings } from "../document/geometryRefs";
import { blake2b128Hex } from "../document/blake2b";
import { UnreadableDocumentError } from "../document/documentShape";
import { noteRecent } from "./recentFiles";
import { closeHome } from "../ui/home";
import { captureAfterOpen, captureThumbnail, storeThumbnail } from "./thumbnails";
import { BINARY_DOC_EXT, DOC_EXT, LEGACY_DOC_EXTS, isDocumentExt } from "./documentExt";
import { announceImportedBody } from "../plugins/contrib";
import { askImportUnit, asksForUnit, type ImportUnit } from "./importUnit";
import { importFeatures } from "./importSketches";
import {
  asHex, materialsForColors, nodeColors, parseLibrary, serializeLibrary,
} from "../document/materials";
import { importedBodyColors } from "../document/faceColors";
import { openNotices } from "../document/openNotice";
import type { FaceColorRuns } from "../types";

const isTauri = () => "__TAURI_INTERNALS__" in window;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every geometry hash the document references, and the mesh keys worth
 *  carrying. Rust turns these into container entries; the frontend collects them
 *  because it is the one that owns the document. */
function referencedHashes(store: DocumentStore): string[] {
  const out = new Set<string>();
  for (const f of store.document.features ?? []) {
    const imp = asFeature(f, "import");
    if (imp?.geom) out.add(imp.geom);
  }
  if (store.versionRepo) for (const h of referencedGeometry(store.versionRepo)) out.add(h);
  return [...out];
}

/** Write the document at `path`, as JSON or, for a `.fundab` path, the binary
 *  format; Rust decides from the extension. Returns an error message, or null on
 *  success.
 *
 *  Goes through the app, NOT the engine: a save that needed the geometry engine
 *  would be impossible while its worker is down, with unsaved work on screen. Saving needs no
 *  geometry anyway; the blobs are already bytes on disk. */
async function writeContainer(store: DocumentStore, path: string): Promise<string | null> {
  const picture = captureThumbnail();
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const doc = store.toObject();
    const hashes = referencedHashes(store);
    const optionalHashes = [...hashShapedStrings(doc)].filter((h) => !hashes.includes(h));
    await invoke("container_save", {
      path,
      documentJson: JSON.stringify(doc, null, 2),
      hashes,
      optionalHashes,
      meshKeys: [],
      carried: store.carriedSections,
    });
    void storeThumbnail(path, picture);
    return null;
  } catch (e) {
    return errMsg(e);
  }
}

/** Save: write to the current path if known, else behave like Save As. */
export async function saveDocument(store: DocumentStore) {
  if (isTauri() && store.filePath) {
    const err = await writeContainer(store, store.filePath);
    if (err) {
      await reportError(`Couldn't save ${store.filePath}: ${err}`);
      return;
    }
    store.markSaved(store.filePath);
    noteRecent(store.filePath);
    void clearRecovery(store.filePath); // the on-disk file is now the truth
  } else {
    await saveDocumentAs(store);
  }
}

/** Save As: always prompt for a path (or download in a plain browser). */
export async function saveDocumentAs(store: DocumentStore) {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      filters: [
        { name: "FundaCAD Document (JSON)", extensions: [DOC_EXT, ...LEGACY_DOC_EXTS] },
        { name: "FundaCAD Binary Document (smaller)", extensions: [BINARY_DOC_EXT] },
      ],
      defaultPath: suggestedSavePath(
        store.filePath,
        isDocumentExt(store.fileName.split(".").pop()?.toLowerCase()) ? store.fileName : `${store.fileName}.${DOC_EXT}`,
      ),
    });
    if (path) {
      const err = await writeContainer(store, path);
      if (err) {
        await reportError(`Couldn't save ${path}: ${err}`);
        return;
      }
      store.markSaved(path);
      noteRecent(path);
      void clearRecovery(path);
    }
  } else {
    // Reuse the name already settled on (mirrors the Tauri defaultPath logic
    // above), so a SECOND Save As in the same session downloads "Untitled.funda"
    // again rather than "Untitled.funda.funda": markSaved below makes fileName
    // return the downloaded name from here on.
    const name = store.filePath ? store.fileName : `${store.fileName}.${DOC_EXT}`;
    const built = await browserDocumentText(store);
    if ("refused" in built) {
      await reportError(built.refused);
      return;
    }
    downloadText(name, built.text);
    // No real path to save to, but the title bar reads store.fileName the same
    // way for both builds, and "Untitled*" forever after a successful download
    // read as the save having silently failed.
    store.markSaved(name);
  }
}

/** A browser save holds this much geometry at most: the file is built as one
 *  string, base64 adds a third, and V8 refuses a string past about 512 MiB. */
const MAX_BROWSER_GEOMETRY_BYTES = 256 * 1024 * 1024;

/** The .funda text the desktop app would write, built here because a browser
 *  has no Rust to embed the imports' geometry: it is read back from the engine's
 *  blob store. `refused` says why no file that opens whole could be built. */
async function browserDocumentText(store: DocumentStore): Promise<{ text: string } | { refused: string }> {
  const doc = store.toObject();
  const hashes = referencedHashes(store);
  const optionalHashes = [...hashShapedStrings(doc)].filter((h) => !hashes.includes(h));
  if (!hashes.length && !optionalHashes.length) return { text: JSON.stringify(doc, null, 2) };
  const backend = store.backend;
  const read = async (h: string) => (backend.blobGet ? backend.blobGet(h).catch(() => null) : null);
  const blobs = new Map<string, Uint8Array>();
  const missing: string[] = [];
  let total = 0;
  for (const h of hashes) {
    const bytes = await read(h);
    if (bytes) blobs.set(h, bytes);
    else missing.push(h);
    total += bytes?.length ?? 0;
  }
  if (missing.length) {
    const names = new Set<string>();
    for (const f of doc.features ?? []) {
      const imp = asFeature(f, "import");
      if (imp?.geom && missing.includes(imp.geom)) names.add(imp.name || imp.source || imp.id);
    }
    if (names.size < missing.length) names.add("an import in an earlier version");
    return {
      refused: `Couldn't save: the geometry of ${[...names].join(", ")} is not in the engine, so the file would open without it. Import it again, then save.`,
    };
  }
  for (const h of optionalHashes) {
    const bytes = await read(h);
    if (bytes) blobs.set(h, bytes);
    total += bytes?.length ?? 0;
  }
  if (total > MAX_BROWSER_GEOMETRY_BYTES) {
    return { refused: `Couldn't save: its imported geometry is ${Math.round(total / 1048576)} MB, more than the browser can put in one file. Save it in the desktop app.` };
  }
  const geometry: Record<string, string> = {};
  for (const h of [...blobs.keys()].sort()) geometry[h] = bytesToBase64(blobs.get(h)!);
  return { text: JSON.stringify(blobs.size ? { ...doc, geometry } : doc, null, 2) };
}

/** What Rust does on a desktop open: every embedded blob is checked against its
 *  hash, all of them before any is published, then handed to the engine. The
 *  text is returned unchanged, load() drops the `geometry` key itself. */
async function publishEmbeddedGeometry(store: DocumentStore, text: string): Promise<string | null> {
  if (!text.includes('"geometry"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const embedded = raw && typeof raw === "object" ? (raw as { geometry?: unknown }).geometry : undefined;
  if (embedded === undefined) return null;
  const damaged = (detail: string) => new UnreadableDocumentError("its embedded geometry is damaged", detail);
  if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) throw damaged("geometry is not an object");
  const blobs: Uint8Array[] = [];
  for (const [hash, data] of Object.entries(embedded)) {
    if (typeof data !== "string" || !/^[0-9a-f]{32}$/.test(hash)) throw damaged(`bad geometry entry ${hash}`);
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(data);
    } catch {
      throw damaged(`geometry ${hash} is not base64`);
    }
    if (blake2b128Hex(bytes) !== hash) {
      throw new UnreadableDocumentError("its geometry does not match its hash, so it was changed or damaged", `geometry ${hash} does not match its bytes`);
    }
    blobs.push(bytes);
  }
  if (!blobs.length) return null;
  const backend = store.backend;
  if (!backend.blobPut) return "this engine has no blob store";
  try {
    for (const b of blobs) await backend.blobPut(b);
  } catch (e) {
    return errMsg(e);
  }
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `mayReplace` is asked before a picked document takes the open one's place,
 *  never for a mesh or CAD file, which is imported into it. */
export async function openDocument(
  store: DocumentStore,
  geometry: GeometryBackend,
  mayReplace: () => Promise<boolean> = async () => true,
) {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      // MCAD-style: Open takes our document AND mesh/CAD files (imported as a
      // body), routed by extension below, so users can just "open" an STL.
      filters: [
        { name: "All supported", extensions: dialogExts([DOC_EXT, BINARY_DOC_EXT, ...LEGACY_DOC_EXTS, "json", ...IMPORT_EXTS]) },
        { name: "FundaCAD Document", extensions: dialogExts([DOC_EXT, BINARY_DOC_EXT, ...LEGACY_DOC_EXTS, "json"]) },
        { name: "Mesh / CAD", extensions: dialogExts(IMPORT_EXTS) },
      ],
    });
    if (typeof path !== "string") return;
    const ext = path.split(".").pop()?.toLowerCase();
    if (isDocumentExt(ext)) {
      if (!(await mayReplace())) return;
      await openDocumentAtPath(store, path, geometry);
    } else {
      closeHome();
      await importPath(store, geometry, path); // a mesh / CAD file → import as a body
    }
  } else {
    const picked = await uploadText();
    if (picked && (await mayReplace())) await openDocumentText(store, picked.name, picked.text);
  }
}

/** Open a document the app has as text with no path, picked in a browser or
 *  dropped on the window. */
export async function openDocumentText(store: DocumentStore, name: string, text: string): Promise<OpenOutcome> {
  let unpublished: string | null;
  try {
    unpublished = await publishEmbeddedGeometry(store, text);
    store.load(text);
  } catch (e) {
    await reportUnreadable(e);
    return "unreadable";
  }
  // No real path, but the name is enough for the title bar to show what is
  // open and drop the unsaved marker, same as a Tauri Open does.
  store.markSaved(name);
  await warnAboutOpen(store);
  if (unpublished) await reportError(`Opened ${name}, but its embedded geometry could not be handed to the engine, so its imports will not build: ${unpublished}.`);
  return "ok";
}

/** Open a dropped document the app has as a File with no path. The desktop app
 *  reads it in Rust like an Open does, so embedded geometry reaches the blob
 *  store and a binary .fundab opens; a plain browser reads it as text. */
export async function openDocumentBytes(store: DocumentStore, file: File, geometry?: GeometryBackend): Promise<OpenOutcome> {
  if (!isTauri()) return openDocumentText(store, file.name, await file.text());
  const { invoke } = await import("@tauri-apps/api/core");
  let opened: OpenedDocument;
  try {
    const r = await invoke<RustOpened & { wasContainer: boolean }>("container_open_bytes", new Uint8Array(await file.arrayBuffer()));
    opened = {
      text: r.document,
      wasContainer: r.wasContainer,
      repaired: r.repairedShards > 0 || r.usedBackupIndex,
      carried: r.carried ?? [],
    };
  } catch (e) {
    await reportError(`Couldn't open ${file.name}: ${errMsg(e)}`);
    return "unreadable";
  }
  return finishOpen(store, file.name, opened, geometry, null);
}

/** What happened when we tried to open a document.
 *  "unreadable" means the file is gone or corrupt, callers may forget it.
 *  "newerFormat" means the file is fine and this build is too old, so the
 *  recent-files entry must SURVIVE: dropping it would delete the one affordance
 *  the user has for finding the file again, in the same breath as telling them
 *  to upgrade. */
export type OpenOutcome = "ok" | "unreadable" | "newerFormat";

/** True if `text` is a ZIP archive rather than JSON, i.e. a v5 packaged
 *  document this build cannot read.
 *
 *  `readTextFile` decodes with a NON-FATAL TextDecoder, so a zip's invalid bytes
 *  become U+FFFD instead of throwing: the read SUCCEEDS and `JSON.parse` is what
 *  fails. The local-file header is pure ASCII ("PK" followed by two control
 *  bytes), so it survives that decode intact and we can diagnose from the text
 *  we already hold, no second read, and no binary fs permission (the webview
 *  has none, by design). Matching on "PK" alone is deliberate: it also catches
 *  the empty and spanned-archive headers, and anything starting "PK" is not a
 *  JSON document regardless. */
export function looksLikeContainer(text: string): boolean {
  return text.startsWith("PK") || text.startsWith("FUNDACAD");
}

/** Rewrite a pre-v5 document's inline base64 BREP into blob-store references.
 *  Returns the original text unchanged on ANY failure, this is an optimisation
 *  of the on-disk format, never a precondition for opening a file. */
async function migrateInlineGeometry(text: string, geometry: GeometryBackend): Promise<string> {
  try {
    const doc = JSON.parse(text) as CadDocument;
    const legacy = (doc.features ?? []).filter(
      (f): f is Extract<Feature, { type: "import" }> =>
        f.type === "import" && typeof f.brep === "string" && !f.geom,
    );
    if (!legacy.length) return text;

    const migrated = await geometry.migrateGeometry(
      legacy.map((f) => ({ id: f.id, brep: f.brep as string })),
    );
    if (!migrated.length) return text;

    const byId = new Map(migrated.map((m) => [m.id, m.geom]));
    for (const f of doc.features ?? []) {
      if (f.type !== "import") continue;
      const geom = byId.get(f.id);
      // Only drop the inline copy for features that actually got a hash; a body
      // that failed to migrate keeps its base64 and still rebuilds.
      if (geom) {
        f.geom = geom;
        delete f.brep;
      }
    }
    return JSON.stringify(doc);
  } catch {
    return text;
  }
}

/** Open a document at a known path (no dialog), shared by Open…
 *  and the Home screen's recent documents.
 *
 *  A v5 document is a ZIP and is read by Rust, which also extracts its geometry
 *  into the blob store before returning. A pre-v5 document is plain JSON and is
 *  read as text exactly as it always was.
 *
 *  NOTE on ordering: `store.load()` ends by firing a rebuild SYNCHRONOUSLY,
 *  before `markSaved(path)` below has run, so that first rebuild sees the
 *  PREVIOUS document's path. That is harmless here only because geometry is
 *  resolved by content hash out of the blob store, which needs no path at all.
 *  Do not add anything to the rebuild path that depends on `store.filePath`. */
/** Tell the person, once, that this document uses a plugin they do not have, or
 *  holds features this version does not know (document/openNotice.ts).
 *
 *  WHY A TOAST AND NOT A REFUSAL. The document is fine. Every value is in it,
 *  the save path writes them back untouched, and the features that do not need
 *  the plugin build exactly as they always did. What is missing is the code that
 *  turns one kind of feature into geometry, so the honest report is a heads-up
 *  with the plugin's name in it, not a dialog in the way of a file that opens.
 *
 *  Once per open, at the document level, rather than per feature. Thirty rows
 *  in History do not tell you what to install any better than one sentence does.
 *
 *  Longer than the default timeout on purpose: this one has an instruction in
 *  it, and a notice you are meant to ACT on has to outlast the glance. */
async function warnAboutOpen(store: DocumentStore) {
  const notices = openNotices(store.document, store.openedVersion);
  if (!notices.length) return;
  const { dismissToast, toast } = await import("../ui/toast");
  const ids = notices.map((n) => toast(n.message, { kind: n.kind, timeout: 12000, ...(n.detail ? { detail: n.detail } : {}) }));
  const off = store.onOpen(() => {
    off();
    for (const id of ids) if (id !== null) dismissToast(id);
  });
}

export async function openDocumentAtPath(
  store: DocumentStore,
  path: string,
  geometry?: GeometryBackend,
): Promise<OpenOutcome> {
  const base = path.split(/[\\/]/).pop() ?? path;
  const { invoke } = await import("@tauri-apps/api/core");
  let opened: OpenedDocument;
  try {
    const wasContainer = await invoke<boolean>("container_is_container", { path });
    // JSON goes through Rust too: it carries embedded geometry that has to reach
    // the blob store before the first rebuild asks for it.
    const r = await invoke<RustOpened>("container_open_checked", { path });
    opened = { text: r.document, wasContainer, repaired: r.repairedShards > 0 || r.usedBackupIndex, carried: r.carried ?? [] };
  } catch (e) {
    // Rust's container errors are already user-facing sentences (a newer
    // container format, a damaged archive, geometry that does not match its
    // manifest), so pass them through rather than wrapping them in ours.
    await reportError(`Couldn't open ${base}: ${errMsg(e)}`);
    return "unreadable";
  }
  return finishOpen(store, base, opened, geometry, path);
}

interface RustOpened {
  document: string;
  repairedShards: number;
  usedBackupIndex: boolean;
  carried?: CarriedSection[];
}

interface OpenedDocument {
  text: string;
  wasContainer: boolean;
  repaired: boolean;
  carried: CarriedSection[];
}

/** Load a document Rust has read. `path` is null for one dropped as bytes. */
async function finishOpen(
  store: DocumentStore,
  base: string,
  { text, wasContainer, repaired, carried }: OpenedDocument,
  geometry: GeometryBackend | undefined,
  path: string | null,
): Promise<OpenOutcome> {
  // One-way v4 -> v5, done on the PARSED text before `load()` rather than by
  // patching the store afterwards: patching would record an undo entry, mark a
  // freshly-opened document dirty, and fire a second rebuild. If anything here
  // fails, a dead engine, an unreadable legacy body, `text` is untouched and
  // the document opens exactly as it did before, still carrying its inline copy.
  if (!wasContainer && geometry) text = await migrateInlineGeometry(text, geometry);

  try {
    // Throws before mutating anything: load() parses first (store.ts), so a
    // file we can't read leaves the open document untouched.
    store.load(text);
  } catch (e) {
    if (looksLikeContainer(text)) {
      await reportError(
        `${base} was saved by a newer version of FundaCAD, which stores geometry in a ` +
          `packaged document this build can't read. Update FundaCAD to open it.`,
      );
      return "newerFormat";
    }
    await reportUnreadable(e);
    return "unreadable";
  }
  store.carriedSections = carried;
  // freshly opened == clean
  if (path) {
    store.markSaved(path);
    captureAfterOpen(store, path);
  } else store.markOpenedWithoutPath(base);
  // AFTER markSaved, so a document that needs a plugin still opens CLEAN. The
  // notice is about what this build can do with the file, never about the file
  // having been changed, and a freshly-opened document marked dirty would offer
  // to save over the original on the way out.
  await warnAboutOpen(store);
  if (path) noteRecent(path);
  if (geometry) void import("./fundaLinks").then((m) => m.checkLinks(store, geometry));
  if (repaired) {
    const { toast } = await import("../ui/toast");
    toast(`${base} was damaged on disk and its error correction repaired it. Save to write a clean copy.`, {
      kind: "warning",
      timeout: 12000,
    });
  }
  return "ok";
}

interface ExportViewport {
  selectionBodyIds(): string[];
  selectedFaceSketchPlane(): { plane: PlaneDef; faceId: number; anchor: { selector: unknown } } | null;
}

/** The selected sketch, else the selected flat face, as what a DXF or SVG export draws. */
export function flatSourceOf(store: DocumentStore, viewport: ExportViewport, featureId: string | null): FlatSource | null {
  const f = featureId ? store.document.features.find((x) => x.id === featureId) : undefined;
  if (f?.type === "sketch") return sketchFlatSource(store, f.id);
  const face = viewport.selectedFaceSketchPlane();
  if (!face) return null;
  const body = (face.anchor.selector as { body?: string }).body;
  return { face: face.anchor.selector, plane: face.plane, label: `${(body && store.bodyName(body)) || "part"} face` };
}

export function sketchFlatSource(store: DocumentStore, sketchId: string): FlatSource {
  const i = store.document.features.filter((x) => x.type === "sketch").findIndex((x) => x.id === sketchId);
  const f = store.document.features.find((x) => x.id === sketchId);
  return { sketch: sketchId, label: (f && "name" in f && typeof f.name === "string" && f.name) || `Sketch${i + 1}` };
}

/** File, Export: the selected bodies, or a selected sketch or flat face for DXF and SVG. */
export async function exportSelection(store: DocumentStore, geometry: GeometryBackend, viewport: ExportViewport) {
  const { useSelectionStore } = await import("../stores/selection");
  return exportModel(store, geometry, viewport.selectionBodyIds(), flatSourceOf(store, viewport, useSelectionStore().featureId));
}

/** `selected` is the viewport's selection as body ids, where the picker starts.
 *  `flat` is what a DXF or SVG export draws, `format` the format to start on. */
export async function exportModel(
  store: DocumentStore,
  geometry: GeometryBackend,
  selected: readonly string[] = [],
  flat: FlatSource | null = null,
  format?: ExportFormat,
) {
  const built = store.buildState.result?.bodies ?? [];
  const bodies = built.map((b) => ({ id: b.id, name: store.bodyName(b.id) ?? b.name }));
  const docName = store.fileName === "Untitled" ? "" : store.fileName.replace(/\.[^.]+$/, "");
  const { groups } = buildBodyTree(built, importTrees(store.document), store.bodyElements, store.bodyElementMap());
  const start = exportScopeFromSelection(selected, bodies, groups, docName);
  const { useExportDialogStore } = await import("../stores/exportDialog");
  const choice = await useExportDialogStore().open({
    bodies, scope: start.scope, selected: start.selected,
    ...(flat ? { flat: { label: flat.label } } : {}), ...(format ? { format } : {}),
  });
  if (!choice) return;
  const { settings, scope } = choice;
  // The dialog offers DXF and SVG only with a 2D source, so the next plain
  // export would drop either for the default rather than the last 3D format.
  saveExportSettings(isFlatFormat(settings.format) ? { ...settings, format: loadExportSettings().format } : settings);
  if (!isTauri()) {
    // The engine writes an export straight to a path on disk (see the file
    // header), a plain browser has no such path to hand it and no protocol for
    // getting the bytes back instead, so this needs the desktop app rather than
    // a fallback that would quietly produce nothing, as it did before.
    await reportError("Export needs the desktop app: a browser tab has no filesystem path to give the engine to write to.");
    return;
  }
  const opts: {
    body?: string; bodies?: string[]; separate?: boolean;
    sketch?: string; face?: unknown; plane?: PlaneDef; tolerance?: number;
  } = {};
  const drawn = isFlatFormat(settings.format) ? flat : null;
  if (drawn) {
    if ("sketch" in drawn) opts.sketch = drawn.sketch;
    else Object.assign(opts, { face: drawn.face, plane: drawn.plane });
    opts.tolerance = clampTolerance(settings.tolerance);
  } else {
    if (scope === "separate" || scope === "selected-separate") opts.separate = true;
    if (scope === "selected" || scope === "selected-separate") opts.bodies = start.selected;
    else if (scope !== "all" && scope !== "separate") opts.body = scope;
  }

  const kind = FORMATS.find((f) => f.value === settings.format) ?? FORMATS[0]!;
  const base = drawn
    ? drawn.label
    : opts.body
    ? store.bodyName(opts.body) ?? docName
    : (opts.bodies ? start.base : docName) || (opts.separate || opts.bodies ? "parts" : "part");
  const name = exportFileName(base, kind.ext);
  const dir = lastExportDir();
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    filters: [{ name: kind.label, extensions: dialogExts(kind.exts) }],
    // "separate" derives one file per body as "<base>-<body>.<ext>", so name the base.
    defaultPath: dir ? `${dir}/${name}` : name,
  });
  if (!path) return;
  rememberExportDir(path);
  const fmt = settings.format;
  // GLB carries one material per body, so it needs the palette and each body's
  // slot; the other formats ignore both.
  // Wrapped exactly like importPath's runBusy below, and for the same reason:
  // an export replays the whole feature history, so on a large document it runs
  // for as long as an import does with nothing on screen to show it and nothing
  // for Cancel to attach to. onStarted hands back the request id so a cancel
  // targets THIS export, the document stays editable meanwhile, so any rebuild
  // the user triggers would otherwise be the "most recent" op.
  const res = await store.runBusy(
    `Exporting ${path.split(/[\\/]/).pop() ?? "file"}`,
    (onStarted) => geometry.export(store.document, fmt, path, {
      ...opts,
      palette: store.colorPalette,
      bodyColors: store.bodyColorsMap(),
      ...(isMeshFormat(fmt) ? { mesh: meshWire(settings) } : {}),
    }, onStarted),
  );
  if (!res.ok) {
    // The user stopped it: they know, so say nothing. Reporting their own
    // action back as "Export failed: cancelled" is the bug this avoids.
    if (res.cancelled) return;
    await reportError(`Export failed: ${res.message ?? "unknown error"}`);
    return;
  }
  // Confirm what was written, list every file for "separate", the single path
  // otherwise, and NAME any features whose geometry is missing from the export
  // (export-what-built: one red feature no longer blocks the whole print loop).
  const written = res.paths?.length ? res.paths : res.path ? [res.path] : [];
  const lines = [...written];
  for (const w of res.warnings ?? []) {
    lines.push(`Warning: ${w.feature_id ?? "feature"} failed, its result is NOT in the export: ${w.message}`);
  }
  if (lines.length) {
    const { listModal } = await import("../ui/choice");
    const title = res.warnings?.length
      ? `Exported ${written.length} file${written.length === 1 ? "" : "s"}, with warnings`
      : `Exported ${written.length} file${written.length === 1 ? "" : "s"}`;
    await listModal(title, lines);
  }
}

export function extToFormat(path: string): ExportFormat {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  // NOTE: this function is TOTAL, an unrecognised extension falls through to
  // STEP rather than erroring. Miss a format here and the user gets a STEP file
  // wearing the extension they asked for, with no error anywhere.
  if (ext === "glb") return "glb";
  if (ext === "dxf") return "dxf";
  if (ext === "svg") return "svg";
  return "step";
}

// This file writes the formats the app itself understands. A format a plugin
// owns is written by that plugin's exporter in the geometry engine, reached
// through GeometryBackend.exportWith.

/** Lower case only, every lookup lower-cases the name first (dropRouting, the
 *  two mappers above). */
export const IMPORT_EXTS = ["stl", "3mf", "step", "stp", "stpz", "gz", "xbf", "iges", "igs", "brep", "fcstd", "3dm", "ifc", "dxf", "obj", "ply", "off", "amf", "glb", "gltf", "wrl", "wrz", "x3d", "x3dz", "fbx", "3ds", "svg"];

// FreeCAD writes .FCStd.
const MIXED_CASE_EXTS = ["FCStd"];

/** GTK file dialogs on Linux match case, so a list handed to one offers each
 *  extension in lower and upper case. */
export function dialogExts(exts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of exts) {
    out.add(e.toLowerCase());
    out.add(e.toUpperCase());
  }
  for (const m of MIXED_CASE_EXTS) if (out.has(m.toLowerCase())) out.add(m);
  return [...out];
}

/** Import an external mesh / B-rep file (STL / 3MF / STEP / IGES / XBF / FreeCAD / OBJ / PLY / OFF / AMF / glTF / VRML / X3D / FBX) as a new body.
 *  The engine reads the file by path and returns an embeddable BREP payload, so
 *  this needs the native app (a real filesystem path), like export. */
export async function importModel(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    // Only a drop reaches the engine's bytes form of import (importFileBytes),
    // this picker has no browser file input behind it.
    await reportError("Import needs the desktop app: a browser tab has no filesystem path to give the engine to read.");
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    filters: [
      { name: "All supported", extensions: dialogExts(IMPORT_EXTS) },
      { name: "STL", extensions: dialogExts(["stl"]) },
      { name: "3MF", extensions: dialogExts(["3mf"]) },
      { name: "STEP", extensions: dialogExts(["step", "stp", "stpz", "gz"]) },
      { name: "IGES", extensions: dialogExts(["iges", "igs"]) },
      { name: "BREP", extensions: dialogExts(["brep"]) },
      { name: "OCCT XBF", extensions: dialogExts(["xbf"]) },
      { name: "FreeCAD", extensions: dialogExts(["fcstd"]) },
      { name: "Rhino 3DM", extensions: dialogExts(["3dm"]) },
      { name: "IFC (buildings)", extensions: dialogExts(["ifc"]) },
      { name: "DXF (AutoCAD)", extensions: dialogExts(["dxf"]) },
      { name: "SVG (drawing)", extensions: dialogExts(["svg"]) },
      { name: "OBJ", extensions: dialogExts(["obj"]) },
      { name: "PLY", extensions: dialogExts(["ply"]) },
      { name: "OFF", extensions: dialogExts(["off"]) },
      { name: "AMF", extensions: dialogExts(["amf"]) },
      { name: "glTF", extensions: dialogExts(["glb", "gltf"]) },
      { name: "VRML", extensions: dialogExts(["wrl", "wrz"]) },
      { name: "X3D", extensions: dialogExts(["x3d", "x3dz"]) },
      { name: "FBX (Maya, 3ds Max)", extensions: dialogExts(["fbx"]) },
      { name: "3DS (old 3ds Max)", extensions: dialogExts(["3ds"]) },
    ],
  });
  if (typeof path !== "string") return;
  await importPath(store, geometry, path);
}

/** The path of the most recently CANCELLED import, so a retry is one click.
 *  Session state on purpose, it never touches the document, so nothing about a
 *  cancelled import can be saved, shared, or opened on another machine. */
let lastCancelledImport: string | null = null;

/** The path a cancelled import used, or null. */
export function cancelledImportPath(): string | null {
  return lastCancelledImport;
}

// Viewport capability, MEASURED post-Phase-A on real WebKitGTK: about 60 fps at
// 1,000 bodies, falling to 27-37 fps at 3,060. The residual is draw-call bound
// at 2 calls per body, which is why the threshold is a BODY count and not a
// triangle count. Merging draw calls across bodies is the only lever left and it
// breaks three shipped invariants (per-body `.visible`, etag reuse, move-ghost
// translation), so these numbers are the honest limit rather than a bug.
const SMOOTH_BODY_LIMIT = 1000;
const SLOW_BODY_LIMIT = 3000;

/** What to tell the user about a document this size, or null when it will be
 *  fine. Separated from the import flow so the thresholds can be tested without
 *  a dialog, a backend or a viewport.
 *
 *  The point is to say what the document will be like BEFORE the viewport is
 *  built. The counts are known at import time, so the alternative to saying it
 *  is letting the user discover it as a freeze and conclude the app is broken. */
export function describeImportCapability(bodies: number): string | null {
  if (!Number.isFinite(bodies) || bodies <= SMOOTH_BODY_LIMIT) return null;
  const n = bodies.toLocaleString();
  if (bodies <= SLOW_BODY_LIMIT) {
    return `Imported ${n} bodies. The 3D view is smooth to about ${SMOOTH_BODY_LIMIT.toLocaleString()} bodies, so orbiting may lag a little. Everything still works.`;
  }
  return `Imported ${n} bodies. Expect the 3D view to be slow: measured 27-37 fps at ${SLOW_BODY_LIMIT.toLocaleString()} bodies against 60 at ${SMOOTH_BODY_LIMIT.toLocaleString()}. Modelling, export and printing are unaffected.`;
}

/** Bodies an import feature will produce: one per assembly leaf, or a single
 *  body when the file carried no tree. */
export function importedBodyCount(res: { parts?: { node: number; faces: number }[] }): number {
  return res.parts?.length ?? 1;
}


/** Import the file at `path`: read it, add the feature, adopt what it looked
 *  like. The whole of an import except choosing the file, which is why the
 *  dialog above and the Open dialog both end here.
 *
 *  Exported for the harness that has a path and no dialog (e2e/*.cjs). Not a
 *  second door: it is the same one, minus the picker. */
export async function importPath(
  store: DocumentStore,
  geometry: GeometryBackend,
  path: string,
  unit?: ImportUnit,
  opts: { source?: string } = {},
) {
  const fmt = extToImportFormat(path);
  await importWith(store, path, fmt, (onStarted, u) => geometry.importGeometry(path, fmt, onStarted, u), { ...opts, unit });
}

/** Files above this cannot reach the engine as one base64 message, its frame
 *  cap is 128 MiB. */
export const MAX_DROPPED_IMPORT_BYTES = 90 * 1024 * 1024;

/** Import a file the app has as bytes only, like one dropped on a browser tab.
 *  Its `source` is the bare name, there is no path to remember. */
export async function importFileBytes(store: DocumentStore, geometry: GeometryBackend, file: File, unit?: ImportUnit) {
  const fmt = extToImportFormat(file.name);
  const importBytes = geometry.importBytes?.bind(geometry);
  if (!importBytes) {
    await reportError(`Couldn't import ${file.name}: this geometry backend reads files by path only.`);
    return;
  }
  if (file.size > MAX_DROPPED_IMPORT_BYTES) {
    await reportError(`Couldn't import ${file.name}: it is ${Math.round(file.size / 1048576)} MB, a dropped file can be 90 MB at most here. Use File > Import in the desktop app.`);
    return;
  }
  await importWith(
    store,
    file.name,
    fmt,
    async (onStarted, u) => importBytes(file.name, fmt, bytesToBase64(new Uint8Array(await file.arrayBuffer())), onStarted, u),
    { unit, retryable: false },
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function importWith(
  store: DocumentStore,
  path: string,
  fmt: ImportFormat,
  read: (onStarted: (id: string) => void, unit?: ImportUnit) => ReturnType<GeometryBackend["importGeometry"]>,
  opts: { unit?: ImportUnit | undefined; source?: string; retryable?: boolean } = {},
) {
  let unit = opts.unit;
  if (asksForUnit(fmt) && !unit) {
    const picked = await askImportUnit(fmt);
    if (!picked) return;
    unit = picked;
  }
  // runBusy is what makes the operation VISIBLE and stoppable: an import used to
  // run with no busy state at all, so the timeline showed nothing and there was
  // nothing for a Cancel button to attach to. onStarted hands back the request
  // id so a cancel targets this import specifically.
  const res = await store.runBusy(
    `Importing ${path.split(/[\\/]/).pop() ?? "file"}`,
    (onStarted) => read(onStarted, unit),
    { holdHistory: true },
  );
  if (!res.ok) {
    if (res.cancelled) {
      // The user stopped it: say nothing (they know) and add NOTHING to the
      // document. The path is remembered in SESSION state only, a placeholder
      // feature would persist into the saved document and reference a path that
      // may not exist on another machine.
      lastCancelledImport = opts.retryable === false ? null : path;
      return;
    }
    await reportError(`Couldn't import ${path.split(/[\\/]/).pop()}: ${res.message ?? "unreadable file"}`);
    return;
  }
  lastCancelledImport = null;
  const features = importFeatures(res, { format: fmt, source: opts.source ?? path, taken: store.document.features.map((f) => f.id) });
  store.addFeatures(features);
  const imported = features.find((f) => f.type === "import");
  if (!imported) {
    if (res.notes?.length) {
      const { toast } = await import("../ui/toast");
      toast(res.notes.join(". "), { kind: "info" });
    }
    return;
  }
  const id = imported.id;

  // Say what the document will be like while the user is still deciding what to
  // do with it, rather than letting them discover it as a freeze and conclude
  // the app is broken. Non-blocking on purpose: this is a heads-up about a
  // measured limit, not a refusal, and everything except orbiting is unaffected.
  const capability = describeImportCapability(importedBodyCount(res));
  if (capability) {
    const { toast } = await import("../ui/toast");
    toast(capability, { kind: "info" });
  }

  // The file's own colours become materials, and the bodies it produced wear
  // them. This is the half of an import that used to be thrown away: a STEP
  // assembly's product colours were read by the engine, carried in the
  // manifest, and then never looked at, so a file that arrived fully coloured
  // opened as three thousand identical grey bodies.
  const source = importSource(imported);
  if (!(await adoptImportedColors(store, id, res, { joinImport: true, source }))) recolorOnRedo(store, imported, res);

  // The file carried ONE dominant colour. Say so, and let whoever has a use for
  // it decide.
  //
  // This used to be the decision itself: match the colour to the nearest slot of
  // the document's palette and assign the imported bodies to it, unless the
  // capability that owns palettes was switched off, in which case do nothing.
  // Three things this file has no business knowing were in those six lines. What
  // is left is the fact, an import landed, it was this feature, it looked like
  // this, which is true whether or not anybody is listening.
  //
  // Awaited rather than fired off, because a listener has to rebuild before it
  // can find the bodies the feature produced, and an import that returned while
  // that was still running would report itself finished too early.
  if (res.color === undefined) return;
  await announceImportedBody(id, res.color);
}

const importSource = (f: Feature) =>
  f.type === "import" ? (f as Extract<Feature, { type: "import" }>).source : undefined;

/** An import undone while its rebuild ran put its colours on nothing. Its redo
 *  puts them on then, as part of that same step, or never. */
export function recolorOnRedo(store: DocumentStore, feature: Feature, res: Parameters<typeof adoptImportedColors>[2]) {
  // Note: an edit can hand a new feature the import's id, so only an undo or redo
  // (a rewind, emitted just before its doc change) may bring the import back.
  let rewound = false;
  const offRewind = store.onRewind(() => {
    rewound = true;
    queueMicrotask(() => (rewound = false));
  });
  let offDoc: (() => void) | null = null;
  offDoc = store.onDocChange(() => {
    if (!offDoc) return;
    const back = store.document.features.find((f) => f.id === feature.id);
    if (!rewound || back || !store.canRedo) {
      offRewind();
      offDoc();
    }
    if (rewound && back) {
      const source = importSource(feature);
      queueMicrotask(() => {
        adoptImportedColors(store, feature.id, res, { joinImport: true, only: true, source }).catch((e) =>
          console.warn("import colours not put back", e),
        );
      });
    }
  });
}

/** Make materials out of the colours an import carried, and put them on the
 *  bodies it produced.
 *
 *  The IO half of document/materials.ts's `materialsForColors`, which is where
 *  the decision (match an existing material, or mint one, and what to call it)
 *  actually lives. What is here is the part that cannot be pure: the bodies do
 *  not exist until the rebuild runs and hands out their ids, so the import
 *  has to wait for the build and then find its own bodies in the result.
 *
 *  TWO WAYS A BODY IS FOUND, because there are two kinds of import. An assembly
 *  body carries `nodeRef` naming the product it came from, and that is what
 *  binds it to a per-part colour. A single-body import has no tree, so its one
 *  colour goes on whatever bodies the feature owns, which `faceOwners` answers.
 *
 *  The assignments are one undo step. With `joinImport` they join the step that
 *  added the feature while that step is still the newest, and with `only` they go
 *  on only then. False when the feature was not in the document after the build,
 *  true without a write when another document was opened meanwhile. */
export async function adoptImportedColors(
  store: DocumentStore,
  featureId: string,
  res: {
    color?: string | undefined;
    nodes?: { name: string; parent: number | null; color?: string }[] | undefined;
    parts?: { node: number; faces: number; faceColors?: FaceColorRuns; color?: string }[] | undefined;
  },
  opts: { joinImport?: boolean; only?: boolean; source?: string | undefined } = {},
): Promise<boolean> {
  const perNode = res.nodes ? nodeColors(res.nodes) : null;
  // Normalised once, here, because it is the KEY into the map materialsForColors
  // hands back and that map is keyed by the normalised form. nodeColors already
  // returns it; a single dominant colour comes straight off the wire.
  const single = perNode ? null : asHex(res.color);
  const wanted: { color: string; name?: string | undefined }[] = [];
  if (perNode) {
    for (const c of perNode) if (c) wanted.push({ color: c });
  } else if (single) {
    wanted.push({ color: single });
  }
  // The file's FACE colours, which on a file written by a mechanical CAD system
  // is where the colour actually is: the reference board styles all 1,803 of its
  // faces and leaves its 29 products wearing a default nobody chose. Every one
  // of them has to be in the library, not just the one each body wears, because
  // the faces that DISAGREE with their body are the red circuit board.
  for (const p of res.parts ?? []) {
    const own = asHex(p.color);
    if (own) wanted.push({ color: own });
    if (!p.faceColors) continue;
    for (const hex of p.faceColors.palette ?? []) {
      const c = asHex(hex);
      if (c) wanted.push({ color: c });
    }
  }
  if (!wanted.length) return true;

  const { add, byColor } = materialsForColors(wanted, store.materialLibrary);
  if (add.length) store.importMaterials(add);

  let opened = false;
  const offOpen = store.onOpen(() => (opened = true));
  await store.rebuildNow().finally(offOpen);
  if (opened) return true;
  const bodies = store.buildState.result?.bodies ?? [];
  // Note: after an undo nextId() hands this id to the next feature drawn, so the
  // id alone does not say the import is still there.
  const feature = store.document.features.find((f) => f.id === featureId);
  if (!feature || feature.type !== "import") return false;
  if (opts.source !== undefined && importSource(feature) !== opts.source) return false;
  const picks = importedBodyColors(bodies, [feature], (id) => store.importColorSource(id));
  // One batched write per material, not one per body: an assembly is thousands
  // of bodies and every write re-emits the build.
  const byMaterial = new Map<string, string[]>();
  const claim = (bodyId: string, hex: string | undefined) => {
    const material = hex ? byColor.get(hex) : undefined;
    if (!material) return;
    const list = byMaterial.get(material);
    if (list) list.push(bodyId);
    else byMaterial.set(material, [bodyId]);
  };
  for (const b of bodies) {
    const slash = b.nodeRef ? b.nodeRef.lastIndexOf("/") : -1;
    if (perNode && slash > 0 && b.nodeRef!.slice(0, slash) === featureId) {
      // Body against faces is decided in document/faceColors.ts, by the
      // feature's colorSource.
      const pick = picks.get(b.id);
      claim(b.id, asHex(pick?.color) ?? perNode[Number(b.nodeRef!.slice(slash + 1))]);
    } else if (!perNode && b.faceOwners?.some((owner) => owner === featureId)) {
      claim(b.id, single ?? undefined);
    }
  }
  const has = (d: { features: { id: string }[] }) => d.features.some((f) => f.id === featureId);
  store.undoAsOne(
    () => { for (const [material, ids] of byMaterial) store.setBodiesMaterial(ids, material); },
    opts.joinImport ? (before) => !has(before) && has(store.document) : undefined,
    { only: !!opts.only },
  );
  return true;
}

/** Surface an error to the user, a native dialog in the app, console otherwise.
 *  (Import used to fail silently, which read as "nothing happened".)
 *
 *  Exported for the capabilities that write files of their own. Not because
 *  this is where such a helper belongs, but because a plugin re-implementing it
 *  would be a second answer to "what does a failed write look like", and two
 *  answers is how one of them ends up being a console warning nobody sees. */
/** A document load() refused, in words for people. The technical reason goes
 *  with the notice's log entry rather than into the sentence. */
async function reportUnreadable(e: unknown) {
  const reason = e instanceof UnreadableDocumentError ? e.reason : "part of it could not be read";
  await reportError(`This file is not a FundaCAD document, or it is damaged: ${reason}.`, errMsg(e));
}

export async function reportError(msg: string, detail?: string) {
  if (isTauri()) {
    if (detail) console.error(detail);
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(msg, { title: "FundaCAD", kind: "error" });
  } else {
    // No native dialog here, so this goes through the same title bar error
    // notice every other error in the app uses (ui/toast.ts -> ui/errorNotice.ts),
    // instead of a console.error nobody but a developer would ever see.
    console.error(detail ? `${msg} (${detail})` : msg);
    const { toast } = await import("../ui/toast");
    toast(msg, { kind: "error", detail });
  }
}

export function extToImportFormat(path: string): ImportFormat {
  const parts = path.toLowerCase().split(".");
  if (parts.length > 2 && parts[parts.length - 1] === "gz") parts.pop();
  const ext = parts.pop();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  if (ext === "obj") return "obj";
  if (ext === "brep") return "brep";
  if (ext === "xbf") return "xbf";
  if (ext === "glb") return "glb";
  if (ext === "iges" || ext === "igs") return "iges";
  if (ext === "fcstd") return "fcstd";
  if (ext === "3dm") return "3dm";
  if (ext === "ifc") return "ifc";
  if (ext === "dxf") return "dxf";
  if (ext === "svg") return "svg";
  if (ext === "gltf") return "gltf";
  if (ext === "ply") return "ply";
  if (ext === "off") return "off";
  if (ext === "amf") return "amf";
  if (ext === "wrl" || ext === "wrz") return "vrml";
  if (ext === "x3d" || ext === "x3dz") return "x3d";
  if (ext === "fbx") return "fbx";
  if (ext === "3ds") return "3ds";
  return "step";  // TOTAL, like extToFormat above, see the note there
}

// --- material library ---
//
// A plain JSON file, not the document container: the point of a library is that
// it travels between documents and between people, and a format only this app
// can open would make "export" a word for "back up". See document/materials.ts
// for the shape; both directions go through it, so what is written is what can
// be read back.

/** The extension a library file gets. Not `.json` alone, so a folder of them is
 *  legible and the picker can default to the right thing. */
export const MATERIAL_LIB_EXT = "fcmat.json";

/** Write the document's material library to a file the user picks. */
export async function exportMaterialLibrary(store: DocumentStore) {
  const text = serializeLibrary(store.materialLibrary);
  const name = `${store.fileName === "Untitled" ? "materials" : store.fileName}.${MATERIAL_LIB_EXT}`;
  if (!isTauri()) {
    downloadText(name, text);
    return;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    filters: [{ name: "Material library", extensions: ["json"] }],
    defaultPath: name,
  });
  if (!path) return;
  try {
    await (await import("@tauri-apps/plugin-fs")).writeTextFile(path, text);
  } catch (e) {
    await reportError(`Couldn't write ${path}: ${errMsg(e)}`);
  }
}

/** Read a library file and MERGE it into the document's, by id. Returns what
 *  happened, so the caller can say so; null when the user cancelled.
 *
 *  Merging rather than replacing is the store's rule, see importMaterials, and
 *  the reason is here: a replace would unassign every body wearing a material
 *  the incoming file happens not to contain, which is a silent edit to the model
 *  in exchange for a file the user only meant to add. */
export async function importMaterialLibrary(
  store: DocumentStore,
): Promise<{ added: number; updated: number; problem: string | null } | null> {
  let text: string | null = null;
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      filters: [{ name: "Material library", extensions: ["json"] }],
    });
    if (typeof path !== "string") return null;
    try {
      text = await (await import("@tauri-apps/plugin-fs")).readTextFile(path);
    } catch (e) {
      await reportError(`Couldn't read ${path}: ${errMsg(e)}`);
      return null;
    }
  } else {
    text = await uploadJson();
  }
  if (text === null) return null;
  const { materials, problem } = parseLibrary(text);
  if (!materials.length) {
    return { added: 0, updated: 0, problem: problem ?? "there were no materials in it" };
  }
  return { ...store.importMaterials(materials), problem };
}

/** Write text to a file the person picks, or download it outside the desktop app. False when
 *  the dialog was dismissed or the write failed, which has already been reported. */
export async function saveTextFile(
  suggested: string,
  text: string,
  filter: { name: string; extensions: string[] },
): Promise<boolean> {
  if (!isTauri()) {
    downloadText(suggested, text);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ filters: [filter], defaultPath: suggested });
  if (!path) return false;
  try {
    await (await import("@tauri-apps/plugin-fs")).writeTextFile(path, text);
    return true;
  } catch (e) {
    await reportError(`Couldn't write ${path}: ${errMsg(e)}`);
    return false;
  }
}

/** The text of a file the person picks, or null when dismissed or unreadable. */
export async function openTextFile(filter: { name: string; extensions: string[] }): Promise<string | null> {
  if (!isTauri()) return uploadJson(filter.extensions.map((e) => `.${e}`).join(","));
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, filters: [filter] });
  if (typeof path !== "string") return null;
  try {
    return await (await import("@tauri-apps/plugin-fs")).readTextFile(path);
  } catch (e) {
    await reportError(`Couldn't read ${path}: ${errMsg(e)}`);
    return null;
  }
}

// --- browser fallbacks ---
/** Write a rendered picture to a file the user picks.
 *
 *  Takes the data: URL the renderer produced rather than a canvas or a Blob,
 *  because the pixels are only readable in the same task as the render that
 *  made them (the renderer runs without preserveDrawingBuffer) and this function
 *  is asynchronous from its first line. By the time a dialog has been answered
 *  the buffer is long gone; the string is not.
 *
 *  Returns the path written, or null when the user cancelled, so the caller can
 *  say where it went. */
export async function saveRenderedImage(dataUrl: string, suggested: string): Promise<string | null> {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/png;base64,") || comma < 0) {
    await reportError("The render came back empty.");
    return null;
  }
  const b64 = dataUrl.slice(comma + 1);
  if (!isTauri()) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = suggested;
    a.click();
    return suggested;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    filters: [{ name: "PNG image", extensions: ["png"] }],
    defaultPath: suggested,
  });
  if (!path) return null;
  // Decoded here rather than sent as text: writeFile takes bytes, and a base64
  // payload written as a string is a valid file of the wrong thing entirely.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    await (await import("@tauri-apps/plugin-fs")).writeFile(path, bytes);
  } catch (e) {
    await reportError(`Couldn't write ${path}: ${errMsg(e)}`);
    return null;
  }
  return path;
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The browser fallback for picking a JSON file. A twin of uploadText below
 *  rather than a parameter on it: that one advertises document extensions, and
 *  a picker that offers .funda when it wants a material library is a picker
 *  that will be handed one. */
function uploadJson(accept = ".json,application/json"): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

/** The picked file's name alongside its text, so the browser Open path can set
 *  the title bar the way a Tauri Open sets it from the chosen path. */
function uploadText(): Promise<{ text: string; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = [DOC_EXT, ...LEGACY_DOC_EXTS].map((e) => `.${e}`).join(",") + ",.json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ text: String(reader.result), name: file.name });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
