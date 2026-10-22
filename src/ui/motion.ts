// Animations on or off. Off sets data-motion="off" on <html> for _motion.scss; script motion reads motionOn() and
// snaps. Never set follows the OS reduce motion preference.

import { readSetting } from "./storedSetting";
import { renderPrefs } from "./renderPrefs";

const KEY = "fundacad.animations";

const listeners = new Set<() => void>();

function systemReduces(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readStored(): boolean {
  const v = readSetting(KEY);
  if (v === "on") return true;
  if (v === "off") return false;
  return !systemReduces();
}

let on = readStored();

function apply() {
  if (typeof document === "undefined") return;
  if (on) delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = "off";
}
apply();

export function motionOn(): boolean {
  return on;
}

/** Whether the camera flies to a new view or jumps there. Potato mode jumps, a
 *  flight is a run of full frames the machine cannot afford. */
export function cameraFlightsOn(): boolean {
  return on && !renderPrefs().potatoMode;
}

export function setMotion(next: boolean) {
  if (next === on) return;
  on = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    /* ignore */
  }
  apply();
  for (const fn of listeners) fn();
}

export function onMotionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
