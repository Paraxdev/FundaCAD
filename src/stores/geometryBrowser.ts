import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { filterRows, NO_FILTERS, type GeometryFilters, type GeometryRow } from "../ui/geometryRows";

export type GeometryKind = "faces" | "edges";
export type GeometryState = "idle" | "loading" | "ready" | "error";

export const GEOMETRY_PAGE_SIZE = 100;

/** The Geometry list's state, fed by app/geometryBrowser.ts. Faces and edges stay selected in the Viewport, `selected`
 *  mirrors them as row keys. */
export const useGeometryBrowserStore = defineStore("geometryBrowser", () => {
  const kind = ref<GeometryKind>("faces");
  const bodyId = ref<string | null>(null);
  const bodies = shallowRef<readonly { id: string; name: string }[]>([]);
  const filters = shallowRef<GeometryFilters>(NO_FILTERS);
  const rows = shallowRef<readonly GeometryRow[]>([]);
  /** "loading" with rows means the old rows are still shown while new ones arrive. */
  const state = ref<GeometryState>("idle");
  const error = ref<string | null>(null);
  /** How many faces the engine left out at its cap, null when it listed them all. */
  const truncated = ref<number | null>(null);
  const page = ref(0);
  const cursor = ref<string | null>(null);
  const selected = shallowRef<readonly string[]>([]);

  const filtered = computed(() => filterRows(rows.value, filters.value));
  const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / GEOMETRY_PAGE_SIZE)));
  const pageRows = computed(() => {
    const from = page.value * GEOMETRY_PAGE_SIZE;
    return filtered.value.slice(from, from + GEOMETRY_PAGE_SIZE);
  });

  // Where the cursor last stood, so a row a build removed hands over to the one now in its place.
  let cursorPlace = 0;
  const clampPage = (p: number) => Math.min(Math.max(0, p), pageCount.value - 1);

  function settleCursor() {
    const list = filtered.value;
    if (cursor.value !== null) {
      const found = list.findIndex((r) => r.key === cursor.value);
      const at = found >= 0 ? found : Math.min(cursorPlace, list.length - 1);
      cursor.value = list[at]?.key ?? null;
      if (at >= 0) {
        cursorPlace = at;
        page.value = Math.floor(at / GEOMETRY_PAGE_SIZE);
        return;
      }
    }
    page.value = clampPage(page.value);
  }

  function clearPlace() {
    rows.value = [];
    cursor.value = null;
    cursorPlace = 0;
    page.value = 0;
  }

  return {
    kind,
    bodyId,
    bodies,
    filters,
    rows,
    state,
    error,
    truncated,
    page,
    cursor,
    selected,
    filtered,
    pageCount,
    pageRows,
    setBodies(next: readonly { id: string; name: string }[]) {
      bodies.value = next;
    },
    setBody(id: string | null) {
      if (id === bodyId.value) return;
      bodyId.value = id;
      truncated.value = null;
      clearPlace();
    },
    /** A type or a facing belongs to one kind: edges have no facing and faces are never straight. */
    setKind(next: GeometryKind) {
      if (next === kind.value) return;
      kind.value = next;
      filters.value = { ...filters.value, type: null, facing: null };
      clearPlace();
    },
    setFilters(next: Partial<GeometryFilters>) {
      filters.value = { ...filters.value, ...next };
      page.value = 0;
      settleCursor();
    },
    setRows(next: readonly GeometryRow[]) {
      rows.value = next;
      settleCursor();
    },
    setState(next: GeometryState, message: string | null = null) {
      state.value = next;
      error.value = message;
    },
    setTruncated(faces: number | null) {
      truncated.value = faces;
    },
    setPage(p: number) {
      page.value = clampPage(p);
    },
    setCursor(key: string | null) {
      cursor.value = key;
      if (key !== null) settleCursor();
      else cursorPlace = 0;
    },
    setSelected(keys: readonly string[]) {
      selected.value = keys;
    },
    /** Nothing of a document outlives it. */
    reset() {
      kind.value = "faces";
      bodyId.value = null;
      bodies.value = [];
      filters.value = NO_FILTERS;
      state.value = "idle";
      error.value = null;
      truncated.value = null;
      selected.value = [];
      clearPlace();
    },
  };
});
