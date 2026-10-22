// Save, open and export. Tauri dialogs and fs in the app, browser download and upload in a plain dev browser.
// Export hands the engine a path from the save dialog, so the file never round-trips through the webview.

import { suggestedSavePath } from "./saveFolder";
import type { CarriedSection, DocumentStore } from "../document/store";
import { asFeature } from "../types";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, ExportFormat, Feature, ImportFormat, PlaneDef } from "../types";
import { clearRecovery } from "./recovery";
import {
  clampTolerance,
  exportFileName,
  exportScopeFromSelection,
  FORMATS,
  isFlatFormat,
  isMeshFormat,
  lastExportDir,
  meshWire,
  loadExportSettings,
  rememberExportDir,
  saveExportSettings,
  type FlatSource,
} from "./exportSettings";
import { buildBodyTree, importTrees } from "../ui/browserTree";
import { referencedGeometry } from "../document/versions";
import { hashShapedStrings } from "../document/geometryRefs";
import { blake2b128Hex } from "../document/blake2b";
import { UnreadableDocumentError } from "../document/documentShape";
import { noteRecent } from "./recentFiles";
import { closeHome } from "../ui/home";
import { captureAfterOpen, captureThumbnail, storeThumbnail } from "./thumbnails";
import { BINARY_DOC_EXT, DOC_EXT, LEGACY_DOC_EXTS, isDocumentExt, leftOutSectionsNotice } from "./documentExt";
import { announceImportedBody } from "../plugins/contrib";
import { askImportUnit, asksForUnit, type ImportUnit } from "./importUnit";
import { importFeatures } from "./importSketches";
import { asHex, materialsForColors, nodeColors, parseLibrary, serializeLibrary } from "../document/materials";
import { importedBodyColors } from "../document/faceColors";
import { openNotices } from "../document/openNotice";
import type { FaceColorRuns } from "../types";
import { isSessionEnded, type OpenOp } from "../document/session";

const isTauri = () => "__TAURI_INTERNALS__" in window;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every geometry hash the document references plus the mesh keys worth carrying, for Rust's container entries. */
function referencedHashes(store: DocumentStore): string[] {
  const out = new Set<string>();
  for (const f of store.document.features ?? []) {
    const imp = asFeature(f, "import");
    if (imp?.geom) out.add(imp.geom);
  }
  if (store.versionRepo) for (const h of referencedGeometry(store.versionRepo)) out.add(h);
  return [...out];
}

/** Write the document at `path`, JSON or binary for `.fundab` (Rust decides). Returns an error message or null.
 *  Goes through the app, not the engine, so a save works while the engine worker is down. */
async function writeContainer(store: DocumentStore, path: string): Promise<string | null> {
  const picture = captureThumbnail();
  // Read before the first await: a document opened meanwhile must never be written under this one's path.
  const doc = store.toObject();
  const hashes = referencedHashes(store);
  const carried = store.carriedSections;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const optionalHashes = [...hashShapedStrings(doc)].filter((h) => !hashes.includes(h));
    await invoke("container_save", {
      path,
      documentJson: JSON.stringify(doc, null, 2),
      hashes,
      optionalHashes,
      meshKeys: [],
      carried,
    });
    void storeThumbnail(path, picture);
    const left = leftOutSectionsNotice(path, carried);
    if (left) void import("../ui/toast").then(({ toast }) => toast(left, { kind: "info", timeout: 12000 }));
    return null;
  } catch (e) {
    return errMsg(e);
  }
}

/** Save: write to the current path if known, else behave like Save As. */
export async function saveDocument(store: DocumentStore) {
  if (isTauri() && store.filePath) {
    const session = store.session;
    const path = store.filePath;
    const err = await writeContainer(store, path);
    if (err) {
      await reportError(`Couldn't save ${path}: ${err}`);
      return;
    }
    // The file holds the document as it was when the save began, so another document opened meanwhile is not saved.
    if (!session.alive) return;
    store.markSaved(path);
    noteRecent(path);
    void clearRecovery(path); // the on-disk file is now the truth
  } else {
    await saveDocumentAs(store);
  }
}

