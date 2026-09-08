// The tool's view: what is on screen, and the handful of refs that decide it.
//
// This used to be three fields on the application's `toolPanels` pinia store —
// `texture`, `textureSummary`, `textureMode` — plus a facade class over them.
// The fields worked. What they cost was a store in src/stores/ whose shape was a
// list of the tools the application happens to have, so a second plugin with a
// panel would have been three more fields in a file with no other reason to know
// a plugin exists.
//
// So the state is here, in the plugin, as three module-level refs. Not a pinia
// store: a store buys dev-tools inspection and `$reset`, and costs a plugin
// instance of pinia agreeing with the application's, which is exactly the shape
// of bug the shared-module rule in the loader exists to prevent. Plain refs from
// the application's own Vue are enough for three values read by one component.
//
// The component that reads them is mounted for the whole life of the plugin
// through `contributedOverlays()`, and decides for itself whether to draw —
// which is the contract that point states. `App.vue` used to carry a
// `v-if="toolPanels.texture"` for this panel, and that `v-if` was the
// application knowing this tool exists.

import { ref, shallowRef } from "vue";
import type { TextureMode, TextureValues } from "./textureForm";

/** Everything the panel needs to draw itself once, and the four ways back to
 *  the tool. Replaced wholesale on each show(); never mutated in place. */
export interface TextureReq {
  /** Bumped per show() so the component remounts with fresh form state. */
  id: number;
  editing: boolean;
  initial: Partial<TextureValues>;
  palette: { name: string; color: string }[];
  onCommit: (v: TextureValues) => void;
  onCancel: () => void;
  onChange: (v: TextureValues) => void;
  onModeChange: (mode: TextureMode) => void;
}

/** null = the tool is not running, and the panel draws nothing.
 *
 *  `shallowRef`, because the request carries four closures over the tool, which
 *  closes over the viewport and the document store. None of that may become a
 *  reactive proxy. */
export const request = shallowRef<TextureReq | null>(null);

/** The live selection summary, rewritten on every rAF tick of the tool.
 *
 *  Its own ref rather than a field on the request, and this is load-bearing:
 *  the tool rewrites it several times a second while faces are being clicked,
 *  and folding it into the request would replace the request object, remount
 *  the form and take the focus out of whatever field was being typed into. */
export const summary = ref("");

/** Which of Faces / Whole Body the toggle shows as active. */
export const mode = ref<TextureMode>("faces");

let nextId = 1;

/** Open the panel. */
export function show(
  opts: {
    editing: boolean;
    mode: TextureMode;
    summary: string;
    initial: Partial<TextureValues>;
    palette?: { name: string; color: string }[];
  },
  handlers: {
    onCommit: (v: TextureValues) => void;
    onCancel: () => void;
    onChange: (v: TextureValues) => void;
    onModeChange: (mode: TextureMode) => void;
  },
): void {
  summary.value = opts.summary;
  mode.value = opts.mode;
  request.value = {
    id: nextId++,
    editing: opts.editing,
    initial: opts.initial,
    palette: opts.palette ?? [],
    ...handlers,
  };
}

export function hide(): void {
  request.value = null;
}

export function isOpen(): boolean {
  return request.value !== null;
}

/** Commit, and DELIBERATELY do not close.
 *
 *  The tool refuses a commit with no target and stays active. Closing here first
 *  stranded the user in an invisible modal: the panel was gone, the tool still
 *  owned face-picking, and toolBusy() blocked every other Escape handler in the
 *  application. The tool's own cleanup() closes this once a commit is accepted. */
export function commit(v: TextureValues): void {
  request.value?.onCommit(v);
}

/** Cancel, with the ordering the old class had: read the callback, tear the
 *  panel down, THEN call it. */
export function cancel(): void {
  const cb = request.value?.onCancel;
  request.value = null;
  cb?.();
}

/** Drop everything. Tests only: a suite that leaves the panel open changes what
 *  the next one renders. */
export function resetPanel(): void {
  request.value = null;
  summary.value = "";
  mode.value = "faces";
}
