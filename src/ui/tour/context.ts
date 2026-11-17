// What a tour step reads to tell it is done. Each accessor is read again on every frame while a step is up.

import type { EngineTools } from "../../app/engine";
import type { DocumentStore } from "../../document/store";
import type { SketchMode } from "../../sketch/sketchMode";
import type { SketchOverlay } from "../../sketch/overlay";
import { useExportDialogStore } from "../../stores/exportDialog";
import type { Feature, SketchEntity } from "../../types";
import { runningTool } from "../runningTool";

export interface TourContext {
  /** A plane is being picked for a new sketch. */
  planePick(): boolean;
  sketchOpen(): boolean;
  /** The open sketch's tool, such as `line` or `select`, else the running model tool's action, such as `extrude`. */
  tool(): string | null;
  /** Entities in the open sketch, of one type when given, construction lines left out. 0 with no sketch open. */
  entities(type?: string): number;
  /** Closed areas in the open sketch. */
  regions(): number;
  /** Features in the document, of one type when given. */
  features(type?: string): number;
  /** The newest feature of a type, to read its values or its id. */
  latest(type: string): Feature | null;
  bodies(): number;
  /** A rebuild is running. */
  building(): boolean;
  exportOpen(): boolean;
}

export interface TourHost {
  store: Pick<DocumentStore, "document" | "buildState">;
  sketch: Pick<SketchMode, "active" | "tool" | "snapshotFeature">;
  overlay: Pick<SketchOverlay, "activeRegionCount">;
  tools: EngineTools;
  planePick: boolean;
}

export function tourContext(e: TourHost): TourContext {
  const features = () => e.store.document.features;
  return {
    planePick: () => e.planePick,
    sketchOpen: () => e.sketch.active,
    tool: () => (e.sketch.active ? e.sketch.tool : (runningTool(e.tools)?.action ?? null)),
    entities(type) {
      const f = e.sketch.active ? e.sketch.snapshotFeature() : null;
      const all = (f?.type === "sketch" ? f.entities : []) as SketchEntity[];
      return all.filter((x) => !("construction" in x && x.construction) && (!type || x.type === type)).length;
    },
    regions: () => (e.sketch.active ? e.overlay.activeRegionCount : 0),
    features: (type) => features().filter((f) => !type || f.type === type).length,
    latest: (type) => [...features()].reverse().find((f) => f.type === type) ?? null,
    bodies: () => e.store.buildState.result?.bodies?.length ?? 0,
    building: () => e.store.buildState.building,
    exportOpen: () => useExportDialogStore().request !== null,
  };
}
