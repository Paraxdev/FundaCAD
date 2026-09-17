// One tool class for every toolbox verb: act on the faces already selected, or wait for a pick and
// Enter. The feature it adds carries every value, so editing happens in the history's value rows.

import { setPrompt } from "fundacad";
import type { DocumentStore, Viewport } from "fundacad";
import { featureFor, type BuildDir, type FacePick, type PrintTool } from "./printForm";

export class FaceTool {
  active = false;
  private tool: PrintTool | null = null;
  private onDone: ((id: string | null) => void) | null = null;

  private keyHandler = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.commit()) setPrompt(this.prompt("nothing is selected yet"));
    }
  };

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {}

  start(tool: PrintTool, onDone: (id: string | null) => void) {
    if (this.active) return;
    this.tool = tool;
    this.onDone = onDone;
    if (this.commit()) return;
    this.active = true;
    this.viewport.setSelectionMode("faces");
    setPrompt(this.prompt());
    document.addEventListener("keydown", this.keyHandler, true);
  }

  cancel() {
    if (!this.tool) return;
    this.finish(null);
  }

  private prompt(note?: string): string {
    const t = this.tool!;
    return `${t.label}: ${note ? `${note}, ` : ""}${t.pickHint} · Enter to apply · Esc to cancel`;
  }

  private picks(): FacePick[] {
    const sel = this.viewport.selectedFacesForPressPull();
    if (!sel) return [];
    return sel.selectors.flatMap((s, i) => {
      if (!("point" in s)) return [];
      const faceId = sel.faceIds[i];
      return [{
        point: s.point as [number, number, number],
        body: faceId === undefined ? null : this.viewport.faceIdToBodyId(faceId),
      }];
    });
  }

  private commit(): boolean {
    const tool = this.tool;
    if (!tool) return false;
    const dir = this.viewport.draftConfig.dir as BuildDir;
    const feature = featureFor(tool, this.store.nextId(), this.picks(), dir);
    if (!feature) return false;
    this.store.addFeature(feature);
    this.finish(feature.id);
    return true;
  }

  private finish(id: string | null) {
    const done = this.onDone;
    if (this.active) {
      document.removeEventListener("keydown", this.keyHandler, true);
      setPrompt(null);
    }
    this.active = false;
    this.tool = null;
    this.onDone = null;
    if (id) this.viewport.clearSelection();
    done?.(id);
  }
}
