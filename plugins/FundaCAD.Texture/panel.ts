// Module refs, not a pinia store, since a plugin's pinia would have to agree with the app's. The component is mounted
// for the plugin's whole life through contributedOverlays() and decides itself whether to draw.

import { ref, shallowRef } from "vue";
import type { TextureMode, TextureValues } from "./textureForm";

/** Replaced wholesale on each show(), never mutated in place. */
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

/** null when the tool is not running. shallowRef because the request's closures reach the viewport and the document
 *  store, which must not become reactive proxies. */
export const request = shallowRef<TextureReq | null>(null);

/** Its own ref, not a request field: the tool rewrites it several times a second, and replacing the request would
 *  remount the form and take the focus out of the field being typed into. */
export const summary = ref("");

/** Which of Faces / Whole Body the toggle shows as active. */
export const mode = ref<TextureMode>("faces");

let nextId = 1;

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

/** Does not close: the tool refuses a commit with no target and stays active, and closing here would strand the user in
 *  an invisible modal. The tool's cleanup() closes this once a commit is accepted. */
export function commit(v: TextureValues): void {
  request.value?.onCommit(v);
}

/** Reads the callback, tears the panel down, then calls it. */
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
