// Selection-filter chips for the sketch Project tool: a small floating bar shown
// while the tool is active (TextPanel's floating-DOM style, there is no shared
// FloatingPanel widget, and the Sketch Palette is a persistent checkbox list,
// the wrong shape for a mutually-exclusive mode set).
//
// This is now a FACADE over stores/toolPanels.ts +
// components/overlays/ProjectFilterBar.vue. `filter` stays a plain property
// because sketchMode.ts:3119/3151/3185 read it SYNCHRONOUSLY, inside the
// projection routine, it is tool state that happens to have chips, not panel
// state, so it lives in the store and survives hide()/show().

import { markRaw } from "vue";
import { useToolPanelStore } from "../stores/toolPanels";

export type ProjectFilter = "edges" | "sketchCurves" | "silhouette";

export const PROJECT_CHIPS: { key: ProjectFilter; label: string }[] = [
  { key: "edges", label: "Edges & faces" },
  { key: "sketchCurves", label: "Sketch curves" },
  { key: "silhouette", label: "Body silhouette" },
];

export class ProjectPanel {
  onChange: ((f: ProjectFilter) => void) | null = null;

  get filter(): ProjectFilter {
    return useToolPanelStore().projectFilter;
  }
  set filter(f: ProjectFilter) {
    useToolPanelStore().projectFilter = f;
  }

  /** show the bar centered near the top of `anchor` (the viewport canvas) */
  show(anchor: HTMLElement) {
    const panels = useToolPanelStore();
    // markRaw: reads this.onChange at call time, so SketchMode's late assignment
    // (sketchMode.ts:342) still takes effect.
    panels.projectChange = markRaw((f: ProjectFilter) => this.onChange?.(f));
    // The rect is measured here, exactly as before. The horizontal centring is
    // NOT: it needs the bar's own width, which only exists once it is rendered,
    // so the component does it in onMounted.
    panels.projectAnchor = markRaw(anchor.getBoundingClientRect());
  }

  hide() {
    useToolPanelStore().projectAnchor = null;
  }
}
