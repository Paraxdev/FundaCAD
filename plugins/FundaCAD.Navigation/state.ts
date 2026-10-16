// The live config, shared by main.ts and the Preferences section.

import { reactive } from "vue";
import { loadConfig, saveConfig, type NavConfig } from "./navigation";

export const navState = reactive({
  cfg: loadConfig(),
  /** Why the radial trigger or the table could not be applied as asked. */
  problem: null as string | null,
});

let applier: () => void = () => {};

export function onConfigChange(fn: () => void) {
  applier = fn;
}

export function updateConfig(patch: Partial<NavConfig>) {
  Object.assign(navState.cfg, patch);
  saveConfig(navState.cfg);
  applier();
}
