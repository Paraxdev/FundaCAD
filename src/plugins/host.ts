// `fundacad`, the whole of what a plugin may import from the app. It is a promise across versions, since a downloaded
// plugin runs in an app it was not built against. Nothing here reaches the document, engine or disk around the broker.

import { useDialogStore } from "../stores/dialogs";
import { pluginFocus } from "./settingsFocus";

// The contribution table, the only way onto the app's surfaces.
export { contribute, contributedPalette, onContribChange, service } from "./contrib";
export type {
  BrowserSection,
  Contribution,
  FeatureTypeContribution,
  MaterialPresetGroup,
  MenuContribution,
  Paint,
  PaletteEntry,
  Relief,
  ReliefMap,
  RenderSection,
  RenderTab,
  RibbonContribution,
  RibbonEntry,
  SettingsSection,
  ToolContribution,
  Unregister,
} from "./contrib";

// Row shapes a FeatureTypeContribution is written in. Types only: a plugin cannot reach into src/.
export type { ChoiceField, ChoiceOption, FileField, ToggleField } from "../document/optionFields";
// The numeric and geometry selection rows a plugin that owns a feature type has to describe.
export type { FieldKind } from "../document/numFields";
export type { TargetField } from "../features/selectionTargets";
export type { FeatureMeta } from "../ui/featureMeta";
export type { EntityKind, EntitySource } from "../features/toolCapabilities";

// Types for what `activate(e)` receives and what the app's calls take. None is a way to obtain one.
export type { Engine } from "../app/engine";
export type { DocumentStore } from "../document/store";
export type { GeneratedShape, GeneratedShapeReply, GeometryBackend, ShapePlacement } from "../geometry/client";
// The engine's printability check, as `GeometryBackend.printability` takes and answers it.
export type {
  PrintabilityCheck,
  PrintabilityFinding,
  PrintabilityKind,
  PrintabilityOptions,
  PrintabilityReply,
  PrintabilityResult,
  PrintabilityUp,
} from "../geometry/client";
export type { Viewport } from "../viewport/viewport";
// A sketch plane's frame, for a plugin that places things in plane coordinates.
export { SketchPlane } from "../sketch/plane";
export type { CtxItem, MenuDef, MenuItem } from "../ui/menu";

// What the buttons and keys do. Contributing bindings or a keymap needs the input.remap grant.
export { openMenuAt, dismissRadialMenu, radialMenuOpen } from "../ui/menu";
export type { MenuAtOptions } from "../ui/menu";
export type { RadialTrigger } from "../ui/radialMenu";
export {
  DEFAULT_BINDINGS,
  bindingKeys,
  bindingRows,
  pointerBindings,
  validateBindings,
} from "../viewport/navigator/bindings";
export type { PointerBinding, PointerButton, PointerDrag, PointerGesture } from "../viewport/navigator/bindings";
export {
  SHORTCUTS,
  activeShortcuts,
  checkShortcut,
  describeShortcutProblem,
  formatShortcut,
  keyHint,
} from "../input/shortcuts";
export type { Shortcut, ShortcutOverride, ShortcutProblem } from "../input/shortcuts";
export type { CadDocument, Feature, Num, PlaneSpec, RebuildResult, Selector } from "../types";

// `engine.tools.move.startTarget(target, done)` puts the app's gizmo on whatever a MoveTarget describes, so a plugin
// never draws a second one. A second startTarget replaces the first, and `move.cancel()` is safe with nothing up.
export { ALL_HANDLES, IN_PLANE_HANDLES, WORLD_FRAME } from "../features/moveTarget";
export type { Frame, MoveCommit, MoveHandleSet, MoveResult, MoveTarget } from "../features/moveTarget";

export { toast } from "../ui/toast";
/** The line under the viewport that says what a running tool wants next. A plugin tool that takes over the pick needs
 *  it. Passing null clears it, and a tool's teardown must. */
export { setPrompt } from "../ui/prompt";
export { choose, listModal } from "../ui/choice";
/** A failed write, as a native dialog in the app and the console outside it. */
export { reportError } from "../io/files";
/** A text file the person picks to write or to read, a download or an upload in a browser. */
export { openTextFile, saveTextFile } from "../io/files";
// A file a plugin downloaded goes through the same import as one the person
// picked. `source` is what the feature records instead of the local path.
export { importPath } from "../io/files";
/** A breadcrumb that survives twenty later toasts, for a bug report. */
export { stickyFact } from "../diagnostics/breadcrumbs";

/** Every palette command by its `Engine.handleAction` id, so another input can bind to commands without a second
 *  list. */
export { allCommands } from "../ui/commands";
export type { Command } from "../ui/commands";

/** One `fundacad.*` localStorage key, read forward through its older names. */
export { readSetting } from "../ui/storedSetting";
/** A plugin's own settings, drawn under its row in Preferences > Plugins. */
export { definePluginSettings } from "./settings";
/** Opens Preferences on the plugin's row with its settings expanded. */
export function openPluginSettings(pluginId: string) {
  pluginFocus.value = pluginId;
  useDialogStore().openPreferences();
}
export type { PluginSettings, SettingProp, SettingValues, SettingsSchema } from "./settings";

/** The app's display precision rule, so a plugin's readout rounds a length like every other panel. */
export { roundForDisplay as displayRound } from "../ui/measure";
/** Number boxes read through the app's measure grammar (units, fractions, arithmetic, decimal comma). */
export { fieldNumber, fieldError } from "../ui/measure";

export { stripDocumentExt } from "../io/documentExt";

export { bodyLabels, labelledBodies } from "../ui/bodyLabels";

// Parameter controls, configurations and checks. The data is the document's, so a rename keeps it right with no plugin
// loaded; what a panel computes lives with the engine, so the panel and the store's commits cannot disagree.
export {
  captureConfiguration,
  checkResults,
  clampToControl,
  configurationDrift,
  controlProblem,
  trialConfiguration,
} from "../params/extras";
export type { CheckResult } from "../params/extras";
export type { BodyFinish, MaterialDef, SurfaceGraph, SurfaceNode } from "../document/materials";
export { evalExpr } from "../params/eval";
export type { ParamCheck, ParamConfiguration, ParamControl, ParamDef, ParamExtras } from "../types";

// The app's live state, read from inside a component.
export { useEngine } from "../app/engineKey";
export { useBuildValue, useDocValue } from "../app/useDoc";
export { useBrowserStore } from "../stores/browser";

// `invoke` is the app's whole reach, around the broker, grants and consent screen. Some capabilities need it, which is
// why a bundle with app-side code loads ONLY from an origin this project signed. Never soften that condition.
export { invoke } from "@tauri-apps/api/core";
export { listen } from "@tauri-apps/api/event";
export type { UnlistenFn } from "@tauri-apps/api/event";

/** Null when dismissed. A wrapper rather than a re-export, so the plugin has no dynamic import to resolve. */
export async function saveDialog(opts: {
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save(opts);
}

/** Null when dismissed. Single selection only. */
export async function openDialog(opts: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ ...opts, multiple: false });
  return typeof picked === "string" ? picked : null;
}
