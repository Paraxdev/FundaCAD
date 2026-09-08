import { defineStore } from "pinia";

/** The timeline's callbacks into the engine.
 *
 *  These stay handlers rather than becoming store state because each one needs
 *  the live engine, selecting routes through selectFeature (which also
 *  highlights the datum plane), and canRepick reads the LATEST build's
 *  diagnostics on every menu open rather than a cached copy, so a feature
 *  repaired since the build stops offering the repair. */
export interface TimelineHandlers {
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  /** Offer "Re-pick face…" for this feature? (an ambiguous reference was reported) */
  canRepick: (id: string) => boolean;
  onRepick: (id: string) => void;
}

export const useTimelineStore = defineStore("timeline", () => {
  let handlers: TimelineHandlers | null = null;
  function bind(h: TimelineHandlers) {
    handlers = h;
  }
  return {
    bind,
    select: (id: string) => handlers?.onSelect(id),
    edit: (id: string) => handlers?.onEdit(id),
    canRepick: (id: string) => handlers?.canRepick(id) ?? false,
    repick: (id: string) => handlers?.onRepick(id),
  };
});
