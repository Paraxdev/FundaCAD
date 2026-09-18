// Animations on or off, an accessibility setting.
//
// Off puts data-motion="off" on <html>, and _motion.scss collapses every CSS
// transition and animation to zero there, so each component needs no switch of
// its own. Script-driven motion (the camera flight, the error notice) reads
// motionOn() and snaps instead.
//
// Never set means follow the OS "reduce motion" preference, so someone who
// already asked their system for less motion is not shown it first.

import { readSetting } from "./storedSetting";

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