/** Save As: always prompt for a path (or download in a plain browser). */
export async function saveDocumentAs(store: DocumentStore) {
  const session = store.session;
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
    // A path picked for a document that was closed meanwhile is not where the next one goes.
    if (path && session.alive) {
      const err = await writeContainer(store, path);
      if (err) {
        await reportError(`Couldn't save ${path}: ${err}`);
        return;
      }
      if (!session.alive) return;
      store.markSaved(path);
      noteRecent(path);
      void clearRecovery(path);
    }
  } else {
    // Reuse the settled name so a second Save As downloads "Untitled.funda" again, not "Untitled.funda.funda".
    const name = store.filePath ? store.fileName : `${store.fileName}.${DOC_EXT}`;
    const built = await browserDocumentText(store);
    if ("refused" in built) {
      await reportError(built.refused);
      return;
    }
    if (!session.alive) return;
    downloadText(name, built.text);
    // No real path, but without this the title bar read "Untitled*" forever, as if the save had failed.
    store.markSaved(name);
  }
}

/** A browser save holds this much geometry at most: the file is built as one
 *  string, base64 adds a third, and V8 refuses a string past about 512 MiB. */
const MAX_BROWSER_GEOMETRY_BYTES = 256 * 1024 * 1024;

/** The .funda text the desktop app would write, with imported geometry read back from the engine's blob store
 *  since a browser has no Rust. `refused` says why no file that opens whole could be built. */
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
    return {
      refused: `Couldn't save: its imported geometry is ${Math.round(total / 1048576)} MB, more than the browser can put in one file. Save it in the desktop app.`,
    };
  }
  const geometry: Record<string, string> = {};
  for (const h of [...blobs.keys()].sort()) geometry[h] = bytesToBase64(blobs.get(h)!);
  return { text: JSON.stringify(blobs.size ? { ...doc, geometry } : doc, null, 2) };
}

/** What Rust does on a desktop open: check every embedded blob against its hash, all before any is published,
 *  then hand them to the engine. The text comes back unchanged; load() drops the `geometry` key. */
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
      throw new UnreadableDocumentError(
        "its geometry does not match its hash, so it was changed or damaged",
        `geometry ${hash} does not match its bytes`,
      );
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
  placeImport: (names: string[], run: () => Promise<unknown>) => Promise<unknown> = async (_names, run) => {
    closeHome();
    await run();
  },
) {
  if (isTauri()) {
    // A file picked for a document closed while the dialog was up is not imported into the next one.
    const session = store.session;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      // MCAD-style: Open takes our document AND mesh/CAD files (imported as a
      // body), routed by extension below, so users can just "open" an STL.
      filters: [
        {
          name: "All supported",
          extensions: dialogExts([DOC_EXT, BINARY_DOC_EXT, ...LEGACY_DOC_EXTS, "json", ...IMPORT_EXTS]),
        },
        { name: "FundaCAD Document", extensions: dialogExts([DOC_EXT, BINARY_DOC_EXT, ...LEGACY_DOC_EXTS, "json"]) },
        { name: "Mesh / CAD", extensions: dialogExts(IMPORT_EXTS) },
      ],
    });
    if (typeof path !== "string") return;
    const ext = path.split(".").pop()?.toLowerCase();
    if (isDocumentExt(ext)) {
      if (!(await mayReplace())) return;
      await openDocumentAtPath(store, path, geometry);
    } else if (session.alive) {
      await placeImport([path.split(/[\\/]/).pop() ?? path], () => importPath(store, geometry, path));
    }
  } else {
    const picked = await uploadText();
    if (picked && (await mayReplace())) await openDocumentText(store, picked.name, picked.text);
  }
}

/** Open a document the app has as text with no path, picked in a browser or
 *  dropped on the window. */
