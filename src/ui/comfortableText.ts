// Comfortable text sets data-text="comfortable" on <html>, and _comfortable.scss spaces every line, letter and word
// from there and lets base controls grow around it.

import { a11yPrefs, onA11yPrefsChange } from "./a11yPrefs";

export function applyComfortableText(on: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (on) root.dataset.text = "comfortable";
  else delete root.dataset.text;
}

let installed = false;

/** Applies the stored choice at boot and every later change, Reset to defaults included. */
export function installComfortableText() {
  if (installed) return;
  installed = true;
  applyComfortableText(a11yPrefs().comfortableText);
  onA11yPrefsChange(() => applyComfortableText(a11yPrefs().comfortableText));
}
