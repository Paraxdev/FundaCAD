// Bringing one FundaCAD document into another as geometry, not features: the source's selectors name bodies by
// its own build order, which the host numbers differently. Append copies once; link also keeps the source path
// and a fingerprint so the body can refresh when that file changes.

import type { DocumentStore } from "../document/store";
import { prefixFeatures } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { migrateDocument } from "../document/migrate";
import type { CadDocument, Feature, ImportReply } from "../types";
import { asFeature } from "../types";
import { contentHash } from "../document/contentHash";

export type FundaInsertMode = "append" | "link";

/** Where a linked body came from, and what that file held when it was read. */
export interface FundaLink {
  path: string;
  stamp: string;
  size?: number;
  mtime?: number;
}

/** A file's size and last modified time, as the native side reports them. */
export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** What a stat of a linked file found: its size and time, no file there, or nothing it could tell. */
export type LinkStat = FileStat | "missing" | "unknown";

/** A source document, already read: its path, its document JSON and, when known, the file's stat taken before
 *  the read. */
export interface FundaSource {
  path: string;
  text: string;
  stat?: FileStat;
}

function linkOf(source: FundaSource): FundaLink {
  return {
    path: source.path,
    stamp: documentStamp(source.text),
    ...(source.stat ? { size: source.stat.size, mtime: source.stat.mtimeMs } : {}),
  };
}

/** A fingerprint of a document's text, to tell whether a linked file changed. */
export function documentStamp(text: string): string {
  return contentHash(text);
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
    return {
      ok: false,
      message: `could not read ${baseName(source.path)}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!doc.features.length) return { ok: false, message: `${baseName(source.path)} has nothing in it to insert` };
  const label = baseName(source.path);
  const exported = await store.runBusy(`Building ${label}`, (onStarted) =>
    geometry.export(doc, "step", tempPath, {}, onStarted),
  );
  if (!exported.ok) {
    return {
      ok: false,
      message: exported.message ?? `could not build ${label}`,
      ...(exported.cancelled ? { cancelled: true } : {}),
    };
  }
  const read = await store.runBusy(`Reading ${label}`, (onStarted) =>
    geometry.importGeometry(exported.path ?? tempPath, "step", onStarted),
  );
  if (!read.ok)
    return {
      ok: false,
      message: read.message ?? `could not read ${label} back`,
      ...(read.cancelled ? { cancelled: true } : {}),
    };
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
  // The bake runs on the engine for this document; its session ending rejects it before anything is written.
  const baked = await store.session.step(store.importing(() => bakeSource(store, geometry, source, tempPath)));
  if (!baked.ok) return baked;
  const id = store.nextId();
  store.addFeature({
    id,
    type: "import",
    format: "step",
    name: baseName(source.path),
    source: source.path,
    ...importFields(baked),
    ...(mode === "link" ? { link: linkOf(source) } : {}),
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
  const f = asFeature(
    store.document.features.find((x) => x.id === featureId),
    "import",
  );
  if (!f?.link) return { ok: false, message: "that step is not linked to a file" };
  // The bake runs on the engine for this document; its session ending rejects it before anything is written.
  const baked = await store.session.step(store.importing(() => bakeSource(store, geometry, source, tempPath)));
  if (!baked.ok) return baked;
  store.updateFeature(featureId, {
    ...importFields(baked),
    link: linkOf(source),
  } as Partial<Feature>);
  return { ok: true, id: featureId };
}

/** Linked steps whose file no longer matches the size and time stored when it was read, never reading the file.
 *  A link stored without them, a file the stat could not tell about, or a new time on the same size (a copy or a
 *  checkout keeps the content) is unknown until the user updates it. */
export async function staleLinks(
  features: readonly Feature[],
  stat: (path: string) => Promise<LinkStat>,
): Promise<{ changed: string[]; missing: string[]; unknown: string[] }> {
  const changed: string[] = [];
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const raw of features) {
    const f = asFeature(raw, "import");
    if (!f?.link) continue;
    const now = await stat(f.link.path);
    if (now === "missing") missing.push(f.id);
    else if (now === "unknown" || f.link.size === undefined || f.link.mtime === undefined) unknown.push(f.id);
    else if (now.size !== f.link.size) changed.push(f.id);
    else if (now.mtimeMs !== f.link.mtime) unknown.push(f.id);
  }
  return { changed, missing, unknown };
}