export async function openDocumentText(
  store: DocumentStore,
  name: string,
  text: string,
  ticket = openTicket(store),
): Promise<OpenOutcome> {
  let unpublished: string | null;
  try {
    unpublished = await publishEmbeddedGeometry(store, text);
    if (!(await mayStillReplace(store, ticket, name))) return "dropped";
    store.load(text);
  } catch (e) {
    await reportUnreadable(e);
    return "unreadable";
  }
  // No real path, but the name lets the title bar show what is open and drop the unsaved marker.
  store.markSaved(name);
  await warnAboutOpen(store);
  if (unpublished)
    await reportError(
      `Opened ${name}, but its embedded geometry could not be handed to the engine, so its imports will not build: ${unpublished}.`,
    );
  return "ok";
}

/** Open a dropped document the app has as a File with no path. The desktop app
 *  reads it in Rust like an Open does, so embedded geometry reaches the blob
 *  store and a binary .fundab opens; a plain browser reads it as text. */
export async function openDocumentBytes(
  store: DocumentStore,
  file: File,
  geometry?: GeometryBackend,
): Promise<OpenOutcome> {
  const ticket = openTicket(store);
  if (!isTauri()) return openDocumentText(store, file.name, await file.text(), ticket);
  const { invoke } = await import("@tauri-apps/api/core");
  let opened: OpenedDocument;
  try {
    const r = await invoke<RustOpened & { wasContainer: boolean }>(
      "container_open_bytes",
      new Uint8Array(await file.arrayBuffer()),
    );
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
  return finishOpen(store, file.name, opened, geometry, null, ticket);
}

/** "unreadable": the file is gone or corrupt, callers may forget it. "newerFormat": this build is too old, and
 *  the recent-files entry must survive as the user's way back to the file after upgrading. "dropped": the open
 *  document changed or was replaced while the file was read, and the user kept it. */
export type OpenOutcome = "ok" | "unreadable" | "newerFormat" | "dropped";

interface OpenTicket {
  op: OpenOp;
  edits: number;
}

// Taken when the user has agreed to replace the open document, before the file is read.
function openTicket(store: DocumentStore): OpenTicket {
  return { op: store.sessions.opening(), edits: store.editCount };
}

// Right before the swap: what the user agreed to replace must still be what is open (rm4abwsm).
async function mayStillReplace(store: DocumentStore, ticket: OpenTicket, name: string): Promise<boolean> {
  for (;;) {
    if (ticket.op.superseded) return false;
    if (!ticket.op.session.alive) {
      const { toast } = await import("../ui/toast");
      toast(`${name} was not opened, another document was started while it was read.`, { kind: "info" });
      return false;
    }
    if (store.editCount === ticket.edits || !store.dirty) return true;
    ticket.edits = store.editCount;
    const { choose } = await import("../ui/choice");
    const pick = await choose(
      `${store.fileName} changed while ${name} was read. Discard those changes and open ${name}?`,
      [
        { value: "discard", label: "Discard", hint: "lose the changes" },
        { value: "cancel", label: "Cancel", hint: `keep them, ${name} is not opened` },
      ],
    );
    if (pick !== "discard") return false;
  }
}

/** True if `text` is a ZIP, a v5 packaged document this build cannot read. readTextFile's non-fatal decoder keeps
 *  the ASCII "PK" header intact, so no binary read is needed; "PK" alone also catches empty and spanned archives. */
export function looksLikeContainer(text: string): boolean {
  return text.startsWith("PK") || text.startsWith("FUNDACAD");
}

/** Rewrite a pre-v5 document's inline base64 BREP into blob references. Any failure returns the text unchanged:
 *  an optimisation, never a precondition for opening. */
async function migrateInlineGeometry(text: string, geometry: GeometryBackend): Promise<string> {
  try {
    const doc = JSON.parse(text) as CadDocument;
    const legacy = (doc.features ?? []).filter(
      (f): f is Extract<Feature, { type: "import" }> => f.type === "import" && typeof f.brep === "string" && !f.geom,
    );
    if (!legacy.length) return text;

    const migrated = await geometry.migrateGeometry(legacy.map((f) => ({ id: f.id, brep: f.brep as string })));
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

/** Tell the person once that this document uses a missing plugin or unknown features (document/openNotice.ts).
 *  A toast, not a refusal, as the document saves back untouched; it outlasts the default timeout to be acted on. */
async function warnAboutOpen(store: DocumentStore) {
  const notices = openNotices(store.document, store.openedVersion);
  if (!notices.length) return;
  const { dismissToast, toast } = await import("../ui/toast");
  const ids = notices.map((n) =>
    toast(n.message, { kind: n.kind, timeout: 12000, ...(n.detail ? { detail: n.detail } : {}) }),
  );
  store.session.own(() => {
    for (const id of ids) if (id !== null) dismissToast(id);
  });
}

/** Open a document at a known path, shared by Open and Home's recent documents. A v5 ZIP is read by Rust, which
 *  extracts its geometry; pre-v5 JSON is read as text. store.load() fires its rebuild before markSaved(path) runs,
 *  so nothing on the rebuild path may depend on `store.filePath`. */
export async function openDocumentAtPath(
  store: DocumentStore,
  path: string,
  geometry?: GeometryBackend,
): Promise<OpenOutcome> {
  const ticket = openTicket(store);
  const base = path.split(/[\\/]/).pop() ?? path;
  const { invoke } = await import("@tauri-apps/api/core");
  let opened: OpenedDocument;
  try {
    const wasContainer = await invoke<boolean>("container_is_container", { path });
    // JSON goes through Rust too: it carries embedded geometry that has to reach
    // the blob store before the first rebuild asks for it.
    const r = await invoke<RustOpened>("container_open_checked", { path });
    opened = {
      text: r.document,
      wasContainer,
      repaired: r.repairedShards > 0 || r.usedBackupIndex,
      carried: r.carried ?? [],
    };
  } catch (e) {
    // Rust's container errors are already user-facing sentences (a newer
    // container format, a damaged archive, geometry that does not match its
    // manifest), so pass them through rather than wrapping them in ours.
    await reportError(`Couldn't open ${base}: ${errMsg(e)}`);
    return "unreadable";
  }
  return finishOpen(store, base, opened, geometry, path, ticket);
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
  ticket: OpenTicket,
): Promise<OpenOutcome> {
  // One-way v4 to v5 on the parsed text before load(): patching the store after would add an undo entry, dirty the
  // document and rebuild twice. On any failure `text` is untouched and opens with its inline copy.
  if (!wasContainer && geometry) text = await migrateInlineGeometry(text, geometry);
  if (!(await mayStillReplace(store, ticket, base))) return "dropped";

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
  // After markSaved, so a document needing a plugin still opens clean and does not offer to save over the original.
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
export function flatSourceOf(
  store: DocumentStore,
  viewport: ExportViewport,
  featureId: string | null,
): FlatSource | null {
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
  return exportModel(
    store,
    geometry,
    viewport.selectionBodyIds(),
    flatSourceOf(store, viewport, useSelectionStore().featureId),
  );
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
  // The dialogs wait on the user; a document closed meanwhile is not exported, nor is the one opened after it.
  const session = store.session;
  const built = store.buildState.result?.bodies ?? [];
  const bodies = built.map((b) => ({ id: b.id, name: store.bodyName(b.id) ?? b.name }));
  const docName = store.fileName === "Untitled" ? "" : store.fileName.replace(/\.[^.]+$/, "");
  const { groups } = buildBodyTree(built, importTrees(store.document), store.bodyElements, store.bodyElementMap());
  const start = exportScopeFromSelection(selected, bodies, groups, docName);
  const { useExportDialogStore } = await import("../stores/exportDialog");
  const choice = await useExportDialogStore().open({
    bodies,
    scope: start.scope,
    selected: start.selected,
    ...(flat ? { flat: { label: flat.label } } : {}),
    ...(format ? { format } : {}),
  });
  if (!choice || !session.alive) return;
  const { settings, scope } = choice;
  // The dialog offers DXF and SVG only with a 2D source, so the next plain
  // export would drop either for the default rather than the last 3D format.
  saveExportSettings(isFlatFormat(settings.format) ? { ...settings, format: loadExportSettings().format } : settings);
  if (!isTauri()) {
    // The engine writes exports straight to a path, which a plain browser cannot give it, so refuse rather than
    // quietly produce nothing.
    await reportError(
      "Export needs the desktop app: a browser tab has no filesystem path to give the engine to write to.",
    );
    return;
  }
  const opts: {
    body?: string;
    bodies?: string[];
    separate?: boolean;
    sketch?: string;
    face?: unknown;
    plane?: PlaneDef;
    tolerance?: number;
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
      ? (store.bodyName(opts.body) ?? docName)
      : (opts.bodies ? start.base : docName) || (opts.separate || opts.bodies ? "parts" : "part");
  const name = exportFileName(base, kind.ext);
  const dir = lastExportDir();
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    filters: [{ name: kind.label, extensions: dialogExts(kind.exts) }],
    // "separate" derives one file per body as "<base>-<body>.<ext>", so name the base.
    defaultPath: dir ? `${dir}/${name}` : name,
  });
  if (!path || !session.alive) return;
  rememberExportDir(path);
  const fmt = settings.format;
  // GLB carries one material per body, so it needs the palette and slots. runBusy as in importPath: an export
  // replays the whole history, and onStarted lets Cancel target this export rather than a later rebuild.
  const res = await store.runBusy(`Exporting ${path.split(/[\\/]/).pop() ?? "file"}`, (onStarted) =>
    geometry.export(
      store.document,
      fmt,
      path,
      {
        ...opts,
        palette: store.colorPalette,
        bodyColors: store.bodyColorsMap(),
        ...(isMeshFormat(fmt) ? { mesh: meshWire(settings) } : {}),
      },
      onStarted,
    ),
  );
  if (!res.ok) {
    // The user stopped it, so say nothing rather than "Export failed: cancelled".
    if (res.cancelled) return;
    await reportError(`Export failed: ${res.message ?? "unknown error"}`);
    return;
  }
  // List every written file and name features missing from the export, since one failed feature no longer blocks it.
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
  // Total: an unknown extension falls through to STEP, so a missed format here silently writes STEP under its name.
  if (ext === "glb") return "glb";
  if (ext === "dxf") return "dxf";
  if (ext === "svg") return "svg";
  return "step";
}

// The formats the app itself writes; a plugin's format goes through its exporter via GeometryBackend.exportWith.

/** Lower case only, every lookup lower-cases the name first (dropRouting, the
 *  two mappers above). */
export const IMPORT_EXTS = [
  "stl",
  "3mf",
  "step",
  "stp",
  "stpz",
  "gz",
  "xbf",
  "iges",
  "igs",
  "brep",
  "fcstd",
  "3dm",
  "ifc",
  "dxf",
  "obj",
  "ply",
  "off",
  "amf",
  "glb",
  "gltf",
  "wrl",
  "wrz",
  "x3d",
  "x3dz",
  "fbx",
  "3ds",
  "svg",
];

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

/** Import an external mesh or B-rep file as a new body. The engine reads it by path, so this needs the native app. */
export async function importModel(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    // Only a drop reaches the engine's bytes form of import (importFileBytes),
    // this picker has no browser file input behind it.
    await reportError("Import needs the desktop app: a browser tab has no filesystem path to give the engine to read.");
    return;
  }
  const session = store.session;
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
  if (typeof path !== "string" || !session.alive) return;
  await importPath(store, geometry, path);
}

/** The most recently cancelled import's path, so a retry is one click. Session state only, never in the document. */
let lastCancelledImport: string | null = null;

export function cancelledImportPath(): string | null {
  return lastCancelledImport;
}

// Measured on WebKitGTK: about 60 fps at 1,000 bodies, 27-37 fps at 3,060, bound by 2 draw calls per body (hence a
// body count). Merging draw calls would break per-body `.visible`, etag reuse and move ghosts.
const SMOOTH_BODY_LIMIT = 1000;
const SLOW_BODY_LIMIT = 3000;

/** What to tell the user about a document this size, or null. Said before the viewport is built, so a freeze is
 *  not mistaken for a broken app; separate so the thresholds test without a viewport. */
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

/** Import the file at `path`: read it, add the feature, adopt its looks. The dialog and Open both end here, and
 *  the e2e harness calls it with a path and no dialog. */
export async function importPath(
  store: DocumentStore,
  geometry: GeometryBackend,
  path: string,
  unit?: ImportUnit,
  opts: { source?: string; batched?: boolean } = {},
): Promise<ImportEnd> {
  const fmt = extToImportFormat(path);
  return importWith(store, path, fmt, (onStarted, u) => geometry.importGeometry(path, fmt, onStarted, u), {
    ...opts,
    unit,
  });
}

/** Files above this cannot reach the engine as one base64 message, its frame
 *  cap is 128 MiB. */
export const MAX_DROPPED_IMPORT_BYTES = 90 * 1024 * 1024;

/** Import a file the app has as bytes only, like one dropped on a browser tab.
 *  Its `source` is the bare name, there is no path to remember. With `opening` the import is how the document
 *  opens, so its own writes leave a clean document clean. */
export async function importFileBytes(
  store: DocumentStore,
  geometry: GeometryBackend,
  file: File,
  unit?: ImportUnit,
  opts: { opening?: boolean; batched?: boolean } = {},
): Promise<ImportEnd> {
  const fmt = extToImportFormat(file.name);
  const importBytes = geometry.importBytes?.bind(geometry);
  if (!importBytes) {
    await reportError(`Couldn't import ${file.name}: this geometry backend reads files by path only.`);
    return;
  }
  if (file.size > MAX_DROPPED_IMPORT_BYTES) {
    await reportError(
      `Couldn't import ${file.name}: it is ${Math.round(file.size / 1048576)} MB, a dropped file can be 90 MB at most here. Use File > Import in the desktop app.`,
    );
    return;
  }
  return importWith(
    store,
    file.name,
    fmt,
    async (onStarted, u) =>
      importBytes(file.name, fmt, bytesToBase64(new Uint8Array(await file.arrayBuffer())), onStarted, u),
    { unit, retryable: false, opening: opts.opening ?? false, batched: opts.batched ?? false },
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
  opts: {
    unit?: ImportUnit | undefined;
    source?: string;
    retryable?: boolean;
    opening?: boolean;
    batched?: boolean;
  } = {},
): Promise<ImportEnd> {
  // Opening is not blocked while a file is read; the session's end rejects the read, so it never lands in the next.
  const session = store.session;
  let unit = opts.unit;
  let res: Awaited<ReturnType<typeof read>>;
  try {
    if (asksForUnit(fmt) && !unit) {
      const picked = await session.step(askImportUnit(fmt));
      if (!picked) return;
      unit = picked;
    }
    // runBusy makes the import visible and stoppable; onStarted hands back the request id so Cancel targets it.
    res = await store.runBusy(`Importing ${fileName(path)}`, (onStarted) => read(onStarted, unit), {
      holdHistory: true,
    });
  } catch (e) {
    if (!isSessionEnded(e)) throw e;
    res = { ok: false, cancelled: true } as typeof res;
  }
  // A read the session's end did not reject still belongs to it; a failed one keeps its error.
  if (!session.alive && (res.ok || res.cancelled)) {
    // A batch names every file it left out in one warning.
    if (!opts.batched) await importDropped([fileName(path)]);
    return "dropped";
  }
  if (!res.ok) {
    if (res.cancelled) {
      // Cancelled: say nothing and add nothing to the document. The path stays in session state only, since a
      // placeholder feature would save a path that may not exist on another machine.
      lastCancelledImport = opts.retryable === false ? null : path;
      return;
    }
    await reportError(`Couldn't import ${path.split(/[\\/]/).pop()}: ${res.message ?? "unreadable file"}`);
    return;
  }
  lastCancelledImport = null;
  const features = importFeatures(res, {
    format: fmt,
    source: opts.source ?? path,
    taken: store.document.features.map((f) => f.id),
  });
  const cleanBefore = !store.dirty;
  if (opts.opening) store.keepingClean(() => store.addFeatures(features));
  else store.addFeatures(features);
  const landedAt = cleanBefore ? store.editCount : null;
  const imported = features.find((f) => f.type === "import");
  if (!imported) {
    if (res.notes?.length) {
      const { toast } = await import("../ui/toast");
      toast(res.notes.join(". "), { kind: "info" });
    }
    return;
  }
  const id = imported.id;

  // A non-blocking heads-up about a measured limit while the user still decides, rather than a surprise freeze.
  const capability = describeImportCapability(importedBodyCount(res));
  if (capability) {
    const { toast } = await import("../ui/toast");
    toast(capability, { kind: "info" });
  }

  // The file's own colours become materials worn by the bodies it produced, or a coloured STEP assembly opens
  // as thousands of identical grey bodies.
  if (await cancelledImport(store, imported, res, landedAt)) return;
  const source = importSource(imported);
  const adopt = { joinImport: true, source, opening: opts.opening ?? false };
  if (!(await adoptImportedColors(store, id, res, adopt))) recolorOnRedo(store, imported, res);

  // The file carried one dominant colour: report it and let whoever has a use for it decide. Awaited, because a
  // listener must rebuild before it finds the feature's bodies, or the import would report finished too early.
  if (res.color === undefined) return;
  await announceImportedBody(id, res.color);
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? "file";

/** "dropped" when the file was read but left out, as another document was opened meanwhile. */
type ImportEnd = "dropped" | undefined;

/** Says imports were left out because another document was opened before they landed. */
export async function importDropped(names: readonly string[]) {
  if (!names.length) return;
  const many = names.length > 1;
  const list = many ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const { toast } = await import("../ui/toast");
  const were = many ? "they were" : "it was";
  toast(`${list} ${many ? "were" : "was"} not imported, another document was opened while ${were} read.`, {
    kind: "warning",
  });
}

/** Runs a batch of imports in turn and stops at the first document opened meanwhile, as the rest belong to the
 *  one the batch began in. Each step imports with `batched`, so one warning names every file left out. */
export async function importInTurn(
  store: DocumentStore,
  steps: readonly { name: string; run: () => Promise<ImportEnd | void> }[],
): Promise<void> {
  const session = store.session;
  const left: string[] = [];
  for (const step of steps) {
    if (!session.alive || (await step.run()) === "dropped") left.push(step.name);
  }
  await importDropped(left);
}

// False when the document's session ended first: what was waited for belongs to a document that is gone.
async function builtInSession(store: DocumentStore): Promise<boolean> {
  const session = store.session;
  try {
    await session.step(store.whenBuilt());
    return true;
  } catch (e) {
    if (isSessionEnded(e)) return false;
    throw e;
  }
}

const importSource = (f: Feature) =>
  f.type === "import" ? (f as Extract<Feature, { type: "import" }>).source : undefined;

/** Waits for the build that brings `imported` in. A Cancel during it undoes the import as one step (Redo builds
 *  it again), and leaves the document clean when it was clean before the import and nothing changed since
 *  `cleanAt`. True when nothing is left to do: cancelled, or another document was opened meanwhile. */
async function cancelledImport(
  store: DocumentStore,
  imported: Feature,
  res: Parameters<typeof adoptImportedColors>[2],
  cleanAt: number | null = null,
) {
  if (!(await builtInSession(store))) return true;
  const still = store.document.features.find((f) => f.id === imported.id);
  if (!store.buildState.cancelled || !still || importSource(still) !== importSource(imported)) return false;
  const has = (d: { features: { id: string }[] }) => d.features.some((f) => f.id === imported.id);
  const untouched = cleanAt === store.editCount;
  const undone = store.undoIfTop((before) => !has(before) && has(store.document));
  if (undone && untouched) store.markClean();
  if (undone) recolorOnRedo(store, imported, res);
  const name = importSource(imported)?.split(/[\\/]/).pop() || "the file";
  const { toast } = await import("../ui/toast");
  toast(
    undone
      ? `Import of ${name} cancelled, nothing was added. Redo brings it back.`
      : "Rebuild cancelled, the model is not built. Compute All builds it.",
    { kind: "info" },
  );
  return true;
}

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
        void (async () => {
          if (await cancelledImport(store, feature, res)) return;
          await adoptImportedColors(store, feature.id, res, { joinImport: true, only: true, source });
        })().catch((e) => console.warn("import colours not put back", e));
      });
    }
  });
}

