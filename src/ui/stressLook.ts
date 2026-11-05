// How the Stress colours look: the colour map and whether they are banded. Kept across documents and sessions.

import { asOnOff } from "./a11yPrefs";
import { readSetting } from "./storedSetting";
import { STRESS_RAMPS, type StressRamp } from "./stress";

export interface StressLook {
  ramp: StressRamp;
  bands: boolean;
}

const RAMP_KEY = "fundacad.stress.colourMap";
const BANDS_KEY = "fundacad.stress.bands";

const asRamp = (v: unknown): StressRamp | null => STRESS_RAMPS.find((r) => r.value === v)?.value ?? null;

function read(): StressLook {
  return { ramp: asRamp(readSetting(RAMP_KEY)) ?? "perceptual", bands: asOnOff(readSetting(BANDS_KEY)) ?? false };
}

let current = read();
const listeners = new Set<(look: StressLook) => void>();

export function stressLook(): Readonly<StressLook> {
  return current;
}

export function setStressLook(patch: Partial<StressLook>) {
  const ramp = patch.ramp === undefined ? current.ramp : asRamp(patch.ramp);
  const bands = patch.bands === undefined ? current.bands : asOnOff(patch.bands);
  if (ramp === null || bands === null) return;
  if (ramp === current.ramp && bands === current.bands) return;
  current = { ramp, bands };
  try {
    localStorage.setItem(RAMP_KEY, ramp);
    localStorage.setItem(BANDS_KEY, bands ? "on" : "off");
  } catch {
    // A blocked store keeps the look for this session.
  }
  for (const fn of listeners) fn(current);
}

export function onStressLookChange(fn: (look: StressLook) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
