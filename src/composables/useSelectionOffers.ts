import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import type { Engine } from "../app/engine";
import { createSelectionWords } from "../app/selectionWords";
import { useGeometryBrowserStore } from "../stores/geometryBrowser";
import { describePick } from "../ui/describePick";
import { useSelectionStore } from "../stores/selection";
import {
  appearanceOffers,
  primaryCount,
  primaryKind,
  toolbarOffers,
  KIND_LABEL,
  type AppearanceOffer,
  type ToolOffer,
} from "../ui/selectionTools";
import { contextMenu } from "../ui/menu";
import { materialMenu } from "../ui/browserTree";
import type { SelectionCounts } from "../features/toolCapabilities";
import { shippedPluginName } from "../plugins/shipped";
import { describeSelection } from "../ui/selectionMeasure";

const pluralOf = (k: keyof typeof KIND_LABEL) => (k === "body" ? "bodies" : `${KIND_LABEL[k]}s`);

export interface PluginToolGroup {
  pluginId: string;
  name: string;
  offers: ToolOffer[];
}

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
  const signature = `e${edges.map((e) => e.id).join()}|r${regions.map((r) => r.interior3D.x).join()}|f${faceIds.join()}|b${bodies.join()}`;
  return { counts: c, signature };
}

/** `words` is for the readout alone, the one speaker for selection changes. */
export function useSelectionOffers(engine: Engine, opts: { words?: boolean } = {}) {
  const counts = shallowRef<SelectionCounts>({});
  const toolOwns = ref(false);
  const words = opts.words ? createSelectionWords(engine) : null;
  const geometry = useGeometryBrowserStore();
  let signature = "";

  const kind = computed(() => primaryKind(counts.value));
  const offers = computed(() => toolbarOffers(counts.value));
  // Plugin tools fold under their plugin's name in the rail, `offers` stays flat so run() resolves any tool id.
  const appOffers = computed(() => offers.value.filter((o) => !o.pluginId));
  const pluginGroups = computed<PluginToolGroup[]>(() => {
    const byPlugin = new Map<string, ToolOffer[]>();
    for (const o of offers.value) {
      if (!o.pluginId) continue;
      let list = byPlugin.get(o.pluginId);
      if (!list) byPlugin.set(o.pluginId, (list = []));
      list.push(o);
    }
    return [...byPlugin].map(([pluginId, os]) => ({
      pluginId,
      name: shippedPluginName(pluginId),
      offers: os,
    }));
  });
  const looks = computed(() => appearanceOffers(counts.value));
  const summary = computed(() => {
    const k = kind.value;
    if (!k) return "";
    return describeSelection({ count: primaryCount(counts.value), noun: KIND_LABEL[k], plural: pluralOf(k) });
  });
  // A body selection gives no hint that a second click or a pause reaches the face or edge under the cursor
  // (viewport/clickIntent.ts), so the readout spells it out. Speech leaves that out, it is no use without a pointer.
  const readout = computed(() => {
    if (!words) return summary.value;
    if (geometry.litRow) return describePick(geometry.litRow.facts).readout;
    if (words.line.value) return words.line.value;
    const k = kind.value;
    if (!k) return words.planeCount.value > 1 ? `${words.planeCount.value} planes` : "";
    const base = describeSelection({
      // A run of pieces is one face to the person who picked it.
      count: (k === "face" && words.faceRowCount.value) || primaryCount(counts.value),
      noun: KIND_LABEL[k],
      plural: pluralOf(k),
      ...(k === "edge" ? { edges: words.edges.value } : {}),
    });
    return k === "body" && engine.viewport.policy === "auto"
      ? `${base} · click again for a face, or pause over it`
      : base;
  });
  const speech = computed(() => words?.speech.value ?? null);

  function refresh(): boolean {
    const next = readCounts(engine);
    if (next.signature !== signature) {
      signature = next.signature;
      counts.value = next.counts;
    }
    toolOwns.value = engine.toolOwnsScreen();
    words?.update(signature, toolOwns.value, escaped);
    escaped = false;
    return Object.keys(next.counts).length > 0;
  }

  // Polled each frame while something is selected: onSelectionChange is a single slot owned by app/viewportWiring.ts
  // and profile-area selection notifies nothing. It stops on an empty frame, pointer, key, document and build wake it.
  let raf = 0;
  function tick() {
    raf = 0;
    if (refresh()) raf = requestAnimationFrame(tick);
  }
  function wake() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  // A screen reader's click on a row may send no pointer or key release.
  if (words)
    watch(
      () => [useSelectionStore().rows, useGeometryBrowserStore().selected],
      () => wake(),
    );

  // Capture, since a value box stops the key bubbling. Every route that clears on Escape does so during this event.
  let escaped = false;
  const noteEscape = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") escaped = true;
  };

  let unsubs: (() => void)[] = [];
  onMounted(() => {
    if (words) window.addEventListener("keydown", noteEscape, true);
    window.addEventListener("pointerup", wake);
    window.addEventListener("keyup", wake);
    unsubs = [engine.store.onDocChange(() => wake()), engine.store.onBuild(() => wake())];
    wake();
  });
  onUnmounted(() => {
    window.removeEventListener("keydown", noteEscape, true);
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

  /** Material, Hide and Isolate write the display overlays directly, they are not commands and skip handleAction. */
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
    store.isolateBodies(ids);
  }

  function clear() {
    engine.dropBodyGizmo();
    engine.viewport.clearSelection();
    engine.overlay.clearRegionSelection();
    engine.viewport.requestRender();
    wake();
  }

  return {
    counts,
    kind,
    offers,
    appOffers,
    pluginGroups,
    looks,
    summary,
    readout,
    speech,
    toolOwns,
    run,
    look,
    clear,
    wake,
  };
}
