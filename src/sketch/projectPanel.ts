// Selection-filter chips for the sketch Project tool, a facade over stores/toolPanels.ts and ProjectFilterBar.vue.
// `filter` stays a plain property because sketchMode.ts reads it synchronously inside the projection routine.

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

  show(anchor: HTMLElement) {
    const panels = useToolPanelStore();
    // markRaw reads this.onChange at call time, so SketchMode's late assignment still takes effect.
    panels.projectChange = markRaw((f: ProjectFilter) => this.onChange?.(f));
    // The horizontal centring needs the bar's rendered width, so the component does it in onMounted.
    panels.projectAnchor = markRaw(anchor.getBoundingClientRect());
  }

  hide() {
    useToolPanelStore().projectAnchor = null;
  }
}