/** Make materials from an import's colours and put them on its bodies, the IO half of materialsForColors in
 *  document/materials.ts, since the bodies exist only after the rebuild. An assembly body is found by `nodeRef`,
 *  a single-body import's by `faceOwners`. One undo step: `joinImport` joins the import's step while it is newest,
 *  `only` applies only then. False if the feature is gone, true without a write if another document opened. */
export async function adoptImportedColors(
  store: DocumentStore,
  featureId: string,
  res: {
    color?: string | undefined;
    nodes?: { name: string; parent: number | null; color?: string }[] | undefined;
    parts?: { node: number; faces: number; faceColors?: FaceColorRuns; color?: string }[] | undefined;
  },
  opts: { joinImport?: boolean; only?: boolean; source?: string | undefined; opening?: boolean } = {},
): Promise<boolean> {
  const own = <T>(fn: () => T): T => (opts.opening ? store.keepingClean(fn) : fn());
  const perNode = res.nodes ? nodeColors(res.nodes) : null;
  // Normalised once: it is the key into the map materialsForColors returns. nodeColors already normalises.
  const single = perNode ? null : asHex(res.color);
  const wanted: { color: string; name?: string | undefined }[] = [];
  if (perNode) {
    for (const c of perNode) if (c) wanted.push({ color: c });
  } else if (single) {
    wanted.push({ color: single });
  }
  // Face colours are where mechanical CAD puts colour: the reference board styles all 1,803 faces and leaves its
  // 29 products default. All go in the library, as faces that disagree with their body are the red circuit board.
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
  if (add.length) own(() => store.importMaterials(add));

  if (!(await builtInSession(store))) return true;
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
  own(() =>
    store.undoAsOne(
      () => {
        for (const [material, ids] of byMaterial) store.setBodiesMaterial(ids, material);
      },
      opts.joinImport ? (before) => !has(before) && has(store.document) : undefined,
      { only: !!opts.only },
    ),
  );
  return true;
}

