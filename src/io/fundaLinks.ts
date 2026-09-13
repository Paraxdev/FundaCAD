// The app's side of inserting and linking FundaCAD documents: the file dialog,
// reading a document off disk, and where the intermediate STEP is written.
// io/fundaInsert.ts is the part that does not need the native shell.

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { asFeature, type Feature } from "../types";
import { DOC_EXT, LEGACY_DOC_EXTS } from "./documentExt";
import {
  baseName,
  insertFundaDocument,
  staleLinks,
  updateFundaLink,
  type FundaInsertMode,
} from "./fundaInsert";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** A document's JSON, from a container or a plain JSON file, or null when the
 *  file cannot be read. */
export async function readDocumentText(path: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const packed = await invoke<boolean>("container_is_container", { path });
    if (packed) return await invoke<string>("container_open", { path });
    return await (await import("@tauri-apps/plugin-fs")).readTextFile(path);
  } catch {
    return null;
  }
}

async function tempStepPath(): Promise<string> {
  const { tempDir, join } = await import("@tauri-apps/api/path");
  return join(await tempDir(), `fundacad-insert-${Date.now().toString(36)}.step`);
}

async function say(message: string, kind: "info" | "error" = "info", action?: { label: string; onClick: () => void }) {
  const { toast } = await import("../ui/toast");
  toast(message, { kind, ...(action ? { action } : {}) });
}

/** Insert > FundaCAD Document: pick a file, then append or link it. */
export async function insertDocumentFromDialog(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    await say("Inserting a document needs the desktop app, it reads the file from disk");
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    filters: [{ name: "FundaCAD Document", extensions: [DOC_EXT, ...LEGACY_DOC_EXTS, "json"] }],
  });
  if (typeof path !== "string") return;
  if (store.filePath && samePath(path, store.filePath)) {
    await say("A document cannot be inserted into itself", "error");
    return;
  }
  const { choose } = await import("../ui/choice");
  const mode = await choose<FundaInsertMode>(`Insert ${baseName(path)}`, [
    { value: "append", label: "Append", hint: "copy it in once" },
    { value: "link", label: "Link", hint: "update when the file changes" },
  ]);
  if (!mode) return;
  const text = await readDocumentText(path);
  if (text === null) {
    await say(`Couldn't read ${baseName(path)}`, "error");
    return;
  }
  const res = await insertFundaDocument(store, geometry, { path, text }, mode, await tempStepPath());
  if (!res.ok) {
    if (!res.cancelled) await say(`Couldn't insert ${baseName(path)}: ${res.message}`, "error");
    return;
  }
  await say(mode === "link" ? `Linked ${baseName(path)}` : `Appended ${baseName(path)}`);
}

/** Re-read one linked step from its file. */
export async function refreshLink(store: DocumentStore, geometry: GeometryBackend, featureId: string) {
  const f = asFeature(store.document.features.find((x) => x.id === featureId), "import");
  if (!f?.link) return;
  const text = await readDocumentText(f.link.path);
  if (text === null) {
    await say(`Couldn't read ${f.link.path}, it may have moved`, "error");
    return;
  }
  const res = await updateFundaLink(store, geometry, featureId, { path: f.link.path, text }, await tempStepPath());
  if (!res.ok && !res.cancelled) await say(`Couldn't update ${baseName(f.link.path)}: ${res.message}`, "error");
}

/** Keep the geometry and forget the file, the body becomes an ordinary import. */
export function unlink(store: DocumentStore, featureId: string) {
  store.updateFeature(featureId, { link: undefined } as Partial<Feature>);
}

/** After a document opens: say which linked files changed or went missing. */
export async function checkLinks(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) return;
  const { changed, missing } = await staleLinks(store.document.features, readDocumentText);
  if (changed.length) {
    const names = changed.map((id) => nameOf(store, id)).join(", ");
    await say(`${names} changed since ${changed.length === 1 ? "it was" : "they were"} linked`, "info", {
      label: "Update",
      onClick: () => void (async () => { for (const id of changed) await refreshLink(store, geometry, id); })(),
    });
  }
  if (missing.length) {
    await say(`Couldn't find the linked file for ${missing.map((id) => nameOf(store, id)).join(", ")}`, "error");
  }
}

function nameOf(store: DocumentStore, id: string): string {
  const f = asFeature(store.document.features.find((x) => x.id === id), "import");
  return f?.name || (f?.link ? baseName(f.link.path) : id);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}
