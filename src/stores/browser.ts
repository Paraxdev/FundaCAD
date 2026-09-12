import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { EMPTY_SELECTION, type RowSelection } from "../ui/rowSelection";

/** Collapsed by default? Assembly nodes ("n:<featureId>/<index>") are, built-in
 *  folders ("f:Bodies", "Palette") are not.
 *
 *  This replaces the class's `seenNodes` seeding, which added a key to the
 *  collapsed set the first time it was rendered. Seeding is a WRITE, and the
 *  panel's node list is now a computed, writing reactive state from inside a
 *  computed is exactly the kind of thing that loops or drops updates. Deriving
 *  the default from the key's namespace and recording only the user's own
 *  toggles is the same observable behaviour with no write during render.
 *
 *  The namespacing is not cosmetic either: assembly node labels come from a STEP
 *  file, so two subassemblies sharing a product name would otherwise collapse as
 *  one, and a product named "Bodies" would collide with a built-in folder. */
function collapsedByDefault(key: string): boolean {
  // A 3,000-part import must not paint 3,000 rows on arrival.
  return key.startsWith("n:");
}

/** What is being dragged in the Browser right now.
 *
 *  Held here rather than in the drag event's `dataTransfer`, which sounds like
 *  the right place and is not: dataTransfer is write-only until the drop, so a
 *  row asked on `dragover` whether it is a legal target, the exact moment it has
 *  to decide, cannot see what is coming. This never leaves the window, so there
 *  is nothing for dataTransfer to carry anyway. */
export type BrowserDrag =
  | { kind: "bodies"; ids: readonly string[] }
  | { kind: "element"; id: string };

/** View state for the Browser panel, the parts that are neither in the document
 *  nor derivable from a rebuild. */
export const useBrowserStore = defineStore("browser", () => {
  /** Only the sections the user has explicitly toggled; everything else falls
   *  back to collapsedByDefault(). */
  const overrides = ref(new Map<string, boolean>());

  /** Body selection lives in the Viewport, which is not reactive and never will
   *  be. app/viewportWiring.ts mirrors it in here on every change, one array
   *  assignment per change, instead of the old `isBodySelected(id)` predicate
   *  that allocated a fresh array and scanned it once PER BODY, on every doc
   *  change and every build. shallowRef because the value is replaced wholesale. */
  const selectedBodyIds = shallowRef<readonly string[]>([]);

  /** Set by "Rename…" on the viewport's body menu. The panel watches it, opens
   *  the enclosing folders, and the row that owns the id starts its inline edit
   *  and clears the field. Replaces the class's reach-in beginRename(), which
   *  could only work on rows that happened to be on screen. */
  const pendingRenameId = ref<string | null>(null);

  /** Bumped for display state that changes WITHOUT a store emit: sketch and
   *  construction-plane visibility are plain overrides (see store.ts, neither
   *  setter emits, because neither one costs a rebuild). Body visibility, names,
   *  colours and the palette all re-emit the build, so they need nothing here.
   *
   *  Also what the DEV `window.tree.refresh()` handle bumps to force a genuine
   *  re-render for e2e/browser_tree_perf.cjs. */
  const viewTick = ref(0);

  /** The in-flight Browser drag, or null. shallowRef because the value is
   *  replaced wholesale and its `ids` are never edited in place. */
  const drag = shallowRef<BrowserDrag | null>(null);

  /** A drag across the eyes is in progress (see ui/visibilityPaint.ts). Rows read
   *  it to refuse starting their own HTML5 drag: a body row is draggable, and a
   *  press on its eye followed by a move would otherwise pick the body up. */
  const painting = ref(false);

  /** The sketches picked in the Browser. A sketch selection is otherwise the ONE
   *  feature in stores/selection.ts, which the timeline and the inspector follow;
   *  this is the several the Browser's Ctrl and Shift clicks gather, kept beside
   *  it and resynced when that one changes from anywhere else. */
  const sketchSelection = shallowRef<RowSelection<string>>(EMPTY_SELECTION);

  /** Where a Shift-click on a body row measures its run from. The body selection
   *  itself lives in the viewport (selectedBodyIds mirrors it); only the anchor
   *  is the Browser's own. */
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
    startDrag: (d: BrowserDrag) => { drag.value = d; },
    // Called from dragend, which fires whether the drop landed or was abandoned
    // over the desktop, so a cancelled drag cannot leave every folder still
    // believing something is in flight.
    endDrag: () => { drag.value = null; },
    setSelectedBodies: (ids: readonly string[]) => { selectedBodyIds.value = ids; },
    beginRename: (id: string) => { pendingRenameId.value = id; },
    bumpView: () => { viewTick.value++; },
  };
});
