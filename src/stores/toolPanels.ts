import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { TextValues } from "../sketch/textForm";
import type { ProjectFilter } from "../sketch/projectPanel";
import type { MeasureRow } from "../features/measureRows";
import type { MirrorFieldKey } from "../features/mirrorFields";

/** Floating overlays the app's own running tools own: sketch Text panel, Project filter chips, Measure readout and
 *  the Mirror fields. Plugin panels mount through `contributedOverlays()`. markRaw every request, its closures reach
 *  the Viewport. */

export interface TextReq {
  /** bumped per show() so the component remounts with fresh form state */
  id: number;
  screen: { x: number; y: number };
  fonts: string[];
  initial: Partial<TextValues>;
  onCommit: (v: TextValues) => void;
  onCancel: () => void;
  onChange: (v: TextValues) => void;
}

export interface MirrorFieldView {
  key: MirrorFieldKey;
  label: string;
  /** One label per picked item, in pick order. */
  items: readonly string[];
  value: string;
  filled: boolean;
}

/** Replaced whole on every change; `id` changes only when the tool starts again, so it keys the component. */
export interface MirrorPanelView {
  id: number;
  fields: readonly [MirrorFieldView, MirrorFieldView];
  active: MirrorFieldKey;
  /** The base plane chips, empty in a sketch; `plane` is the one picked, if it is one of them. */
  planes: readonly string[];
  plane: string | null;
  ready: boolean;
  onActivate(k: MirrorFieldKey): void;
  onClear(k: MirrorFieldKey): void;
  onRemove(k: MirrorFieldKey, i: number): void;
  onPlane(p: string): void;
  onCommit(): void;
  onCancel(): void;
}

export const useToolPanelStore = defineStore("toolPanels", () => {
  let nextId = 1;

  const text = shallowRef<TextReq | null>(null);

  function openText(req: Omit<TextReq, "id">) {
    text.value = markRaw({ ...req, id: nextId++ });
  }

  /** Tears the panel down before calling onCommit, so an onCommit that reopens it is not undone by our own hide.
   *  Empty text is dropped rather than committed. */
  function commitText(v: TextValues) {
    const cb = text.value?.onCommit;
    text.value = null;
    if (v.text.trim()) cb?.(v);
  }

  function cancelText() {
    const cb = text.value?.onCancel;
    text.value = null;
    cb?.();
  }

  /** Survives hide/show: the chosen filter is tool state, not panel state. */
  const projectFilter = ref<ProjectFilter>("edges");
  /** The canvas rect the chips centre themselves over, or null when hidden. */
  const projectAnchor = shallowRef<DOMRect | null>(null);
  const projectChange = shallowRef<((f: ProjectFilter) => void) | null>(null);

  /** null = the tool is not running; [] would be an empty panel. */
  const measure = shallowRef<readonly MeasureRow[] | null>(null);

  const mirror = shallowRef<MirrorPanelView | null>(null);

  return {
    text,
    openText,
    commitText,
    cancelText,
    projectFilter,
    projectAnchor,
    projectChange,
    measure,
    mirror,
  };
});
