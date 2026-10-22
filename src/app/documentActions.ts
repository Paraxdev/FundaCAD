import {
  importDropped,
  importFileBytes,
  openDocument,
  openDocumentAtPath,
  reportError,
  type OpenOutcome,
} from "../io/files";
import { choose } from "../ui/choice";
import type { Engine } from "./engine";
import { TEMPLATES, templateFile, templateText, type TemplateInfo } from "../templates";
import { copyName } from "../ui/homeVersions";
import { closeHome, homeIsOpen } from "../ui/home";
import { displayName } from "../ui/homeList";

/** An open sketch's edits reach the store only when the sketch is finished, so
 *  `store.dirty` alone misses them. */
export function hasUnsavedWork(e: Pick<Engine, "store" | "sketch">): boolean {
  return e.store.dirty || e.sketch.hasUncommittedEdits;
}

export async function mayDiscard(e: Pick<Engine, "store" | "sketch">, question: string): Promise<boolean> {
  if (!hasUnsavedWork(e)) return true;
  const pick = await choose(question, [
    { value: "discard", label: "Discard", hint: "lose the unsaved changes" },
    { value: "cancel", label: "Cancel" },
  ]);
  if (pick !== "discard") return false;
  e.store.markGivenUp();
  return true;
}

export async function openPathGuarded(
  e: Pick<Engine, "store" | "sketch" | "geometry">,
  path: string,
): Promise<OpenOutcome | "cancelled"> {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (!(await mayDiscard(e, `Discard unsaved changes and open ${name}?`))) return "cancelled";
  return openDocumentAtPath(e.store, path, e.geometry);
}

/** "frame" from frame.stp.gz: the name a document takes from the file imported into it. */
export function importedName(file: string): string {
  return displayName(file.replace(/\.(gz|zip)$/i, ""));
}

/** The document every first start shows behind Home. */
export function isBlankDocument(e: Pick<Engine, "store" | "sketch">): boolean {
  return (
    !e.store.filePath &&
    !e.store.document.features.length &&
    !e.store.dirty &&
    !e.sketch.active &&
    !e.store.importRunning &&
    !openingImports.has(e.store)
  );
}

// A document an import is opening has no feature until its file is read, yet it is not blank.
const openingImports = new WeakMap<object, object>();

/** Marks `store`'s document as opened by an import until `end`, or until another document is opened. */
function openingImport(store: Engine["store"]) {
  const mark = {};
  openingImports.set(store, mark);
  const leave = () => {
    if (openingImports.get(store) === mark) openingImports.delete(store);
  };
  let replaced = false;
  const offOpen = store.onOpen(() => {
    replaced = true;
    leave();
  });
  return {
    get replaced() {
      return replaced;
    },
    end() {
      offOpen();
      leave();
    },
  };
}

type HomeImportEngine = Pick<Engine, "store" | "sketch" | "viewport">;

const landedFrom = (store: Engine["store"], files: readonly string[]) =>
  store.document.features.some((f) => {
    const source = f.type === "import" ? f.source : undefined;
    return typeof source === "string" && files.includes(source.split(/[\\/]/).pop() ?? source);
  });

// Only the name the import gave is taken back. A new document would cancel what the maker started during the read,
// an import added, an environment dropped or a sketch, and a cancelled build keeps its import on the redo stack.
function backToBlank(store: Engine["store"], name: string, files: readonly string[]): void {
  if (store.filePath || store.fileName !== name || landedFrom(store, files)) return;
  store.dropPathlessName();
}

async function importNamed(
  e: HomeImportEngine,
  name: string,
  files: readonly string[],
  run: () => Promise<unknown>,
): Promise<void> {
  e.store.markOpenedWithoutPath(name);
  closeHome();
  const opening = openingImport(e.store);
  try {
    await run();
  } finally {
    opening.end();
  }
  if (!opening.replaced) backToBlank(e.store, name, files);
}

/** A blank document takes the files, anything else asks whether they join it or start a new one. `run` is the
 *  caller's own import loop. False when the maker cancelled and nothing ran. */
export async function importFromHome(
  e: HomeImportEngine,
  names: string[],
  run: () => Promise<unknown>,
): Promise<boolean> {
  const first = names[0];
  if (first === undefined) return false;
  if (isBlankDocument(e)) {
    await importNamed(e, importedName(first), names, run);
    return true;
  }
  const doc = displayName(e.store.fileName);
  const what = names.length > 1 ? `${first} and ${names.length - 1} more` : first;
  const pick = await choose(
    `Add ${what} to ${doc}, or start a new document with ${names.length > 1 ? "them" : "it"}?`,
    [
      { value: "add", label: `Add to ${doc}` },
      { value: "new", label: "New document" },
      { value: "cancel", label: "Cancel" },
    ],
  );
  if (pick === "add") {
    closeHome();
    await run();
    return true;
  }
  if (pick !== "new" || !(await mayDiscard(e, "Discard unsaved changes and start a new document?"))) return false;
  e.store.newDocument();
  e.viewport.resetCamera(false);
  await importNamed(e, importedName(first), names, run);
  return true;
}

