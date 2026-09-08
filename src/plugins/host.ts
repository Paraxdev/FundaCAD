// The whole of what a plugin may reach, in one module.
//
// A plugin imports `fundacad` and nothing else from this application. That is
// the point of the file and it is worth being blunt about why, because the
// arrangement it replaces worked perfectly well for the plugins that SHIP here:
// they reached in by relative path — `../../src/app/engine`,
// `../../src/components/overlays/ModalFrame.vue`, nineteen specifiers in all —
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
// broker. `DocumentStore` and `Engine` appear below as TYPES only — erased
// before anything runs — because the plugins that ship here are handed a live
// engine by `activate(e)` and always have been. A downloaded plugin gets what
// its manifest asked for, checked at the broker, and the ops table is the door.
//
// THREE MORE MODULES a plugin may import, and they are not re-exported here
// because they are not ours: `vue`, `three`, and `@tauri-apps/api/*`. A built
// plugin must externalise them for a reason with teeth — two copies of Vue is
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
  MenuContribution,
  Paint,
  PaletteEntry,
  RibbonContribution,
  RibbonEntry,
  SettingsSection,
  Unregister,
} from "./contrib";

// --- the shapes a plugin is handed ------------------------------------------
//
// Types, every one. They describe what `activate(e)` receives and what the
// app's own calls take; none of them is a way to obtain one.
export type { Engine } from "../app/engine";
export type { DocumentStore } from "../document/store";
export type { GeometryBackend } from "../geometry/client";
export type { Viewport } from "../viewport/viewport";
export type { CtxItem, MenuDef, MenuItem } from "../ui/menu";
export type { CadDocument, Feature, PlaneSpec, RebuildResult } from "../types";

// --- telling somebody something ---------------------------------------------
export { toast } from "../ui/toast";
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
