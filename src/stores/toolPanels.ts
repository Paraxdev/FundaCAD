import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { TextValues } from "../sketch/textForm";
import type { ProjectFilter } from "../sketch/projectPanel";
import type { MeasureRow } from "../features/measureRows";

/** The floating overlays a TOOL OF THE APP'S OWN owns while it is running: the
 *  sketch Text panel, the sketch Project filter chips and the Measure readout.
 *  All of them teleport to body, all of them are opened and closed by imperative
 *  tool code through a facade whose signature did not change.
 *
 *  A PLUGIN'S TOOL DOES NOT PUT ITS PANEL HERE, and the docked Texture panel
 *  used to be the fourth entry. Nothing forced it out, a `texture` field on
 *  this store worked perfectly well, but it made the store a list of the tools
 *  the app happens to have, which is the knowledge a plugin boundary exists to
 *  remove: a fourth plugin panel would have been a fourth field here, in a file
 *  that has no other reason to know a plugin exists. A contributed overlay keeps
 *  its own state in its own module and mounts through `contributedOverlays()`,
 *  which is one place for every plugin instead of one field for each.
 *
 *  Independent fields rather than one discriminant, matching panels.ts: they
 *  belong to different tools and nothing here arbitrates between tools,
 *  toolBusy() does, and it stays a plain function.
 *
 *  markRaw on every request: each carries onCommit/onCancel/onChange closures
 *  over the tool instance, which closes over the Viewport and the DocumentStore.
 *  None of that may become a Proxy. */

export interface TextReq {
  /** bumped per show() so the component remounts with fresh form state */
  id: number;
  screen: { x: number; y: number };
  fonts: string[];
  initial: Partial<TextValues>;
  onCommit: (v: TextValues) => void;
  onCancel: () => void;
  onChange: (v: TextValues) => void;
}

export const useToolPanelStore = defineStore("toolPanels", () => {
  let nextId = 1;

  // --- sketch Text tool ---------------------------------------------------
  const text = shallowRef<TextReq | null>(null);

  function openText(req: Omit<TextReq, "id">) {
    text.value = markRaw({ ...req, id: nextId++ });
  }

  /** Commit, with the class's exact ordering: read the callback, tear the panel
   *  down, THEN call it, an onCommit that reopens the panel must not be undone
   *  by our own hide. Empty text is dropped rather than committed. */
  function commitText(v: TextValues) {
    const cb = text.value?.onCommit;
    text.value = null;
    if (v.text.trim()) cb?.(v);
  }

  function cancelText() {
    const cb = text.value?.onCancel;
    text.value = null;
    cb?.();
  }

  // --- sketch Project tool ------------------------------------------------
  /** Survives hide/show: the chosen filter is tool state, not panel state. */
  const projectFilter = ref<ProjectFilter>("edges");
  /** The canvas rect the chips centre themselves over, or null when hidden. */
  const projectAnchor = shallowRef<DOMRect | null>(null);
  const projectChange = shallowRef<((f: ProjectFilter) => void) | null>(null);

  // --- Measure (Inspect) readout ------------------------------------------
  /** null = the tool is not running; [] would be an empty panel. */
  const measure = shallowRef<readonly MeasureRow[] | null>(null);

  return {
    text, openText, commitText, cancelText,
    projectFilter, projectAnchor, projectChange,
    measure,
  };
});