/** A document load() refused, in words for people. The technical reason goes
 *  with the notice's log entry rather than into the sentence. */
async function reportUnreadable(e: unknown) {
  const reason = e instanceof UnreadableDocumentError ? e.reason : "part of it could not be read";
  await reportError(`This file is not a FundaCAD document, or it is damaged: ${reason}.`, errMsg(e));
}

/** Surface an error: a native dialog in the app, the title bar error notice otherwise. Exported so capabilities
 *  writing files report failures the same way, not as a console warning nobody sees. */
export async function reportError(msg: string, detail?: string) {
  if (isTauri()) {
    if (detail) console.error(detail);
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(msg, { title: "FundaCAD", kind: "error" });
  } else {
    // No native dialog, so use the app's title bar error notice (ui/toast.ts to ui/errorNotice.ts).
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
  return "step"; // TOTAL, like extToFormat above, see the note there
}

// Material libraries are plain JSON, not the document container, so they travel between documents and people.
// Both directions go through document/materials.ts, so what is written can be read back.

/** Not `.json` alone, so a folder of them is legible and the picker can default to the right thing. */
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

/** Read a library file and merge it into the document's by id; null when cancelled. Merge, not replace: a
 *  replace would silently unassign every body wearing a material the file lacks. */
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

/** Write a rendered picture to a file the user picks, returning the path or null. Takes the data: URL because
 *  the renderer has no preserveDrawingBuffer, so the pixels are gone by the time a dialog is answered. */
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
  // Decoded here: writeFile takes bytes, and base64 written as a string is a valid file of the wrong thing.
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

/** The browser fallback for picking a JSON file, apart from uploadText so a material library picker does not
 *  offer .funda files. */
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
