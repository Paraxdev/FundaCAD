// File I/O: save/open the document JSON and export STEP/STL/3MF. Uses Tauri
// native dialogs + fs when running in the app; falls back to browser
// download/upload in a plain dev browser. Export always writes server-side: we
// get a path from the native save dialog and hand it to the sidecar, which
// writes the file directly (no fs round-trip through the webview).

import type { DocumentStore } from "../document/store";
import { asFeature } from "../types";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, ExportFormat, Feature, ImportFormat } from "../types";
import { clearRecovery } from "./recovery";
import { referencedGeometry } from "../document/versions";
import { noteRecent } from "./recentFiles";
import { DOC_EXT, LEGACY_DOC_EXTS, isDocumentExt } from "./documentExt";
import { announceImportedBody } from "../plugins/contrib";
import {
  asHex, materialsForColors, nodeColors, parseLibrary, serializeLibrary,
} from "../document/materials";
import { decodeFaceColors, dominantFaceColor } from "../document/faceColors";
import { missingPluginMessage, missingPlugins } from "../document/missingPlugins";
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

/** Write the document as a container at `path`. Returns an error message, or
 *  null on success.
 *
 *  Goes through Rust, NOT the sidecar: `sidecar.rs` does not auto-respawn, so a
 *  save that needed the geometry engine would be impossible for the whole rest
 *  of the session once it died, with unsaved work on screen. Saving needs no
 *  geometry anyway; the blobs are already bytes on disk. */
async function writeContainer(store: DocumentStore, path: string): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("container_save", {
      path,
      documentJson: store.toJSON(),
      hashes: referencedHashes(store),
      meshKeys: [],
    });
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
      filters: [{ name: "FundaCAD Document", extensions: [DOC_EXT, ...LEGACY_DOC_EXTS] }],
      defaultPath: store.filePath ?? `${store.fileName}.${DOC_EXT}`,
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
    // Plain dev browser: no Tauri, so no container. Geometry lives in the
    // sidecar's blob store either way, so this download is the document only,
    // useful for inspecting a feature tree, NOT a portable file.
    downloadText(`${store.fileName}.${DOC_EXT}`, store.toJSON());
  }
}

export async function openDocument(store: DocumentStore, geometry: GeometryBackend) {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      // MCAD-style: Open takes our document AND mesh/CAD files (imported as a
      // body), routed by extension below, so users can just "open" an STL.
      filters: [
        { name: "All supported", extensions: [DOC_EXT, ...LEGACY_DOC_EXTS, "json", "stl", "3mf", "step", "stp", "obj", "glb"] },
        { name: "FundaCAD Document", extensions: [DOC_EXT, ...LEGACY_DOC_EXTS, "json"] },
        { name: "Mesh / CAD", extensions: ["stl", "3mf", "step", "stp", "obj", "glb"] },
      ],
    });
    if (typeof path !== "string") return;
    const ext = path.split(".").pop()?.toLowerCase();
    if (isDocumentExt(ext)) {
      await openDocumentAtPath(store, path, geometry);
    } else {
      await importPath(store, geometry, path); // a mesh / CAD file → import as a body
    }
  } else {
    const text = await uploadText();
    if (text) {
      try {
        store.load(text);
        await warnAboutMissingPlugins(store);
      } catch (e) {
        await reportError(`Couldn't open document: ${errMsg(e)}`);
      }
    }
  }
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
 *  and the welcome screen's recent-files list.
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
/** Tell the person, once, that this document uses a plugin they do not have.
 *
 *  WHY A TOAST AND NOT A REFUSAL. The document is fine. Every value is in it,
 *  the save path writes them back untouched, and the features that do not need
 *  the plugin build exactly as they always did. What is missing is the code that
 *  turns one kind of feature into geometry, so the honest report is a heads-up
 *  with the plugin's name in it, not a dialog in the way of a file that opens.
 *
 *  Once per open, at the document level, rather than per feature. The build
 *  already turns each affected row red with the same explanation (see
 *  sidecar/plugin_geometry.py), and thirty red rows do not tell you what to
 *  install any better than one sentence does.
 *
 *  Longer than the default timeout on purpose: this one has an instruction in
 *  it, and a notice you are meant to ACT on has to outlast the glance. */
async function warnAboutMissingPlugins(store: DocumentStore) {
  const missing = missingPlugins(store.document);
  if (!missing.length) return;
  const { toast } = await import("../ui/toast");
  for (const m of missing) toast(missingPluginMessage(m), { kind: "info", timeout: 12000 });
}

