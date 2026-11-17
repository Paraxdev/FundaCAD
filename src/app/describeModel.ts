// The 3D view's hidden summary, the Describe model dialog and Describe selection, all read through ui/readouts.ts.

import { watch } from "vue";
import type * as THREE from "three";
import { t } from "../i18n";
import type { DocumentStore } from "../document/store";
import type { SectionTool } from "../features/sectionTool";
import { useDialogStore } from "../stores/dialogs";
import { useGeometryBrowserStore } from "../stores/geometryBrowser";
import { useSelectionStore } from "../stores/selection";
import { announce } from "../ui/announce";
import { bodyLabels } from "../ui/bodyLabels";
import { numberedName } from "../ui/featureMeta";
import { describeModel, selectionSpeech, type Box, type ModelFacts, type SelectedPart } from "../ui/modelDescription";
import * as read from "../ui/readouts";
import { countLine } from "../ui/selectionTools";
import {
  standardViewOf,
  viewSummary,
  viewSummaryText,
  type SelectionFacts,
  type SummaryFacts,
  type ViewFacts,
} from "../ui/viewSummary";
import type { Viewport } from "../viewport/viewport";
import { whenViewSettles } from "../viewport/viewSettled";

export interface DescribeHost {
  canvas: HTMLElement;
  store: read.ReadHost["store"] & Pick<DocumentStore, "bodyName" | "onBuild" | "onDocChange">;
  viewport: read.ReadHost["viewport"] &
    Pick<Viewport, "bodyProperties" | "facesBox" | "viewDirection"> & {
      rig: Pick<Viewport["rig"], "isOrtho" | "isFlying" | "poseVersion">;
    };
  tools: { section: Pick<SectionTool, "phase" | "onChange"> };
}

/** The pause after the last change before the summary is written again, so a burst of build progress writes once. */
export const SUMMARY_DELAY = 250;

const labelsOf = (e: DescribeHost) => bodyLabels(e.store.buildState.result?.bodies ?? [], (id) => e.store.bodyName(id));

function viewFacts(e: DescribeHost): ViewFacts {
  const look = e.viewport.viewDirection();
  const phase = e.tools.section.phase;
  return {
    view: standardViewOf([-look.x, -look.y, -look.z]),
    ortho: e.viewport.rig.isOrtho(),
    section: phase === "on" || phase === "editing",
  };
}

function selectionFacts(e: DescribeHost, names: Map<string, string>): SelectionFacts {
  return {
    bodies: e.viewport.getSelectedBodies().map((id) => names.get(id) ?? id),
    faces: e.viewport.getSelectedFaceIds().length,
    edges: e.viewport.selectedEdgeLines().length,
  };
}

const failedCount = (rows: read.HistoryRow[]) => rows.filter((r) => r.state.startsWith("error")).length;

export function summaryFacts(e: DescribeHost): SummaryFacts {
  const built = e.store.buildState.result?.bodies ?? [];
  const history = read.history(e);
  return {
    bodies: built.length,
    hidden: built.filter((b) => !e.store.isBodyVisible(b.id)).length,
    features: history.count,
    failed: failedCount(history.rows),
    view: viewFacts(e),
    selection: selectionFacts(e, labelsOf(e)),
  };
}

export function modelFacts(e: DescribeHost): ModelFacts {
  const names = labelsOf(e);
  const places = new Map(read.bodyPlaces(e).map((p) => [p.id, p]));
  const features = e.store.document.features;
  const states = read.history(e).rows;
  return {
    file: e.store.fileName,
    bodies: read.bodies(e).map((b) => ({
      name: names.get(b.id) ?? b.name,
      box: places.get(b.id)?.box ?? null,
      volume: places.get(b.id)?.volume ?? null,
      visible: b.visible,
      material: b.material,
      fault: b.fault,
    })),
    features: features.map((f, i) => ({
      name: numberedName(f as Parameters<typeof numberedName>[0], features as Parameters<typeof numberedName>[1]),
      state: states[i]?.state ?? "",
    })),
    view: viewFacts(e),
    selection: selectionFacts(e, names),
  };
}

function boxOf(b: THREE.Box3 | null | undefined): Box | null {
  if (!b || b.isEmpty()) return null;
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}

function pointsBox(points: readonly (readonly [number, number, number])[]): Box | null {
  if (!points.length) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  }
  return { min, max };
}

/** More bodies than this are said as one count and one box. */
const BODIES_ONE_BY_ONE = 3;

export function selectedParts(e: DescribeHost): SelectedPart[] {
  const names = labelsOf(e);
  const nameOf = (id: string) => names.get(id) ?? id;
  const counted = (kind: "face" | "edge", n: number, ids: readonly (string | null | undefined)[]) => {
    const owners = new Set(ids);
    const only = owners.size === 1 ? [...owners][0] : null;
    return only ? t("describe.selection.on", { kind, n, body: nameOf(only) }) : countLine(kind, n);
  };
  const parts: SelectedPart[] = [];
  const bodies = e.viewport.getSelectedBodies();
  if (bodies.length > BODIES_ONE_BY_ONE)
    parts.push({ what: countLine("body", bodies.length), box: boxOf(e.viewport.bodyProperties(bodies)?.bbox) });
  else for (const id of bodies) parts.push({ what: nameOf(id), box: boxOf(e.viewport.bodyProperties([id])?.bbox) });
  const faces = e.viewport.getSelectedFaceIds();
  if (faces.length)
    parts.push({
      what: counted(
        "face",
        faces.length,
        faces.map((f) => e.viewport.faceIdToBodyId(f)),
      ),
      box: boxOf(e.viewport.facesBox(faces)),
    });
  const edges = e.viewport.selectedEdgeLines();
  if (edges.length)
    parts.push({
      what: counted(
        "edge",
        edges.length,
        edges.map((l) => l.body),
      ),
      box: pointsBox(edges.flatMap((l) => l.points)),
    });
  return parts;
}

export function openDescribeModel(e: DescribeHost): void {
  useDialogStore().describeModel = describeModel(modelFacts(e));
}

export function describeSelectionAloud(e: DescribeHost): void {
  announce(selectionSpeech(selectedParts(e)), "polite", { key: "describe-selection" });
}

/** Rewrites the summary a pause after a build, selection, view or section change, never on a frame. Camera moves end
 *  in a pointer, key or wheel event, and the view is waited out until it settles. */
export function installViewSummary(e: DescribeHost): () => void {
  let cancel: (() => void) | null = null;
  const write = () => {
    const text = viewSummary(summaryFacts(e));
    if (viewSummaryText.value !== text) viewSummaryText.value = text;
  };
  const schedule = () => {
    cancel?.();
    cancel = whenViewSettles(e.viewport.rig, SUMMARY_DELAY, write);
  };
  // Read on focus, so it must be right then.
  const now = () => {
    cancel?.();
    write();
  };
  const events = ["pointerup", "keyup", "wheel"] as const;
  for (const ev of events) window.addEventListener(ev, schedule, { passive: true });
  e.canvas.addEventListener("focus", now);
  const offs = [
    e.store.onBuild(schedule),
    e.store.onDocChange(schedule),
    e.tools.section.onChange(schedule),
    watch(() => [useSelectionStore().rows, useGeometryBrowserStore().selected], schedule),
  ];
  now();
  return () => {
    for (const ev of events) window.removeEventListener(ev, schedule);
    e.canvas.removeEventListener("focus", now);
    for (const off of offs) off();
    cancel?.();
  };
}
