import { defineStore } from "pinia";
import { ref } from "vue";
import { t } from "../i18n";

export type PaletteToggle =
  "lockView" | "construction" | "reference" | "grid" | "snap" | "profile" | "dimensions" | "constraints";

interface ToggleDef {
  key: PaletteToggle;
  readonly label: string;
  default: boolean;
}

export const PALETTE_TOGGLES: ToggleDef[] = [
  // Off by default: entry already squares the view and flattens the projection, so the lock is only for people who want
  // the camera nailed down while the rest can turn the view.
  {
    key: "lockView",
    get label() {
      return t("sketchPalette.toggle.lockView");
    },
    default: false,
  },
  {
    key: "construction",
    get label() {
      return t("sketchPalette.toggle.construction");
    },
    default: false,
  },
  {
    key: "reference",
    get label() {
      return t("sketchPalette.toggle.reference");
    },
    default: false,
  },
  {
    key: "grid",
    get label() {
      return t("sketchPalette.toggle.grid");
    },
    default: true,
  },
  {
    key: "snap",
    get label() {
      return t("sketchPalette.toggle.snap");
    },
    default: true,
  },
  {
    key: "profile",
    get label() {
      return t("sketchPalette.toggle.profile");
    },
    default: true,
  },
  {
    key: "dimensions",
    get label() {
      return t("sketchPalette.toggle.dimensions");
    },
    default: true,
  },
  {
    key: "constraints",
    get label() {
      return t("sketchPalette.toggle.constraints");
    },
    default: true,
  },
];

/** The Sketch Palette. Toggle values live here, not in the component, so they survive the panel hiding between sketches
 *  and emitAll() can replay them into SketchMode on every sketch entry. */
export const useSketchPaletteStore = defineStore("sketchPalette", () => {
  const visible = ref(false);
  /** The camera has turned away from the sketch plane. */
  const offNormal = ref(false);
  /** The Shapes list is a disclosure, closed in each session until opened. */
  const shapesOpen = ref(false);
  const state = ref<Record<PaletteToggle, boolean>>(
    Object.fromEntries(PALETTE_TOGGLES.map((d) => [d.key, d.default])) as Record<PaletteToggle, boolean>,
  );

  /** Assigned by the engine; the component and emitAll() both fire it. */
  let onToggle: ((key: PaletteToggle, value: boolean) => void) | null = null;
  let onLookAt: (() => void) | null = null;
  function bind(handlers: { onToggle: (key: PaletteToggle, value: boolean) => void; onLookAt: () => void }) {
    onToggle = handlers.onToggle;
    onLookAt = handlers.onLookAt;
  }

  function set(key: PaletteToggle, value: boolean) {
    state.value[key] = value;
    onToggle?.(key, value);
  }
  function lookAt() {
    onLookAt?.();
  }
  /** Push every toggle's current value to the listener (called on sketch entry). */
  function emitAll() {
    for (const d of PALETTE_TOGGLES) onToggle?.(d.key, state.value[d.key]);
  }

  return { visible, offNormal, shapesOpen, state, bind, set, lookAt, emitAll };
});
