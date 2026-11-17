// The native side of inserting and linking FundaCAD documents: the dialog, reading off disk, the private STEP bake.
// io/fundaInsert.ts holds the part that needs no native shell.

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { t } from "../i18n";
import { asFeature, type Feature } from "../types";
import { BINARY_DOC_EXT, DOC_EXT, LEGACY_DOC_EXTS } from "./documentExt";
import {
  baseName,
  insertFundaDocument,
  staleLinks,
  updateFundaLink,
  type FileStat,
  type FundaInsertMode,
  type LinkStat,
} from "./fundaInsert";
import { nameList } from "./nameList";
import { nativeDialog } from "./nativeDialog";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** A document's JSON, binary or JSON on disk, or null when the file cannot be
 *  read. Always through Rust, which also publishes the geometry either format
 *  carries into the blob store. */
export async function readDocumentText(path: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("container_open", { path });
  } catch {
    return null;
  }
}

/** A file's size and time without opening it: missing when it is gone, unknown when the native side refused the
 *  path or could not tell. */
export async function statDocument(path: string): Promise<LinkStat> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<FileStat | null>("container_stat", { path })) ?? "missing";
  } catch {
    return "unknown";
  }
}

// A stat taken before the read, so a change made during the read still shows as stale on the next open.
const statOf = (stat: LinkStat) => (typeof stat === "object" ? { stat } : {});

/** Runs one bake on a fresh path in the app's private bake directory, and removes that file once it is done. */
async function withBake<T>(s: DocumentStore["session"], run: (temp: string) => Promise<T>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  const temp = await s.step(invoke<string>("bake_temp_path"));
  try {
    return await run(temp);
  } finally {
    await invoke("bake_temp_remove", { path: temp }).catch(() => {});
  }
}

async function say(message: string, kind: "info" | "error" = "info", action?: { label: string; onClick: () => void }) {
  const { toast } = await import("../ui/toast");
  toast(message, { kind, ...(action ? { action } : {}) });
}

/** Insert > FundaCAD Document: pick a file, then append or link it. */
export async function insertDocumentFromDialog(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) {
    await say(t("insert.needsDesktop"));
    return;
  }
  // Every wait goes through the document's session, so a file picked for a document closed meanwhile is never put in.
  const s = store.session;
  const { open } = await s.step(nativeDialog());
  const path = await s.step(
    open({
      multiple: false,
      filters: [
        { name: t("files.filter.document"), extensions: [DOC_EXT, BINARY_DOC_EXT, ...LEGACY_DOC_EXTS, "json"] },
      ],
    }),
  );
  if (typeof path !== "string") return;
  if (store.filePath && samePath(path, store.filePath)) {
    await say(t("insert.intoItself"), "error");
    return;
  }
  const { choose } = await s.step(import("../ui/choice"));
  const mode = await s.step(
    choose<FundaInsertMode>(t("insert.title", { name: baseName(path) }), [
      { value: "append", label: t("insert.append"), hint: t("insert.appendHint") },
      { value: "link", label: t("insert.link"), hint: t("insert.linkHint") },
    ]),
  );
  if (!mode) return;
  const stat = mode === "link" ? await s.step(statDocument(path)) : "unknown";
  const text = await s.step(readDocumentText(path));
  if (text === null) {
    await say(t("insert.readFailed", { name: baseName(path) }), "error");
    return;
  }
  const res = await withBake(s, (temp) =>
    insertFundaDocument(store, geometry, { path, text, ...statOf(stat) }, mode, temp),
  );
  if (!res.ok) {
    if (!res.cancelled) await say(t("insert.failed", { name: baseName(path), error: res.message }), "error");
    return;
  }
  await say(t(mode === "link" ? "insert.linked" : "insert.appended", { name: baseName(path) }));
}

/** Re-read one linked step from its file. */
export async function refreshLink(store: DocumentStore, geometry: GeometryBackend, featureId: string) {
  const f = asFeature(
    store.document.features.find((x) => x.id === featureId),
    "import",
  );
  if (!f?.link) return;
  const s = store.session;
  const stat = await s.step(statDocument(f.link.path));
  const text = await s.step(readDocumentText(f.link.path));
  if (text === null) {
    await say(t("insert.moved", { path: f.link.path }), "error");
    return;
  }
  const path = f.link.path;
  const res = await withBake(s, (temp) =>
    updateFundaLink(store, geometry, featureId, { path, text, ...statOf(stat) }, temp),
  );
  if (!res.ok && !res.cancelled)
    await say(t("insert.updateFailed", { name: baseName(f.link.path), error: res.message }), "error");
}

/** Keep the geometry and forget the file, the body becomes an ordinary import. */
export function unlink(store: DocumentStore, featureId: string) {
  store.updateFeature(featureId, { link: undefined } as Partial<Feature>);
}

/** After a document opens: say which linked files changed, may have changed or went missing, from their size and
 *  time alone. Only Update reads a file. */
export async function checkLinks(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) return;
  const s = store.session;
  const { changed, missing, unknown } = await s.step(staleLinks(store.document.features, statDocument));
  const offerUpdate = async (ids: string[], key: "insert.changed" | "insert.mayHaveChanged") => {
    if (!ids.length) return;
    const names = nameList(ids.map((id) => nameOf(store, id)));
    await say(t(key, { n: ids.length, names }), "info", {
      label: t("insert.update"),
      // The ids are this document's; an Update clicked after another document opened has nothing to refresh.
      onClick: () =>
        void (async () => {
          for (const id of ids) if (s.alive) await refreshLink(store, geometry, id);
        })(),
    });
  };
  await offerUpdate(changed, "insert.changed");
  await offerUpdate(unknown, "insert.mayHaveChanged");
  if (missing.length) {
    await say(t("insert.missing", { names: nameList(missing.map((id) => nameOf(store, id))) }), "error");
  }
}

function nameOf(store: DocumentStore, id: string): string {
  const f = asFeature(
    store.document.features.find((x) => x.id === id),
    "import",
  );
  return f?.name || (f?.link ? baseName(f.link.path) : id);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}
