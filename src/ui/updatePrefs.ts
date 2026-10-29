// Whether the app checks for updates by itself, how often, and when it last did. Help > Check for Updates ignores all
// of it.

import { readSetting } from "./storedSetting";

export type UpdatePeriod = "launch" | "daily" | "weekly";

export const UPDATE_PERIODS: readonly { id: UpdatePeriod; label: string }[] = [
  { id: "launch", label: "Every launch" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
];

export const PERIOD_MS: Record<UpdatePeriod, number> = {
  launch: 0,
  daily: 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};

const AUTO_KEY = "fundacad.updates.auto";
const PERIOD_KEY = "fundacad.updates.period";
const LAST_KEY = "fundacad.updates.lastCheck";

export function asUpdatePeriod(v: unknown): UpdatePeriod | null {
  return v === "launch" || v === "daily" || v === "weekly" ? v : null;
}

let auto = readSetting(AUTO_KEY) !== "off";
let period: UpdatePeriod = asUpdatePeriod(readSetting(PERIOD_KEY)) ?? "daily";
let last = ((): number | null => {
  const n = Number(readSetting(LAST_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const listeners = new Set<() => void>();

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage: the change lasts the session */
  }
}

export const autoUpdateCheck = (): boolean => auto;
export const updatePeriod = (): UpdatePeriod => period;
/** Epoch ms of the last automatic check that reached the update feed, null if none has. */
export const lastUpdateCheck = (): number | null => last;

export function setAutoUpdateCheck(next: boolean) {
  if (next === auto) return;
  auto = next;
  store(AUTO_KEY, next ? "on" : "off");
  for (const fn of listeners) fn();
}

export function setUpdatePeriod(next: UpdatePeriod) {
  if (next === period) return;
  period = next;
  store(PERIOD_KEY, next);
  for (const fn of listeners) fn();
}

/** Recording a check moves no setting, so the listeners are not told. */
export function recordUpdateCheck(at: number) {
  last = at;
  store(LAST_KEY, String(at));
}

export function onUpdatePrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