export async function openDocumentAtPath(
  store: DocumentStore,
  path: string,
  geometry?: GeometryBackend,
): Promise<OpenOutcome> {
  const base = path.split(/[\\/]/).pop();
  const { invoke } = await import("@tauri-apps/api/core");
  let text: string;
  let wasContainer = false;
  let repaired = false;
  try {
    wasContainer = await invoke<boolean>("container_is_container", { path });
    if (wasContainer) {
      const opened = await invoke<{ document: string; repairedShards: number; usedBackupIndex: boolean }>(
        "container_open_checked",
        { path },
      );
      text = opened.document;
      repaired = opened.repairedShards > 0 || opened.usedBackupIndex;
    } else {
      text = await (await import("@tauri-apps/plugin-fs")).readTextFile(path);
    }
  } catch (e) {
    // Rust's container errors are already user-facing sentences (a newer
    // container format, a damaged archive, geometry that does not match its
    // manifest), so pass them through rather than wrapping them in ours.
    await reportError(`Couldn't open ${base}: ${errMsg(e)}`);
    return "unreadable";
  }
  // One-way v4 -> v5, done on the PARSED text before `load()` rather than by
  // patching the store afterwards: patching would record an undo entry, mark a
  // freshly-opened document dirty, and fire a second rebuild. If anything here
  // fails, a dead sidecar, an unreadable legacy body, `text` is untouched and
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
    await reportError(`Couldn't open ${base}: ${errMsg(e)}`);
    return "unreadable";
  }
  store.markSaved(path); // freshly opened == clean, with a known path
  // AFTER markSaved, so a document that needs a plugin still opens CLEAN. The
  // notice is about what this build can do with the file, never about the file
  // having been changed, and a freshly-opened document marked dirty would offer
  // to save over the original on the way out.
  await warnAboutMissingPlugins(store);
  noteRecent(path);
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

export async function exportModel(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    console.warn("export needs the native app (a real filesystem path)");
    return;
  }
  // With several bodies, ask what to export: all merged, each as its own file, or
  // one specific body. A single-body doc skips straight to the save dialog.
  const bodies = store.buildState.result?.bodies ?? [];
  const opts: { body?: string; separate?: boolean } = {};
  if (bodies.length > 1) {
    const { choose } = await import("../ui/choice");
    const scope = await choose<"all" | "separate" | "one">("Export, which bodies?", [
      { value: "all", label: "All in one file", hint: `${bodies.length} bodies merged` },
      { value: "separate", label: "Each body separately", hint: `${bodies.length} files` },
      { value: "one", label: "A specific body", hint: "pick one" },
    ]);
    if (!scope) return;
    if (scope === "separate") {
      opts.separate = true;
    } else if (scope === "one") {
      const picked = await choose<string>(
        "Which body to export?",
        bodies.map((b) => ({ value: b.id, label: store.bodyName(b.id) ?? b.name })),
      );
      if (!picked) return;
      opts.body = picked;
    }
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    filters: [
      { name: "STEP", extensions: ["step", "stp"] },
      { name: "STL", extensions: ["stl"] },
      { name: "3MF", extensions: ["3mf"] },
      { name: "GLB (glTF)", extensions: ["glb"] },
    ],
    // "separate" derives one file per body as "<base>-<body>.<ext>", so name the base.
    defaultPath: opts.separate ? "parts.step" : "part.step",
  });
  if (!path) return;
  const fmt = extToFormat(path);
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
  return "step";
}

// The colored 3MF project export used to live here, with the slicer preset it
// writes into the file and a post-export check that asked a printer which
// filaments it had loaded. Both moved out with the capability that owns them:
// this file writes the formats the app itself understands, and a project format
// aimed at one machine's toolchanger was never one of those.

/** Import an external mesh / B-rep file (STL / 3MF / STEP / OBJ) as a new body.
 *  The sidecar reads the file by path and returns an embeddable BREP payload, so
 *  this needs the native app (a real filesystem path), like export. */
