// Interface size, applied as the webview's own zoom under Tauri, so the CSS viewport shrinks and the layout and
// breakpoints reflow as in a browser. Vite dev zooms the root instead, which also scales vh, so only Tauri is exact.

import { zoomChord, type ZoomChord } from "../input/platform";
import { a11yPrefs, INTERFACE_SIZES, onA11yPrefsChange, setA11yPref } from "./a11yPrefs";
import { announce } from "./announce";

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

/** The next step up or down from `pct`, held between the smallest step and the largest. */
export function steppedInterfaceSize(pct: number, dir: 1 | -1): number {
  const next = dir > 0 ? INTERFACE_SIZES.find((s) => s > pct) : [...INTERFACE_SIZES].reverse().find((s) => s < pct);
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

/** The keys and the palette commands: steps or resets the size and says the new one, or that it is at an end. */
export function changeInterfaceSize(how: ZoomChord) {
  const before = a11yPrefs().interfaceSize;
  const now = how === "reset" ? resetInterfaceSize() : stepInterfaceSize(how === "up" ? 1 : -1);
  const end = how !== "reset" && now === before ? (how === "up" ? ", the largest" : ", the smallest") : "";
  announce(`Interface size ${now} percent${end}`, "polite", { key: "interface-size" });
}

/** For a window keydown listener in the capture phase, so no field, menu or running tool sees the chord. */
export function interfaceSizeKey(ev: KeyboardEvent): boolean {
  const how = zoomChord(ev);
  if (!how) return false;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  changeInterfaceSize(how);
  return true;
}

let installed = false;

/** Applies the stored size at boot and every later change, Reset to defaults included. */
export function installInterfaceSize() {
  if (installed) return;
  installed = true;
  applyInterfaceSize(a11yPrefs().interfaceSize);
  onA11yPrefsChange(() => applyInterfaceSize(a11yPrefs().interfaceSize));
}
