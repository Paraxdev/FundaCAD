import { defineStore } from "pinia";
import { markRaw, ref } from "vue";

export interface CtxItem {
  label: string;
  onClick?: () => void; // omit for separators / pure submenu parents
  disabled?: boolean;
  separator?: boolean; // renders a divider; other fields ignored
  shortcut?: string | undefined; // right-aligned key hint, e.g. "Q" (undefined = no hint from keyHint)
  danger?: boolean; // destructive action (red)
  /** Toggle state. Callers used to express this by prefixing the label with
   *  a check character or four spaces to keep the two states the same width,
   *  which put a glyph inside a string the menu then had to render verbatim and
   *  pinned the alignment to whatever the font did with a space. As a field the
   *  host can reserve one fixed gutter and drop a real icon in it. */
  checked?: boolean;
  swatch?: string; // small color chip before the label (palette flyouts)
  children?: CtxItem[]; // one-level flyout submenu, opens on hover
  /** Called as the pointer enters (true) and leaves (false) this row.
   *
   *  For a menu whose entries name things that are ON SCREEN: the ambiguous-edge
   *  chooser lights the edge each row refers to, so which is which is answered
   *  by looking at the model rather than by reading two similar sentences. The
   *  host guarantees the trailing `false` — closing the menu while a row is
   *  hovered fires it, because a preview left lit by a menu that no longer
   *  exists is a highlight nothing can clear. */
  onHover?: (hovering: boolean) => void;
}

/** The one shared right-click menu — viewport, timeline, browser tree, sketch
 *  mode and the ViewCube all pop it. At most one is open at a time, which is
 *  what the old module-level `activeClose` singleton enforced. */
export const useContextMenuStore = defineStore("contextMenu", () => {
  const open = ref(false);
  const x = ref(0);
  const y = ref(0);
  const items = ref<CtxItem[]>([]);
  /** Bumped on every open() so the host can re-run its position measurement
   *  even when a menu is popped at the same coordinates twice in a row. */
  const epoch = ref(0);

  function show(px: number, py: number, list: CtxItem[]) {
    // markRaw: every item carries an onClick closure over raw engine objects
    // (features, body ids, Three.js selectors). Proxying the tree per open would
    // be pure waste, and a Feature riding along inside one would be a hazard.
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
