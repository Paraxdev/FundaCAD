// In-app bug reporter: a floating bug button (bottom-right) opening a small
// report dialog. It gathers a description plus the diagnostics that are hard to
// ask a reporter for by hand (scene stats, breadcrumbs, optionally the
// document) and puts the lot on the clipboard, ready to paste into an issue.
//
// It used to POST this to a hosted endpoint. Nothing leaves the machine now: no
// account, no network, and no server that has to be up for the button to work.
// The clipboard was already the fallback path for every failed submit, so this
// is the path that was always the reliable one.
//
// The button is components/overlays/BugReportButton.vue and the dialog is
// BugReportDialog.vue. What stays here is everything that is NOT markup: what a
// report contains, how it is assembled, and the clipboard fallback. The
// component owns the form fields and calls submitBugReport().

import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import { toast } from "./toast";
import { breadcrumbs } from "../diagnostics/breadcrumbs";
import { useDialogStore } from "../stores/dialogs";
import type { Viewport } from "../viewport/viewport";
import type { SketchMode } from "../sketch/sketchMode";
import type { Feature } from "../types";

export interface BugReportDeps {
  store: DocumentStore;
  geometry: GeometryBackend;
  viewport: Viewport;
  sketch: SketchMode;
}

/** What the dialog is willing to send, as the user has ticked it. */
export interface BugReportForm {
  description: string;
  includeDocument: boolean;
  version: string;
  /** Both snapshotted when the dialog opened — the crumbs so that filling the
   *  form in doesn't push the interesting events off the end of the list, and
   *  `connected` so the report says what the sidecar was doing when the user
   *  decided something was wrong, not when they finished typing. */
  connected: boolean;
  crumbs: string[];
}

/** Registers the reporter's engine handles. The floating button renders once
 *  these exist; app/engine.ts's mountUi() call site is unchanged. */
export function createBugReporter(deps: BugReportDeps): void {
  useDialogStore().bindBugReporter(deps);
}

/** The context line collected at OPEN time.
 *
 *  Scene stats come FIRST: they answer the questions a performance report
 *  always raises (how many triangles, how big the canvas, what frame rate), and
 *  leading the list keeps them inside the server's breadcrumb cap. */
export function bugContext(deps: BugReportDeps): { connected: boolean; crumbs: string[] } {
  return {
    connected: deps.geometry.connected,
    crumbs: [...deps.viewport.sceneStats(), ...breadcrumbs()],
  };
}

/** The document as the user sees it, including a sketch still being drawn.
 *  `store.toJSON()` alone is the COMMITTED document: an open sketch has not
 *  reached it yet, so a report filed from inside the sketcher carried a stale
 *  sketch, or none at all when it was the first. */
function documentWithOpenSketch(store: DocumentStore, live: Feature | null): string {
  if (!live) return store.toJSON();
  const doc = JSON.parse(store.toJSON());
  const i = doc.features.findIndex((f: Feature) => f.id === live.id);
  if (i >= 0) doc.features[i] = live;
  else doc.features.push(live);
  return JSON.stringify(doc);
}

/** Says the report came from inside the sketcher. Worth recording even when
 *  the document is NOT attached: it tells the triager the repro starts by
 *  opening a sketch, which no other field carries. */
function openSketchCrumb(store: DocumentStore, live: Feature | null): string | null {
  if (!live) return null;
  const isEdit = JSON.parse(store.toJSON()).features.some((f: Feature) => f.id === live.id);
  const ents = live.type === "sketch" ? live.entities.length : 0;
  const cons = live.type === "sketch" ? (live.constraints?.length ?? 0) : 0;
  return `sketch OPEN when reported (${isEdit ? `editing ${live.id}` : "new, uncommitted"}): ` +
    `${ents} entities, ${cons} constraints`;
}

/** The report, as pasteable text. */
function reportText(
  description: string,
  version: string,
  connected: boolean,
  crumbs: string[],
  documentJson: string | null,
): string {
  return [
    `Neocad bug report`,
    `version: ${version} · ${navigator.userAgent.slice(0, 80)}`,
    `geometry engine connected: ${connected}`,
    ``,
    description,
    ``,
    `recent events:`,
    ...crumbs.map((c) => `  ${c}`),
    ...(documentJson ? [``, `document:`, documentJson] : []),
  ].join("\n");
}

/** Put the report on the clipboard. Resolves true when the dialog should close,
 *  which is every case except a clipboard the browser would not give us: there
 *  the dialog stays open so the text is not silently lost. */
export async function submitBugReport(deps: BugReportDeps, form: BugReportForm): Promise<boolean> {
  const { store, sketch } = deps;
  const live = sketch.snapshotFeature();
  const sketchCrumb = openSketchCrumb(store, live);
  // prepended, not appended: the same reasoning that puts scene stats first
  // applies here, and a reader skims the top of a pasted report.
  const crumbList = sketchCrumb ? [sketchCrumb, ...form.crumbs] : form.crumbs;
  const connected = form.connected;
  const text = reportText(
    form.description,
    form.version,
    connected,
    crumbList,
    form.includeDocument ? documentWithOpenSketch(store, live) : null,
  );
  try {
    await navigator.clipboard.writeText(text);
    toast("Bug report copied. Paste it into a new issue on the tracker.", { kind: "info" });
    return true;
  } catch {
    // Refused clipboard (no permission, no secure context). Leave the dialog
    // open rather than closing over text the user cannot get back.
    toast("Could not reach the clipboard, so the report was not copied.", {
      kind: "error",
      timeout: 10000,
    });
    return false;
  }
}
