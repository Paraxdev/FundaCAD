import type { Engine } from "../app/engine";
import { mayDiscard } from "../app/documentActions";
import {
  importFileBytes,
  importPath,
  openDocumentAtPath,
  openDocumentBytes,
  reportError,
  type OpenOutcome,
} from "./files";
import { describeDropLeftovers, planDrop } from "./dropRouting";
import { closeHome } from "../ui/home";

/** A file dropped on the window: a real path when the desktop app could find
 *  one, else the browser's File object. */
export interface DroppedFile {
  name: string;
  path?: string | null;
  file?: File;
}

type DropEngine = Pick<Engine, "store" | "sketch" | "geometry">;

/** Open the dropped document, if any, then import the rest in drop order. */
export async function takeDroppedFiles(e: DropEngine, items: readonly DroppedFile[]): Promise<void> {
  const plan = planDrop(items, (i) => i.name);
  const leftovers = describeDropLeftovers(plan, (i) => i.name);
  const doc = plan.open;
  if (doc) {
    // Cancelling drops the whole drop: its imports belong to the document that
    // was meant to open, not to the one that stayed.
    if (!(await mayDiscard(e, `Discard unsaved changes and open ${doc.name}?`))) return;
    let outcome: OpenOutcome = "unreadable";
    if (doc.path) outcome = await openDocumentAtPath(e.store, doc.path, e.geometry);
    else if (doc.file) outcome = await openDocumentBytes(e.store, doc.file, e.geometry);
    // The open already said why. Importing now would land in the document the
    // user just chose to discard.
    if (outcome !== "ok") return;
  }
  if (plan.imports.length || plan.environments.length) closeHome();
  for (const item of plan.imports) {
    if (item.path) await importPath(e.store, e.geometry, item.path);
    else if (item.file) await importFileBytes(e.store, e.geometry, item.file);
  }
  const env = plan.environments[plan.environments.length - 1];
  if (env?.file) {
    const { importEnvironmentFile } = await import("../ui/environmentImport");
    const refused = await importEnvironmentFile(e.store, env.file);
    if (refused) await reportError(refused);
  }
  if (leftovers) await reportError(leftovers);
}

function carriesFileType(ev: DragEvent): boolean {
  return !!ev.dataTransfer && Array.from(ev.dataTransfer.types).includes("Files");
}

/** WebKitGTK shows the page neither the files of a desktop drop nor its
 *  uri-list (webkit.org/b/271957), only the type names, so in the Linux app a
 *  uri-list with no Files is taken as a file drag and its paths come from GTK. */
function gtkFileDrag(ev: DragEvent): boolean {
  if (!ev.dataTransfer || !("__TAURI_INTERNALS__" in window) || !/linux/i.test(navigator.platform)) return false;
  const types = Array.from(ev.dataTransfer.types);
  return types.includes("text/uri-list") && !types.includes("Files");
}

interface PathBridge {
  postMessageWithAdditionalObjects(message: string, objects: ArrayLike<File>): void;
}

function pathBridge(): PathBridge | null {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const wv = (window as unknown as { chrome?: { webview?: Partial<PathBridge> } }).chrome?.webview;
  return typeof wv?.postMessageWithAdditionalObjects === "function" ? (wv as PathBridge) : null;
}

/** How long to wait for the desktop app to name the paths before reading the
 *  files as bytes instead. */
const PATH_REPLY_MS = 1500;
let nextRequest = 0;

/** The real paths of dropped files, from src-tauri/src/drop_paths.rs, or null
 *  when nothing answered. `send` puts the request to it. */
async function askPaths(send: (id: string) => unknown): Promise<(string | null)[] | null> {
  const { listen } = await import("@tauri-apps/api/event");
  const id = String(++nextRequest);
  let settle: (paths: (string | null)[] | null) => void = () => {};
  const reply = new Promise<(string | null)[] | null>((resolve) => {
    settle = resolve;
  });
  const unlisten = await listen<{ id: string; paths: (string | null)[] }>("files-dropped", (ev) => {
    if (ev.payload.id === id) settle(ev.payload.paths);
  });
  const timer = setTimeout(() => settle(null), PATH_REPLY_MS);
  try {
    await send(id);
    return await reply;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

async function collect(files: File[]): Promise<DroppedFile[]> {
  const bridge = pathBridge();
  const paths = bridge
    ? await askPaths((id) => bridge.postMessageWithAdditionalObjects(`fundacad-drop:${id}`, files))
    : null;
  return files.map((file, i) => ({ name: file.name, path: paths?.[i] ?? null, file }));
}

/** The files of a WebKitGTK drop, by the paths GTK held for it. There are no
 *  bytes to fall back on. */
async function collectFromGtk(): Promise<DroppedFile[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const paths = await askPaths((id) => invoke("drop_paths_take", { id }));
  return (paths ?? []).flatMap((path) => (path ? [{ name: path.split("/").pop() || path, path }] : []));
}

/** Listen for files dragged onto the window from the desktop. `hint` is told
 *  when a file drag is over the window. Drags that carry no files, a material
 *  chip, a timeline step, a tree row, are never touched. */
export function installDesktopDrop(e: DropEngine, hint: (shown: boolean) => void): () => void {
  let depth = 0;
  let queue: Promise<void> = Promise.resolve();
  // Chromium lists "Files" on the drag of an <img>, a material swatch among
  // them, so the types alone cannot tell it from a desktop file. A drag from
  // outside never fires dragstart in this window.
  let inPage = false;
  const carriesFiles = (ev: DragEvent) => !inPage && (carriesFileType(ev) || gtkFileDrag(ev));
  const hide = () => {
    depth = 0;
    hint(false);
  };
  const onStart = () => {
    inPage = true;
  };
  const onEnd = () => {
    inPage = false;
    hide();
  };

  const onEnter = (ev: DragEvent) => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    depth++;
    hint(true);
  };
  const onOver = (ev: DragEvent) => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    if (depth === 0) {
      depth = 1;
      hint(true);
    }
  };
  const onLeave = (ev: DragEvent) => {
    if (!carriesFiles(ev)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  };
  const onDrop = (ev: DragEvent) => {
    if (!carriesFiles(ev)) {
      inPage = false;
      return;
    }
    // Always cancelled for a file drag, or the webview navigates to the file.
    ev.preventDefault();
    hide();
    const files = Array.from(ev.dataTransfer?.files ?? []);
    const fromGtk = !files.length && gtkFileDrag(ev);
    if (!files.length && !fromGtk) return;
    queue = queue
      .then(async () => takeDroppedFiles(e, await (fromGtk ? collectFromGtk() : collect(files))))
      .catch((err) => {
        void reportError(`Couldn't take the dropped files: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  const opts = { capture: true };
  window.addEventListener("dragstart", onStart, opts);
  window.addEventListener("dragenter", onEnter, opts);
  window.addEventListener("dragover", onOver, opts);
  window.addEventListener("dragleave", onLeave, opts);
  window.addEventListener("drop", onDrop, opts);
  window.addEventListener("dragend", onEnd, opts);
  return () => {
    window.removeEventListener("dragstart", onStart, opts);
    window.removeEventListener("dragenter", onEnter, opts);
    window.removeEventListener("dragover", onOver, opts);
    window.removeEventListener("dragleave", onLeave, opts);
    window.removeEventListener("drop", onDrop, opts);
    window.removeEventListener("dragend", onEnd, opts);
  };
}
