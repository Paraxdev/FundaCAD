// Facade for the floating "measure-panel" popups: Properties, Interference and
// the Overhang (Draft Analysis) settings. The DOM lives in
// components/overlays/*Panel.vue; what stays here is the part that is genuinely
// this layer's job, preconditions, status-line messages, the geometry call,
// and unit formatting of the numbers those produce.
//
// The app's own panels only. A capability that wants a floating panel brings its
// own component and its own state; a printer camera used to be a fifth field on
// the store below and a fifth function here, which put "which printer is being
// watched" in the same object as "which bodies are overlapping".

import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { GeometryBackend } from "../geometry/client";
import { getUnit, toDisplay, displayRound } from "./units";
import { usePanelsStore, type PanelRow, type ClashRow, type ClearanceRow } from "../stores/panels";

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

  // --- Inspect: Properties readout (volume / area / center / bbox). Mass and
  // the filament estimate are computed live in the panel component itself,
  // from `raw` below, so changing material/infill needs no new geometry call. ---
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
    const rows: PanelRow[] = [
      { k: "Volume", v: `${displayRound(p.volume * f * f * f)} ${unit}³` },
      { k: "Surface area", v: `${displayRound(p.area * f * f)} ${unit}²` },
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
      raw: { volumeMm3: p.volume, areaMm2: p.area },
    });
    viewport.setComMarker(p.com);
  }

  /** Close Properties and drop its center-of-mass marker. The panel component
   *  calls this instead of nulling the store ref directly, so the overlay
   *  never outlives the panel that asked for it. */
  function closeProperties() {
    panels.properties = null;
    viewport.setComMarker(null);
  }

  // --- Inspect: Interference (clash) check between bodies, optionally with a
  // clearance threshold (mm) for the near-miss pass. ---
  async function showInterference(clearanceMm?: number) {
    if (!hasBody()) {
      setStatus("Interference: create or import a body first", "");
      return;
    }
    if ((store.buildState.result?.bodies?.length ?? 0) < 2) {
      setStatus("Interference: needs at least two bodies", "");
      return;
    }
    setStatus("Checking interference…", "");
    const res = await geometry.interference(store.document, clearanceMm);
    if (!res.ok) {
      setStatus(`Interference check failed: ${res.message ?? "error"}`, "error");
      return;
    }
    const pairs = res.pairs ?? [];
    const clearances = res.clearances ?? [];
    const foundAny = pairs.length || clearances.length;
    setStatus(
      foundAny
        ? `${pairs.length} interference${pairs.length === 1 ? "" : "s"}` +
          (clearanceMm ? `, ${clearances.length} close pair${clearances.length === 1 ? "" : "s"}` : "")
        : "No interferences found",
      foundAny ? "error" : "connected",
    );
    const unit = getUnit();
    const f = toDisplay(1);
    const clashes: ClashRow[] = pairs.map((p) => ({
      k: `${p.aName} ∩ ${p.bName}`,
      v: `${displayRound(p.volume * f * f * f)} ${unit}³`,
      a: p.a,
      b: p.b,
    }));
    const clearanceRows: ClearanceRow[] = clearances.map((c) => ({
      k: `${c.aName} ↔ ${c.bName}`,
      v: `${displayRound(toDisplay(c.distance))} ${unit}`,
      a: c.a,
      b: c.b,
    }));
    panels.showInterference({
      title: pairs.length
        ? `Interference, ${pairs.length} clash${pairs.length > 1 ? "es" : ""}`
        : "Interference",
      clashes,
      clearances: clearanceRows,
      ...(res.truncated ? { truncatedMessage: res.message } : {}),
    });
    viewport.setInterferenceOverlay(
      pairs,
      clearances.map((c) => ({ pointA: c.pointA, pointB: c.pointB })),
    );
  }

  /** Close Interference and drop its overlap/clearance overlay. */
  function closeInterference() {
    panels.interference = null;
    viewport.setInterferenceOverlay(null, null);
  }

  function showOverhangSettings() {
    panels.overhang = true;
  }
  function closeOverhangSettings() {
    panels.overhang = false;
  }

  return {
    showProperties, closeProperties, showInterference, closeInterference,
    showOverhangSettings, closeOverhangSettings,
  };
}

export type Panels = ReturnType<typeof createPanels>;
