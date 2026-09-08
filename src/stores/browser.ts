import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";

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
    isCollapsed,
    toggle,
    expand,
    setSelectedBodies: (ids: readonly string[]) => { selectedBodyIds.value = ids; },
    beginRename: (id: string) => { pendingRenameId.value = id; },
    bumpView: () => { viewTick.value++; },
  };
});
