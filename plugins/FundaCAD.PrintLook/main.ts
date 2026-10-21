import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import LayerLinesSection from "./LayerLinesSection.vue";
import { FILAMENT_GROUP, FILAMENT_PRESETS } from "./presets";
import { reliefFrom, type LookValues } from "./look";
import { PLUGIN_ID, settings } from "./settings";

const ICON =
  '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="20" y2="10"/>' +
  '<line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="20" y2="18"/>';

const current = () => reliefFrom(settings.all() as unknown as Partial<LookValues>);
const toggle = () => void settings.set("layerLines", !settings.get("layerLines"));

/** Start the capability. Returns the teardown that stops it. */
export async function activate(_e: Engine): Promise<() => void> {
  const off = contribute(PLUGIN_ID, {
    materialPresets: () => [{ group: FILAMENT_GROUP, materials: FILAMENT_PRESETS.map((m) => ({ ...m })) }],
    relief: () => {
      const r = current();
      return r ? { all: r } : {};
    },
    renderSections: [{ key: "layer-lines", component: LayerLinesSection, tab: "environment" }],
    settings: [{ key: "look", settings }],
    actions: { "layer-lines": toggle },
    ribbon: [{ group: "PRINT", priority: 50, items: [{ action: "layer-lines", label: "Layer lines", iconName: "layerLines" }] }],
    icons: { layerLines: ICON },
  });

  // The viewport re-asks `relief` when the contributions change and a setting
  // is not a contribution, so an empty one is added and taken away again. The
  // real entry stays where it is, which keeps the dock's slider mounted while
  // it is being dragged.
  const stop = settings.onChange(() => contribute(PLUGIN_ID, {})());

  return () => {
    stop();
    off();
  };
}
