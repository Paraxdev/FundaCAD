// Bringing one FundaCAD document into another.
//
// What arrives is the source's GEOMETRY, as an import body, not its features. A
// feature copied across keeps its selectors, and those name bodies by the order
// the SOURCE built them in ("body1"), which in the host is a different body. The
// build numbers bodies with one counter over the whole history, so no remapping
// done here could know what the host will call them. Geometry has no such
// references: the source is built on its own, written out, and read back in.
//
// Two ways in:
//  - append: the geometry is copied in once and is the host's from then on;
//  - link: the same, plus where it came from and a fingerprint of the source, so
//    the body can be refreshed when that file changes.

import type { DocumentStore } from "../document/store";
import { prefixFeatures } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { migrateDocument } from "../document/migrate";
import type { CadDocument, Feature, ImportReply } from "../types";
import { asFeature } from "../types";

export type FundaInsertMode = "append" | "link";

/** Where a linked body came from, and what that file held when it was read. */
export interface FundaLink {
  path: string;
  stamp: string;
}

/** A source document, already read: its path and its document JSON. */
export interface FundaSource {
  path: string;
  text: string;
}

/** A cheap fingerprint of a document's text. It decides whether a linked file
 *  changed, not whether it is trustworthy, so it does not need to be a digest. */
export function documentStamp(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}

/** The document the source would build: its features up to its own rollback,
 *  without what it suppresses, with its own body visibility. */
export function buildableSource(text: string): CadDocument {
  const parsed = JSON.parse(text) as CadDocument;
  migrateDocument(parsed);
  const features = parsed.features ?? [];
  const rollback = parsed.rollback ?? features.length;
  const suppressed = new Set(parsed.suppressed ?? []);
  const doc: CadDocument = {
    parameters: parsed.parameters ?? {},
    features: prefixFeatures(features, rollback, suppressed),
  };
  if (parsed.bodyVisibility && Object.keys(parsed.bodyVisibility).length) doc.bodyVisibility = parsed.bodyVisibility;
  return doc;
}

export function baseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, "") || "Document";
}

/** The import feature fields a reply supplies. */
function importFields(res: Extract<ImportReply, { ok: true }>) {
  return {
    geom: res.geom,
    solid: res.solid,
    ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
    ...(res.parts !== undefined ? { parts: res.parts } : {}),
  };
}

export type InsertOutcome = { ok: true; id: string } | { ok: false; message: string; cancelled?: boolean };

/** Build the source on its own, write it to `tempPath` as STEP and read it back
 *  as geometry. */
async function bakeSource(
  store: DocumentStore,
  geometry: GeometryBackend,
  source: FundaSource,
  tempPath: string,
): Promise<Extract<ImportReply, { ok: true }> | { ok: false; message: string; cancelled?: boolean }> {
  let doc: CadDocument;
  try {
    doc = buildableSource(source.text);
  } catch (e) {
    return { ok: false, message: `could not read ${baseName(source.path)}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!doc.features.length) return { ok: false, message: `${baseName(source.path)} has nothing in it to insert` };
  const label = baseName(source.path);
  const exported = await store.runBusy(`Building ${label}`, (onStarted) => geometry.export(doc, "step", tempPath, {}, onStarted));
  if (!exported.ok) {
    return { ok: false, message: exported.message ?? `could not build ${label}`, ...(exported.cancelled ? { cancelled: true } : {}) };
  }
  const read = await store.runBusy(`Reading ${label}`, (onStarted) => geometry.importGeometry(exported.path ?? tempPath, "step", onStarted));
  if (!read.ok) return { ok: false, message: read.message ?? `could not read ${label} back`, ...(read.cancelled ? { cancelled: true } : {}) };
  return read;
}

/** Insert a FundaCAD document's geometry at the end of the history. */
export async function insertFundaDocument(
  store: DocumentStore,
  geometry: GeometryBackend,
  source: FundaSource,
  mode: FundaInsertMode,
  tempPath: string,
): Promise<InsertOutcome> {
  const baked = await bakeSource(store, geometry, source, tempPath);
  if (!baked.ok) return baked;
  const id = store.nextId();
  store.addFeature({
    id,
    type: "import",
    format: "step",
    name: baseName(source.path),
    source: source.path,
    ...importFields(baked),
    ...(mode === "link" ? { link: { path: source.path, stamp: documentStamp(source.text) } } : {}),
  } as Feature);
  return { ok: true, id };
}

/** Re-read a linked body from its file. Replaces the geometry in place, as one
 *  undoable step, so everything built on top of it rebuilds against the new one. */
export async function updateFundaLink(
  store: DocumentStore,
  geometry: GeometryBackend,
  featureId: string,
  source: FundaSource,
  tempPath: string,
): Promise<InsertOutcome> {
  const f = asFeature(store.document.features.find((x) => x.id === featureId), "import");
  if (!f?.link) return { ok: false, message: "that step is not linked to a file" };
  const baked = await bakeSource(store, geometry, source, tempPath);
  if (!baked.ok) return baked;
  store.updateFeature(featureId, {
    ...importFields(baked),
    link: { path: source.path, stamp: documentStamp(source.text) },
  } as Partial<Feature>);
  return { ok: true, id: featureId };
}

/** Linked steps whose file no longer matches what was read. `read` answers null
 *  for a file that cannot be read, which is reported apart from a change. */
export async function staleLinks(
  features: readonly Feature[],
  read: (path: string) => Promise<string | null>,
): Promise<{ changed: string[]; missing: string[] }> {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const raw of features) {
    const f = asFeature(raw, "import");
    if (!f?.link) continue;
    const text = await read(f.link.path);
    if (text === null) missing.push(f.id);
    else if (documentStamp(text) !== f.link.stamp) changed.push(f.id);
  }
  return { changed, missing };
}
