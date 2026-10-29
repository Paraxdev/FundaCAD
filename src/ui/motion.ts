// Animations on or off, from the Follow system, On or Off choice in a11yPrefs.ts. Off sets data-motion="off" on
// <html> for _motion.scss; script motion reads motionOn() and snaps. Follow system tracks the OS while the app runs.

import { a11yPrefs, onA11yPrefsChange, setA11yPref, systemReducesMotion } from "./a11yPrefs";
import { renderPrefs } from "./renderPrefs";

const listeners = new Set<() => void>();

function resolve(): boolean {
  const choice = a11yPrefs().animations;
  return choice === "system" ? !systemReducesMotion() : choice === "on";
}

let on = resolve();

function apply() {
  if (typeof document === "undefined") return;
  if (on) delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = "off";
}
apply();

onA11yPrefsChange(() => {
  const next = resolve();
  if (next === on) return;
  on = next;
  apply();
  for (const fn of listeners) fn();
});

export function motionOn(): boolean {
  return on;
}

/** Whether the camera flies to a new view or jumps there. Potato mode jumps, a
 *  flight is a run of full frames the machine cannot afford. */
export function cameraFlightsOn(): boolean {
  return on && !renderPrefs().potatoMode;
}

/** Pins Animations to On or Off, leaving Follow system. */
export function setMotion(next: boolean) {
  setA11yPref("animations", next ? "on" : "off");
}

export function onMotionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
