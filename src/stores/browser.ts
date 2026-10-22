import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { EMPTY_SELECTION, type RowSelection } from "../ui/rowSelection";

/** Assembly nodes ("n:<featureId>/<index>") start collapsed, folders ("f:Bodies") do not. Derived from the key,
 *  since a write inside the panel's computed would loop; namespaced so STEP names cannot collide. */
function collapsedByDefault(key: string): boolean {
  // A 3,000-part import must not paint 3,000 rows on arrival.
  return key.startsWith("n:");
}

/** Held here, not in `dataTransfer`, which is unreadable until the drop, so a row on `dragover` could not decide. */
export type BrowserDrag = { kind: "bodies"; ids: readonly string[] } | { kind: "element"; id: string };

/** Browser view state that is neither in the document nor derivable from a rebuild. */
export const useBrowserStore = defineStore("browser", () => {
  /** Only the sections the user toggled. The rest fall back to collapsedByDefault(). */
  const overrides = ref(new Map<string, boolean>());

  /** Mirrored from the non-reactive Viewport by app/viewportWiring.ts, one assignment per change, so rows need no
   *  per-body scan. shallowRef because the value is replaced wholesale. */
  const selectedBodyIds = shallowRef<readonly string[]>([]);

  /** Set by "Rename…" on the viewport's body menu. The panel opens the enclosing folders, and the owning row starts its
   *  inline edit and clears it, even when it was off screen. */
  const pendingRenameId = ref<string | null>(null);

  /** Bumped for display state that changes without a store emit, like sketch and construction plane visibility.
   *  The DEV `window.tree.refresh()` handle bumps it for e2e/browser_tree_perf.cjs. */
  const viewTick = ref(0);

  /** shallowRef because the value is replaced wholesale and its `ids` are never edited in place. */
  const drag = shallowRef<BrowserDrag | null>(null);

  /** A drag across the eyes is in progress (ui/visibilityPaint.ts). Rows then refuse their own HTML5 drag, or a press
   *  on a body's eye followed by a move would pick the body up. */
  const painting = ref(false);

  /** The several sketches Browser Ctrl and Shift clicks gather. stores/selection.ts holds the ONE the timeline and
   *  inspector follow, and this is resynced when that changes from elsewhere. */
  const sketchSelection = shallowRef<RowSelection<string>>(EMPTY_SELECTION);

  /** Where a Shift-click on a body row measures its run from. The selection itself lives in the viewport. */
  const bodyAnchor = ref<string | null>(null);

  function isCollapsed(key: string): boolean {
    return overrides.value.get(key) ?? collapsedByDefault(key);
  }
  function toggle(key: string) {
    overrides.value.set(key, !isCollapsed(key));
  }
  function expand(key: string) {
    overrides.value.set(key, false);
  }

  return {
    overrides,
    selectedBodyIds,
    pendingRenameId,
    viewTick,
    drag,
    painting,
    sketchSelection,
    bodyAnchor,
    isCollapsed,
    toggle,
    expand,
    startDrag: (d: BrowserDrag) => {
      drag.value = d;
    },
    // Called from dragend, which fires even when the drop was abandoned over the desktop.
    endDrag: () => {
      drag.value = null;
    },
    setSelectedBodies: (ids: readonly string[]) => {
      selectedBodyIds.value = ids;
    },
    beginRename: (id: string) => {
      pendingRenameId.value = id;
    },
    bumpView: () => {
      viewTick.value++;
    },
  };
});
