// Interface size, applied as the webview's own zoom under Tauri, so the CSS viewport shrinks and the layout and
// breakpoints reflow as in a browser. Vite dev and the harness have no webview API and zoom the root instead.

import { a11yPrefs, INTERFACE_SIZE_MAX, INTERFACE_SIZES, onA11yPrefsChange, setA11yPref } from "./a11yPrefs";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let applied: number | null = null;

export function applyInterfaceSize(pct: number) {
  if (pct === applied) return;
  applied = pct;
  if (isTauri()) {
    void import("@tauri-apps/api/webview").then((m) => m.getCurrentWebview().setZoom(pct / 100)).catch(() => {});
  } else if (typeof document !== "undefined") {
    document.documentElement.style.zoom = pct === 100 ? "" : String(pct / 100);
  }
}

/** The next step up or down from `pct`, held between the smallest step and the cap. */
export function steppedInterfaceSize(pct: number, dir: 1 | -1): number {
  const steps = INTERFACE_SIZES.filter((s) => s <= INTERFACE_SIZE_MAX);
  const next = dir > 0 ? steps.find((s) => s > pct) : [...steps].reverse().find((s) => s < pct);
  return next ?? pct;
}

/** Steps the stored size and returns the new one; the same size back means it is already at that end. */
export function stepInterfaceSize(dir: 1 | -1): number {
  setA11yPref("interfaceSize", steppedInterfaceSize(a11yPrefs().interfaceSize, dir));
  return a11yPrefs().interfaceSize;
}

export function resetInterfaceSize(): number {
  setA11yPref("interfaceSize", 100);
  return a11yPrefs().interfaceSize;
}

let installed = false;

/** Applies the stored size at boot and every later change, Reset to defaults included. */
export function installInterfaceSize() {
  if (installed) return;
  installed = true;
  applyInterfaceSize(a11yPrefs().interfaceSize);
  onA11yPrefsChange(() => applyInterfaceSize(a11yPrefs().interfaceSize));
}
