// The whole of what a plugin may reach, in one module.
//
// A plugin imports `fundacad` and nothing else from this application. That is
// the point of the file and it is worth being blunt about why, because the
// arrangement it replaces worked perfectly well for the plugins that SHIP here:
// they reached in by relative path, `../../src/app/engine`,
// `../../src/components/overlays/ModalFrame.vue`, nineteen specifiers in all,
// and every one of those is an internal module that moves when the app is
// refactored.
//
// That is only a maintenance question while a plugin is compiled together with
// the app. It stops being one the moment a plugin is BUILT SEPARATELY and
// downloaded, because then the app it was built against and the app it runs in
// are different versions. What the plugin imports has to be a promise, and a
// promise cannot be "every file under src/".
//
// So this module is the promise. Everything a plugin can see is named here,
// once, on purpose. Adding to it is a deliberate act with a cost; a plugin that
// wants something not on this list needs it added in the open.
//
// WHAT IS NOT HERE, and will not be: anything that lets a plugin reach the
// document, the geometry engine or the file system WITHOUT going through the
// broker. `DocumentStore` and `Engine` appear below as TYPES only, erased
// before anything runs, because the plugins that ship here are handed a live
// engine by `activate(e)` and always have been. A downloaded plugin gets what
// its manifest asked for, checked at the broker, and the ops table is the door.
//
// THREE MORE MODULES a plugin may import, and they are not re-exported here
// because they are not ours: `vue`, `three`, and `@tauri-apps/api/*`. A built
// plugin must externalise them for a reason with teeth, two copies of Vue is
// two reactivity systems that cannot see each other's refs, and two copies of
// three.js is `instanceof` failing between them. scripts/build-plugin-code.mjs
// is what enforces that.
//
// THE COMPONENTS ARE NEXT DOOR, in `fundacad/ui`, and the split is not
// cosmetic: this module must stay importable with no DOM. A plugin's own logic
// tests run in a node environment, exactly as this repository's do, and one
// `.vue` re-exported from here would make every one of them need a DOM to parse
// a file it never renders. Anything that drags Vue in goes there; everything
// else goes here.

// --- the contribution table: the only way onto the app's surfaces -----------
export {
  contribute,
  contributedPalette,
  onContribChange,
  service,
} from "./contrib";
export type {
  BrowserSection,
  Contribution,
  FeatureTypeContribution,
  MenuContribution,
  Paint,
  PaletteEntry,
  RibbonContribution,
  RibbonEntry,
  SettingsSection,
  ToolContribution,
  Unregister,
} from "./contrib";

// The shapes those two new points are written in. Types only: a plugin fills
// them in, the application reads them, and neither needs anything at runtime.
export type { ChoiceField, ChoiceOption, ToggleField } from "../document/optionFields";
export type { FeatureMeta } from "../ui/featureMeta";
export type { EntityKind, EntitySource } from "../features/toolCapabilities";

// --- the shapes a plugin is handed ------------------------------------------
//
// Types, every one. They describe what `activate(e)` receives and what the
// app's own calls take; none of them is a way to obtain one.
export type { Engine } from "../app/engine";
export type { DocumentStore } from "../document/store";
export type { GeometryBackend } from "../geometry/client";
export type { Viewport } from "../viewport/viewport";
export type { CtxItem, MenuDef, MenuItem } from "../ui/menu";
export type { CadDocument, Feature, Num, PlaneSpec, RebuildResult, Selector } from "../types";

// --- telling somebody something ---------------------------------------------
export { toast } from "../ui/toast";
/** The line under the viewport that says what a running tool wants next.
 *
 *  A modal gesture with no prompt is a window that has stopped responding to
 *  half its own commands for a reason it does not state, so a plugin whose tool
 *  takes over the pick needs this as much as the application's own do. Passing
 *  null clears it, and a tool's teardown must. */
export { setPrompt } from "../ui/prompt";
export { choose, listModal } from "../ui/choice";
/** A failed write, as a native dialog in the app and the console outside it. */
export { reportError } from "../io/files";
/** A breadcrumb that survives twenty later toasts, for a bug report. */
export { stickyFact } from "../diagnostics/breadcrumbs";

// --- remembering something ---------------------------------------------------
/** One `fundacad.*` localStorage key, read forward through its older names. */
export { readSetting } from "../ui/storedSetting";

// --- the document, as a name rather than as content --------------------------
export { stripDocumentExt } from "../io/documentExt";

// --- reading the app's live state from inside a component --------------------
export { useEngine } from "../app/engineKey";
export { useBuildValue, useDocValue } from "../app/useDoc";
export { useBrowserStore } from "../stores/browser";

// --- the Rust side ------------------------------------------------------------
//
// READ THIS BEFORE ADDING ANYTHING NEAR IT. `invoke` calls any command the
// application registered, which is the app's own reach and nothing less: it
// goes around the broker, around the grant list, and around the consent screen.
// A plugin holding it can do whatever this application can do.
//
// It is here because the capabilities that need it cannot exist without it. A
// 3D mouse plugin's whole job is `spacemouse_start` and an event stream; a
// printer plugin's is a dozen printer commands. Neither is expressible as a
// broker op, and inventing one op per Rust command would be the same reach
// wearing a longer name.
//
// So it is the reason a bundle carrying app-side code may be loaded ONLY from
// an origin this project signed. That is not a policy statement to be softened
// later: it is the single condition under which handing out this export is
// defensible, and `sandboxNote("builtin")` already tells the person exactly
// that in the words they will read.
export { invoke } from "@tauri-apps/api/core";
export { listen } from "@tauri-apps/api/event";
export type { UnlistenFn } from "@tauri-apps/api/event";

/** The native save dialog, or null when dismissed.
 *
 *  A wrapper rather than a re-export, so the plugin has no DYNAMIC import of a
 *  package to resolve. The laziness is real and stays on this side: the dialog
 *  plugin is a chunk the app loads the first time anything saves. */
export async function saveDialog(opts: {
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save(opts);
}

/** The native open dialog, or null when dismissed. Single selection only: a
 *  plugin that wanted many would be describing a different gesture. */
export async function openDialog(opts: {
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ ...opts, multiple: false });
  return typeof picked === "string" ? picked : null;
}

// --- the one app setting a plugin governs ------------------------------------
//
// Here because the plugin that owns the "Assistants" block is the MCP bundle,
// and the setting itself is the app's: it decides what the app will accept from
// an assistant, so it has to keep meaning something with no plugin installed.
export {
  asLiveEditingMode,
  liveEditingMode,
  onLiveEditingChange,
  setLiveEditingMode,
} from "../ui/liveEditing";