export async function importModel(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    console.warn("import needs the native app (a real filesystem path)");
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    filters: [
      { name: "All supported", extensions: ["stl", "3mf", "step", "stp", "obj", "glb"] },
      { name: "STL", extensions: ["stl"] },
      { name: "3MF", extensions: ["3mf"] },
      { name: "STEP", extensions: ["step", "stp"] },
      { name: "OBJ", extensions: ["obj"] },
      { name: "GLB (glTF)", extensions: ["glb"] },
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
 *  dialog above and the open-a-dropped-file path below both end here.
 *
 *  Exported for the harness that has a path and no dialog (e2e/*.cjs). Not a
 *  second door: it is the same one, minus the picker. */
export async function importPath(store: DocumentStore, geometry: GeometryBackend, path: string) {
  const fmt = extToImportFormat(path);
  // runBusy is what makes the operation VISIBLE and stoppable: an import used to
  // run with no busy state at all, so the timeline showed nothing and there was
  // nothing for a Cancel button to attach to. onStarted hands back the request
  // id so a cancel targets this import specifically.
  const res = await store.runBusy(
    `Importing ${path.split(/[\\/]/).pop() ?? "file"}`,
    (onStarted) => geometry.importGeometry(path, fmt, onStarted),
  );
  if (!res.ok) {
    if (res.cancelled) {
      // The user stopped it: say nothing (they know) and add NOTHING to the
      // document. The path is remembered in SESSION state only, a placeholder
      // feature would persist into the saved document and reference a path that
      // may not exist on another machine.
      lastCancelledImport = path;
      return;
    }
    await reportError(`Couldn't import ${path.split(/[\\/]/).pop()}: ${res.message ?? "unreadable file"}`);
    return;
  }
  lastCancelledImport = null;
  const id = store.nextId();
  store.addFeature({
    id,
    type: "import",
    format: fmt,
    name: res.name,
    geom: res.geom,
    source: path,
    solid: res.solid,
    ...(res.color !== undefined ? { color: res.color } : {}),
    // the file's assembly tree, when it had one. Spread the same way `color` is,
    // so an import with no tree produces exactly the feature it always did.
    ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
    ...(res.parts !== undefined ? { parts: res.parts } : {}),
  });

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
  // assembly's product colours were read by the sidecar, carried in the
  // manifest, and then never looked at, so a file that arrived fully coloured
  // opened as three thousand identical grey bodies.
  await adoptImportedColors(store, id, res);

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

/** Make materials out of the colours an import carried, and put them on the
 *  bodies it produced.
 *
 *  The IO half of document/materials.ts's `materialsForColors`, which is where
 *  the decision (match an existing material, or mint one, and what to call it)
 *  actually lives. What is here is the part that cannot be pure: the bodies do
 *  not exist until the rebuild runs, and their ids are positional, so the import
 *  has to wait for the build and then find its own bodies in the result.
 *
 *  TWO WAYS A BODY IS FOUND, because there are two kinds of import. An assembly
 *  body carries `nodeRef` naming the product it came from, and that is what
 *  binds it to a per-part colour. A single-body import has no tree, so its one
 *  colour goes on whatever bodies the feature owns, which `faceOwners` answers.
 *
 *  Assignments are display-only overlays, so this adds no second undo step on
 *  top of the import itself. */
async function adoptImportedColors(
  store: DocumentStore,
  featureId: string,
  res: {
    color?: string;
    nodes?: { name: string; parent: number | null; color?: string }[];
    parts?: { node: number; faces: number; faceColors?: FaceColorRuns }[];
  },
) {
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
    if (!p.faceColors) continue;
    for (const hex of p.faceColors.palette ?? []) {
      const c = asHex(hex);
      if (c) wanted.push({ color: c });
    }
  }
  if (!wanted.length) return;

  const { add, byColor } = materialsForColors(wanted, store.materialLibrary);
  if (add.length) store.importMaterials(add);

  await store.rebuildNow();
  const bodies = store.buildState.result?.bodies ?? [];
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
      // The body's OWN faces first, and the product tree only when it has none.
      // A product colour is what the file's author left in a dialog; a face
      // colour is what they painted. Where both exist the faces are the answer,
      // and the tree colour would put fifteen unrelated parts in one material.
      const own = b.faceColors
        ? dominantFaceColor(decodeFaceColors(b.faceColors, b.faceCount))
        : null;
      claim(b.id, asHex(own) ?? perNode[Number(b.nodeRef!.slice(slash + 1))]);
    } else if (!perNode && b.faceOwners?.some((owner) => owner === featureId)) {
      claim(b.id, single ?? undefined);
    }
  }
  for (const [material, ids] of byMaterial) store.setBodiesMaterial(ids, material);
}

/** Surface an error to the user, a native dialog in the app, console otherwise.
 *  (Import used to fail silently, which read as "nothing happened".)
 *
 *  Exported for the capabilities that write files of their own. Not because
 *  this is where such a helper belongs, but because a plugin re-implementing it
 *  would be a second answer to "what does a failed write look like", and two
 *  answers is how one of them ends up being a console warning nobody sees. */
export async function reportError(msg: string) {
  if (isTauri()) {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(msg, { title: "FundaCAD", kind: "error" });
  } else {
    console.error(msg);
  }
}

export function extToImportFormat(path: string): ImportFormat {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "stl") return "stl";
  if (ext === "3mf") return "3mf";
  if (ext === "obj") return "obj";
  if (ext === "brep") return "brep";
  if (ext === "glb") return "glb";
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
function uploadJson(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
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

function uploadText(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = [DOC_EXT, ...LEGACY_DOC_EXTS].map((e) => `.${e}`).join(",") + ",.json,application/json";
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
