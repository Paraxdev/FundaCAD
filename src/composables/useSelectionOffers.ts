// What the current selection is and which tools can act on it, for the tool rail.
//
// Read by LOOKING once a frame while something is selected rather than by
// subscribing: onSelectionChange is a single-slot callback owned by
// app/viewportWiring.ts, and profile-area selection notifies nothing at all. The
// loop stops on the first empty frame and is woken by the things that can create
// a selection (pointer release, key release, document change, build).

import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { Engine } from "../app/engine";
import {
  appearanceOffers, primaryCount, primaryKind, toolbarOffers, KIND_LABEL,
  type AppearanceOffer, type ToolOffer,
} from "../ui/selectionTools";
import { contextMenu } from "../ui/menu";
import { materialMenu } from "../ui/browserTree";
import type { SelectionCounts } from "../features/toolCapabilities";

function readCounts(engine: Engine): { counts: SelectionCounts; signature: string } {
  const edges = engine.viewport.selectedEdgeLines();
  const regions = engine.overlay.selectedRegions();
  const faceIds = engine.viewport.getSelectedFaceIds();
  const bodies = engine.viewport.getSelectedBodies();
  const c: SelectionCounts = {};
  if (edges.length) c.edge = edges.length;
  if (regions.length) c["sketch-region"] = regions.length;
  if (faceIds.length) c.face = faceIds.length;
  if (bodies.length) c.body = bodies.length;
  const signature =
    `e${edges.map((e) => e.id).join()}|r${regions.map((r) => r.interior3D.x).join()}|f${faceIds.join()}|b${bodies.join()}`;
  return { counts: c, signature };
}

export function useSelectionOffers(engine: Engine) {
  const counts = shallowRef<SelectionCounts>({});
  const toolOwns = ref(false);
  let signature = "";

  const kind = computed(() => primaryKind(counts.value));
  const offers = computed(() => toolbarOffers(counts.value));
  const looks = computed(() => appearanceOffers(counts.value));
  const summary = computed(() => {
    const k = kind.value;
    if (!k) return "";
    const n = primaryCount(counts.value);
    const one = KIND_LABEL[k];
    if (n > 1) return `${n} ${one === "body" ? "bodies" : `${one}s`}`;
    return one.charAt(0).toUpperCase() + one.slice(1);
  });

  function refresh(): boolean {
    const next = readCounts(engine);
    if (next.signature !== signature) {
      signature = next.signature;
      counts.value = next.counts;
    }
    toolOwns.value = engine.toolOwnsScreen();
    return Object.keys(next.counts).length > 0;
  }

  let raf = 0;
  function tick() {
    raf = 0;
    if (refresh()) raf = requestAnimationFrame(tick);
  }
  function wake() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  let unsubs: (() => void)[] = [];
  onMounted(() => {
    window.addEventListener("pointerup", wake);
    window.addEventListener("keyup", wake);
    unsubs = [engine.store.onDocChange(() => wake()), engine.store.onBuild(() => wake())];
    wake();
  });
  onUnmounted(() => {
    window.removeEventListener("pointerup", wake);
    window.removeEventListener("keyup", wake);
    for (const off of unsubs) off();
    unsubs = [];
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });

  function run(o: ToolOffer) {
    // The gizmo a body selection raises is not a tool the user started, and
    // every command would refuse while it is up. See Engine.dropBodyGizmo.
    engine.dropBodyGizmo();
    if (engine.toolBusy()) return;
    if (o.action) engine.handleAction(o.action);
    else if (o.tool === "delete-face") engine.deleteSelectedFace();
  }

  /** Material, Hide and Isolate write the display overlays directly; none of
   *  them is a command, so none goes through handleAction. */
  function look(o: AppearanceOffer, at: { x: number; y: number }) {
    if (engine.toolOwnsScreen()) return;
    const ids = engine.viewport.getSelectedBodies();
    if (!ids.length) return;
    const store = engine.store;
    if (o.id === "material") {
      const first = ids[0];
      const current = first !== undefined ? store.bodyMaterialId(first) : undefined;
      const shared = ids.every((id) => store.bodyMaterialId(id) === current) ? current : undefined;
      const item = materialMenu(store.materialLibrary, ids, shared, (m) => store.setBodiesMaterial(ids, m));
      contextMenu(at.x, at.y, item.children ?? []);
      return;
    }
    if (o.id === "hide") {
      engine.dropBodyGizmo();
      store.setBodiesVisibility(new Map(ids.map((id) => [id, false])));
      engine.viewport.setSelectedBodies([]);
      return;
    }
    const all = store.buildState.result?.bodies ?? [];
    const keep = new Set(ids);
    store.setBodiesVisibility(new Map(all.map((b) => [b.id, keep.has(b.id)])));
  }

  function clear() {
    engine.dropBodyGizmo();
    engine.viewport.clearSelection();
    engine.overlay.clearRegionSelection();
    engine.viewport.requestRender();
    wake();
  }

  return { counts, kind, offers, looks, summary, toolOwns, run, look, clear, wake };
}
