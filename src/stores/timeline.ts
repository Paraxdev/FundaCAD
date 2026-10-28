import { defineStore } from "pinia";

/** Handlers rather than state, since each needs the live engine. canRepick reads the latest build's diagnostics on
 *  every menu open, so a feature repaired since stops offering the repair. */
export interface TimelineHandlers {
  onSelect: (id: string | null) => void;
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
    select: (id: string | null) => handlers?.onSelect(id),
    edit: (id: string) => handlers?.onEdit(id),
    canRepick: (id: string) => handlers?.canRepick(id) ?? false,
    repick: (id: string) => handlers?.onRepick(id),
  };
});
