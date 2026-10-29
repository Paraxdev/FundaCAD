// Larger click targets from a11yPrefs.ts: "large" sets data-targets="large" on <html>, which lifts --hit-min to
// 32 px and turns on the _touch.scss insets for a mouse or pen too.

import { a11yPrefs, onA11yPrefsChange, setA11yPref } from "./a11yPrefs";

export function largeTargetsOn(): boolean {
  return a11yPrefs().targets === "large";
}

function apply() {
  if (typeof document === "undefined" || !document) return;
  if (largeTargetsOn()) document.documentElement.dataset.targets = "large";
  else delete document.documentElement.dataset.targets;
}
apply();
onA11yPrefsChange(apply);

export function setLargeTargets(on: boolean) {
  setA11yPref("targets", on ? "large" : "default");
}
