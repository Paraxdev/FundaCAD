// The Contrast setting of a11yPrefs.ts resolved against the OS and written as data-contrast on <html> for
// _contrast.scss. Follow system tracks the OS while the app runs, the late Rust answer of osTheme.ts included.

import { type Contrast, a11yPrefs, onA11yPrefsChange } from "./a11yPrefs";
import { onOsAppearanceChange, osAppearance } from "./osTheme";

export type ContrastSetting = Exclude<Contrast, "system">;

const listeners = new Set<() => void>();
let applied: ContrastSetting | null = null;

export function contrastSetting(): ContrastSetting {
  const choice = a11yPrefs().contrast;
  if (choice !== "system") return choice;
  return osAppearance().contrast ? "more" : "standard";
}

function apply() {
  const next = contrastSetting();
  if (next === applied) return false;
  applied = next;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (next === "standard") delete root.dataset.contrast;
    else root.dataset.contrast = next;
  }
  return true;
}

function update() {
  if (!apply()) return;
  for (const fn of listeners) fn();
}

/** Put the Contrast setting on the document and follow it and the OS. Call once at startup, after initTheme. */
export function initContrast() {
  if (applied !== null) return;
  apply();
  onA11yPrefsChange(update);
  onOsAppearanceChange(update);
}

/** For the Three.js viewport, whose materials hold the muted text and strong line colours resolved. */
export function onContrastChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
