// Assembles a bug report with the diagnostics a reporter cannot easily give by hand and puts it on the clipboard.
// The button is in components/shell/ViewportControls.vue and the form in BugReportDialog.vue.

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { toast } from "./toast";
import { breadcrumbs } from "../diagnostics/breadcrumbs";
import { hasFaults, pipelineLog } from "../diagnostics/pipelineLog";
import { useDialogStore } from "../stores/dialogs";
import type { Viewport } from "../viewport/viewport";
import type { SketchMode } from "../sketch/sketchMode";
import { asFeature } from "../types";
import type { Feature } from "../types";

export interface BugReportDeps {
  store: DocumentStore;
  geometry: GeometryBackend;
  viewport: Viewport;
  sketch: SketchMode;
}

export interface BugReportForm {
  description: string;
  includeDocument: boolean;
  version: string;
  /** Both snapshotted when the dialog opened, so typing does not push events off the crumb list and `connected`
   *  is the engine state when the user noticed the problem. */
  connected: boolean;
  crumbs: string[];
  /** The render pipeline trail (diagnostics/pipelineLog.ts), kept apart from the crumbs since it is long. */
  pipeline: string[];
  /** The log tail with user names hidden; null when unticked, in a browser, or before the app wrote one. */
  logTail: string | null;
}

/** The floating button renders once these handles exist. */
export function createBugReporter(deps: BugReportDeps): void {
  useDialogStore().bindBugReporter(deps);
}

/** Collected at open time. Scene stats come first: every performance report needs them and they stay inside
 *  the breadcrumb cap. */
export function bugContext(deps: BugReportDeps): {
  connected: boolean;
  crumbs: string[];
  pipeline: string[];
  faults: boolean;
} {
  return {
    connected: deps.geometry.connected,
    crumbs: [...deps.viewport.sceneStats(), ...breadcrumbs()],
    pipeline: pipelineLog(),
    faults: hasFaults(),
  };
}

export async function appLogTail(): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string | null>("log_tail");
  } catch {
    return null;
  }
}

/** `store.toJSON()` is only the committed document, so a sketch still being drawn has to be added here. */
function documentWithOpenSketch(store: DocumentStore, live: Feature | null): string {
  if (!live) return store.toJSON();
  const doc = JSON.parse(store.toJSON());
  const i = doc.features.findIndex((f: Feature) => f.id === live.id);
  if (i >= 0) doc.features[i] = live;
  else doc.features.push(live);
  return JSON.stringify(doc);
}

/** Recorded even without the document attached: it tells the triager the repro starts inside a sketch. */
function openSketchCrumb(store: DocumentStore, live: Feature | null): string | null {
  if (!live) return null;
  const isEdit = JSON.parse(store.toJSON()).features.some((f: Feature) => f.id === live.id);
  const sketch = asFeature(live, "sketch");
  const ents = sketch ? sketch.entities.length : 0;
  const cons = sketch?.constraints?.length ?? 0;
  return (
    `sketch OPEN when reported (${isEdit ? `editing ${live.id}` : "new, uncommitted"}): ` +
    `${ents} entities, ${cons} constraints`
  );
}

function reportText(
  description: string,
  version: string,
  connected: boolean,
  crumbs: string[],
  pipeline: string[],
  logTail: string | null,
  documentJson: string | null,
): string {
  return [
    `FundaCAD bug report`,
    `version: ${version} · ${navigator.userAgent.slice(0, 80)}`,
    `geometry engine connected: ${connected}`,
    ``,
    description,
    ``,
    `recent events:`,
    ...crumbs.map((c) => `  ${c}`),
    ``,
    `render pipeline:`,
    ...pipeline.map((c) => `  ${c}`),
    ...(logTail ? [``, `app log (the end, user names hidden):`, logTail.trimEnd()] : []),
    ...(documentJson ? [``, `document:`, documentJson] : []),
  ].join("\n");
}

/** Resolves true when the dialog should close, false only when the clipboard was refused so the text is not lost. */
export async function submitBugReport(deps: BugReportDeps, form: BugReportForm): Promise<boolean> {
  const { store, sketch } = deps;
  const live = sketch.snapshotFeature();
  const sketchCrumb = openSketchCrumb(store, live);
  // Prepended, since a reader skims the top of a pasted report.
  const crumbList = sketchCrumb ? [sketchCrumb, ...form.crumbs] : form.crumbs;
  const connected = form.connected;
  const text = reportText(
    form.description,
    form.version,
    connected,
    crumbList,
    form.pipeline,
    form.logTail,
    form.includeDocument ? documentWithOpenSketch(store, live) : null,
  );
  try {
    await navigator.clipboard.writeText(text);
    toast("Bug report copied. Paste it into a new issue on the tracker.", { kind: "info" });
    return true;
  } catch {
    // Clipboard refused (no permission, no secure context): keep the dialog open so the text is not lost.
    toast("Could not reach the clipboard, so the report was not copied.", {
      kind: "error",
      timeout: 10000,
    });
    return false;
  }
}
