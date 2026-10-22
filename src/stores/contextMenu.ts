import { defineStore } from "pinia";
import { markRaw, ref } from "vue";

export interface CtxItem {
  label: string;
  onClick?: () => void; // omit for separators / pure submenu parents
  disabled?: boolean;
  separator?: boolean; // renders a divider; other fields ignored
  shortcut?: string | undefined; // right-aligned key hint, e.g. "Q" (undefined = no hint from keyHint)
  danger?: boolean; // destructive action (red)
  /** Toggle state. A field rather than a check glyph in the label, so the host reserves one fixed gutter for a real
   *  icon. */
  checked?: boolean;
  swatch?: string; // small color chip before the label (palette flyouts)
  icon?: string; // an Icon name, drawn before the label and in a radial ring
  children?: CtxItem[]; // one-level flyout submenu, opens on hover
  /** Called as the pointer enters (true) and leaves (false), so a row naming something on screen can light it. The host
   *  guarantees the trailing `false`, even when the menu closes under the pointer. */
  onHover?: (hovering: boolean) => void;
}

/** The one shared right-click menu, popped by the viewport, timeline, browser tree, sketch mode and ViewCube.
 *  At most one is open at a time. */
export const useContextMenuStore = defineStore("contextMenu", () => {
  const open = ref(false);
  const x = ref(0);
  const y = ref(0);
  const items = ref<CtxItem[]>([]);
  /** Bumped on every open() so the host can re-run its position measurement
   *  even when a menu is popped at the same coordinates twice in a row. */
  const epoch = ref(0);

  function show(px: number, py: number, list: CtxItem[]) {
    // markRaw: items carry onClick closures over raw engine objects, and proxying them on every open is waste and a
    // hazard.
    items.value = markRaw(list);
    x.value = px;
    y.value = py;
    open.value = true;
    epoch.value++;
  }

  function close() {
    open.value = false;
    items.value = [];
  }

  return { open, x, y, items, epoch, show, close };
});