/** Imports go into the open document, as assemblies are built, unless Home is up. */
export async function placeImport(e: HomeImportEngine, names: string[], run: () => Promise<unknown>): Promise<boolean> {
  if (homeIsOpen()) return importFromHome(e, names, run);
  await run();
  return true;
}

type ExampleEngine = Pick<Engine, "store" | "sketch" | "viewport" | "geometry" | "frameNextModel">;

/** Save then asks where to keep it, so the template itself is never written. */
export async function newFromTemplate(e: ExampleEngine, id: string): Promise<void> {
  const info = TEMPLATES.find((t) => t.id === id);
  if (!info) return;
  if (!(await mayDiscard(e, "Discard unsaved changes and start a new document?"))) return;
  if (info.source === "step") return importExample(e, info);
  e.store.load(await templateText(id));
  e.store.markOpenedWithoutPath(info.name);
  e.frameNextModel();
}

/** The import a maker's own STEP takes, into a new document that stays clean until the maker changes it. */
async function importExample(e: ExampleEngine, info: TemplateInfo): Promise<void> {
  e.store.newDocument();
  e.viewport.resetCamera(false);
  e.store.markOpenedWithoutPath(info.name);
  closeHome();
  const opening = openingImport(e.store);
  const files: string[] = [];
  try {
    const file = await templateFile(info.id);
    files.push(file.name);
    // importFileBytes watches for an open only from here on, so one during the fetch is caught here.
    if (opening.replaced) await importDropped([file.name]);
    else await importFileBytes(e.store, e.geometry, file, undefined, { opening: true });
  } catch (err) {
    await reportError(`Couldn't open the ${info.name} example: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    opening.end();
  }
  if (!opening.replaced) backToBlank(e.store, info.name, files);
}

type VersionEngine = Pick<Engine, "store" | "sketch" | "geometry" | "toolAtWork" | "setStatus">;

/** A version or branch loads in place, which ends no sketch or tool the way an
 *  open does, so one still at work on the open document holds it back. */
function heldBack(e: VersionEngine, path: string): boolean {
  if (e.store.filePath !== path || !e.toolAtWork()) return false;
  e.setStatus("Finish the sketch or tool first, then try again", "");
  return true;
}

/** The document at `path` on screen: the open one as it is, unsaved versions and
 *  all, or opened from disk after the usual question. */
async function reach(e: VersionEngine, path: string): Promise<boolean> {
  if (e.store.filePath === path) return true;
  return (await openPathGuarded(e, path)) === "ok";
}

/** Brings a version back as one undo step, the file is unchanged until Save. A copy
 *  also drops the path, so Save asks where and the original stays as it is. */
export async function openAtVersion(e: VersionEngine, path: string, id: string, copy: boolean): Promise<boolean> {
  if (heldBack(e, path)) return false;
  if (copy && e.store.filePath === path && !(await mayDiscard(e, "Discard unsaved changes and open a copy?"))) {
    return false;
  }
  if (!(await reach(e, path))) return false;
  const v = e.store.versionRepo?.versions.find((x) => x.id === id);
  if (!v) return false;
  e.store.restoreVersion(id);
  if (copy) e.store.markOpenedWithoutPath(copyName(path, v.message));
  return true;
}

/** Opening on the branch the file is already on keeps its saved state, which may be newer than the branch's last version. */
export async function openOnBranch(e: VersionEngine, path: string, name: string): Promise<boolean> {
  if (heldBack(e, path)) return false;
  if (!(await reach(e, path))) return false;
  const repo = e.store.versionRepo;
  if (!repo?.branches[name]) return false;
  if (repo.current !== name) e.store.switchVersionBranch(name);
  return true;
}

export function createDocumentActions(e: Engine): Pick<Engine, "newDocument" | "openDoc" | "doUndo" | "doRedo"> {
  return {
    async newDocument() {
      if (!(await mayDiscard(e, "Discard unsaved changes and start a new document?"))) return;
      e.store.newDocument();
      e.viewport.resetCamera(false);
    },

    async openDoc() {
      await openDocument(
        e.store,
        e.geometry,
        () => mayDiscard(e, "Discard unsaved changes and open another document?"),
        (names, run) => placeImport(e, names, run),
      );
    },

    // An open sketch swallows undo, since store.undo() would remove the whole sketch. Move is put away first, or a
    // re-open waiting on a drag's rebuild lands on the undone model (FI-2). Home closes so the change is seen.
    doUndo() {
      closeHome();
      e.tools.move.cancel();
      if (!e.sketch.undoEdit()) e.store.undo();
    },
    doRedo() {
      closeHome();
      e.tools.move.cancel();
      if (!e.sketch.redoEdit()) e.store.redo();
    },
  };
}
