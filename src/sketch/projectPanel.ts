// Selection-filter chips for the sketch Project tool, a facade over stores/toolPanels.ts and ProjectFilterBar.vue.
// `filter` stays a plain property because sketchMode.ts reads it synchronously inside the projection routine.

import { markRaw } from "vue";
import { useToolPanelStore } from "../stores/toolPanels";
import { t } from "../i18n";

export type ProjectFilter = "edges" | "sketchCurves" | "silhouette";

export const PROJECT_CHIPS: { key: ProjectFilter; readonly label: string }[] = [
  {
    key: "edges",
    get label() {
      return t("sketch.project.edges");
    },
  },
  {
    key: "sketchCurves",
    get label() {
      return t("sketch.project.sketchCurves");
    },
  },
  {
    key: "silhouette",
    get label() {
      return t("sketch.project.silhouette");
    },
  },
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
