import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { Engine } from "../app/engine";
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
import { describeSelection, exactRound, type Pt3, type RoundSize } from "../ui/selectionMeasure";

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

export function useSelectionOffers(engine: Engine) {
  const counts = shallowRef<SelectionCounts>({});
  const toolOwns = ref(false);
  const measured = shallowRef<{ edges: Pt3[][]; roundFace: (RoundSize & { faceId: number }) | null }>({
    edges: [],
    roundFace: null,
  });
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
  const describe = (withNumbers: boolean) => {
    const k = kind.value;
    if (!k) return "";
    const one = KIND_LABEL[k];
    return describeSelection({
      count: primaryCount(counts.value),
      noun: one,
      plural: one === "body" ? "bodies" : `${one}s`,
      ...(withNumbers && k === "edge" ? { edges: measured.value.edges } : {}),
      ...(withNumbers && k === "face" ? { roundFace: roundFace() } : {}),
    });
  };
  const roundFace = (): RoundSize | null => {
    const mesh = measured.value.roundFace;
    const exact = exactRound.value;
    return mesh && exact?.faceId === mesh.faceId ? exact : mesh;
  };
  const summary = computed(() => describe(false));
  // A body selection gives no hint that a second click or a pause reaches the face or edge under the cursor
  // (viewport/clickIntent.ts), so the readout spells it out.
  const readout = computed(() => {
    const base = describe(true);
    if (base && kind.value === "body" && engine.viewport.policy === "auto") {
      return `${base} · click again for a face, or pause over it`;
    }
    return base;
  });

  function refresh(): boolean {
    const next = readCounts(engine);
    if (next.signature !== signature) {
      signature = next.signature;
      counts.value = next.counts;
      const edges = next.counts.edge ? engine.viewport.selectedEdgeLines().map((e) => e.points) : [];
      const faces = next.counts.face === 1 ? engine.viewport.selectedFacesForPressPull() : null;
      const round = faces?.round;
      measured.value = {
        edges,
        roundFace: round ? { faceId: faces.faceIds[0]!, radius: round.radius, full: round.full ?? true } : null,
      };
    }
    toolOwns.value = engine.toolOwnsScreen();
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

  return { counts, kind, offers, appOffers, pluginGroups, looks, summary, readout, toolOwns, run, look, clear, wake };
}
