// Facade for the floating "measure-panel" popups: Properties, Interference and
// the Overhang (Draft Analysis) settings. The DOM lives in
// components/overlays/*Panel.vue; what stays here is the part that is genuinely
// this layer's job — preconditions, status-line messages, the geometry call,
// and unit formatting of the numbers those produce.
//
// Every exported name keeps its old signature, so app/actions.ts,
// app/menubarDef.ts and the print-status pill are unchanged.

import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { GeometryBackend } from "../geometry/client";
import { getUnit, toDisplay, displayRound } from "./units";
import { usePanelsStore, type PanelRow, type ClashRow } from "../stores/panels";

export interface PanelsDeps {
  store: DocumentStore;
  viewport: Viewport;
  geometry: GeometryBackend;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
}

export function createPanels(deps: PanelsDeps) {
  const { store, viewport, geometry, hasBody, setStatus } = deps;
  const panels = usePanelsStore();

  // --- Inspect: Properties readout (volume / area / mass / center / bbox) ---
  function showProperties() {
    if (!hasBody()) {
      setStatus("Properties: create or import a body first", "");
      return;
    }
    const sel = viewport.getSelectedBodies();
    const p = viewport.bodyProperties(sel.length ? sel : null);
    if (!p) return;
    const unit = getUnit();
    const f = toDisplay(1);
    const cm3 = p.volume / 1000; // mm³ → cm³ (mass at 1 g/cm³ baseline)
    const rows: PanelRow[] = [
      { k: "Volume", v: `${displayRound(p.volume * f * f * f)} ${unit}³` },
      { k: "Surface area", v: `${displayRound(p.area * f * f)} ${unit}²` },
      { k: "Mass (≈1 g/cm³)", v: `${displayRound(cm3)} g` },
      {
        k: "Center of mass",
        v: `${displayRound(toDisplay(p.com.x))}, ${displayRound(toDisplay(p.com.y))}, ${displayRound(toDisplay(p.com.z))}`,
      },
      {
        k: "Bounding box",
        v:
          `${displayRound(toDisplay(p.bbox.max.x - p.bbox.min.x))} × ` +
          `${displayRound(toDisplay(p.bbox.max.y - p.bbox.min.y))} × ` +
          `${displayRound(toDisplay(p.bbox.max.z - p.bbox.min.z))} ${unit}`,
      },
    ];
    panels.showProperties({
      title: sel.length === 1 ? (p.names[0] ?? "") : sel.length ? `${sel.length} bodies` : "All bodies",
      rows,
    });
  }

  // --- Inspect: Interference (clash) check between bodies ---
  async function showInterference() {
    if (!hasBody()) {
      setStatus("Interference: create or import a body first", "");
      return;
    }
    if ((store.buildState.result?.bodies?.length ?? 0) < 2) {
      setStatus("Interference: needs at least two bodies", "");
      return;
    }
    setStatus("Checking interference…", "");
    const res = await geometry.interference(store.document);
    if (!res.ok) {
      setStatus(`Interference check failed: ${res.message ?? "error"}`, "error");
      return;
    }
    const pairs = res.pairs ?? [];
    setStatus(
      pairs.length ? `${pairs.length} interference${pairs.length > 1 ? "s" : ""} found` : "No interferences found",
      pairs.length ? "error" : "connected",
    );
    const unit = getUnit();
    const f = toDisplay(1);
    const clashes: ClashRow[] = pairs.map((p) => ({
      k: `${p.aName} ∩ ${p.bName}`,
      v: `${displayRound(p.volume * f * f * f)} ${unit}³`,
      a: p.a,
      b: p.b,
    }));
    panels.showInterference({
      title: pairs.length
        ? `Interference, ${pairs.length} clash${pairs.length > 1 ? "es" : ""}`
        : "Interference",
      clashes,
    });
  }

  function showOverhangSettings() {
    panels.overhang = true;
  }
  function closeOverhangSettings() {
    panels.overhang = false;
  }

  /** Live snapshot frames from the Rust poller; the component owns the
   *  subscription lifecycle. Kept async because the print-status pill and the
   *  menubar both `void` the result. */
  async function showCameraPanel(printerId: string) {
    panels.camera = printerId;
  }

  return { showProperties, showInterference, showOverhangSettings, closeOverhangSettings, showCameraPanel };
}

export type Panels = ReturnType<typeof createPanels>;
