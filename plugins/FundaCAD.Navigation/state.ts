// The live config, shared by main.ts and the Preferences section. The app's
// settings store keeps it; this is the parsed view the plugin works from.

import { reactive } from "vue";
import { definePluginSettings } from "fundacad";
import { PLUGIN_ID, SETTINGS, configOf, type NavConfig } from "./navigation";

export const settings = definePluginSettings(PLUGIN_ID, SETTINGS);

export const navState = reactive({
  cfg: configOf(settings.all()),
  /** Why the radial trigger or the table could not be applied as asked. */
  problem: null as string | null,
});

let applier: () => void = () => {};

export function onConfigChange(fn: () => void) {
  applier = fn;
}

settings.onChange(() => {
  navState.cfg = configOf(settings.all());
  applier();
});

export function updateConfig(patch: Partial<NavConfig>) {
  for (const [k, v] of Object.entries(patch)) settings.set(k, v);
}
