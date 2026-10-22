// Assembles a problem report with the diagnostics a reporter cannot easily give by hand. The form is
// BugReportDialog.vue; nothing leaves the machine but the clipboard, a picture the user saves and a URL opened.

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
import { logEntries } from "./logStore";
import { buildReport, issueUrl, recentErrors, type Report } from "./reportText";
import type { SystemInfo } from "./systemInfo";
import { safeMode, safeModeWhy } from "./safeMode";
import { installedIds, RELEASE_TAG } from "../plugins";
import { pluginEnabled } from "../plugins/registry";
import { openExternal } from "./welcome";
import { saveRenderedImage } from "../io/files";

export interface BugReportDeps {
  store: DocumentStore;
  geometry: GeometryBackend;
  viewport: Viewport;
  sketch: SketchMode;
}

/** Taken when the dialog opens, so typing does not push events off the crumb list and `connected` is the engine
 *  state when the user noticed the problem. */
export interface ReportSnapshot {
  connected: boolean;
  events: string[];
  /** The render pipeline trail (diagnostics/pipelineLog.ts), kept apart from the crumbs since it is long. */
  pipeline: string[];
  faults: boolean;
  errors: string[];
  document: string;
}

export interface ReportChoices {
  description: string;
  version: string;
  system: SystemInfo;
  /** The log tail with user names hidden; null when unticked, in a browser, or before the app wrote one. */
  log: string | null;
  includeDocument: boolean;
}

export interface ComposedReport {
  report: Report;
  /** The report with the document's body as one line giving its size. */
  preview: string;
}

export function createBugReporter(deps: BugReportDeps): void {
  useDialogStore().bindBugReporter(deps);
}

export function openReportDialog(): void {
  const dialogs = useDialogStore();
  if (dialogs.bugDeps) dialogs.bugReport = true;
}

export function activePlugins(): string[] {
  return [...installedIds()].filter(pluginEnabled).sort();
}

function safeModeLine(): string | null {
  const info = safeMode();
  return info ? `on, ${safeModeWhy(info)}` : null;
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

/** Scene stats come first: every performance report needs them and they stay inside the crumb cap. */
export function reportSnapshot(deps: BugReportDeps): ReportSnapshot {
  const live = deps.sketch.snapshotFeature();
  const sketchCrumb = openSketchCrumb(deps.store, live);
  const crumbs = [...deps.viewport.sceneStats(), ...breadcrumbs()];
  return {
    connected: deps.geometry.connected,
    // Prepended, since a reader skims the top of a pasted report.
    events: sketchCrumb ? [sketchCrumb, ...crumbs] : crumbs,
    pipeline: pipelineLog(),
    faults: hasFaults(),
    errors: recentErrors(logEntries()),
    document: documentWithOpenSketch(deps.store, live),
  };
}

export function formatSize(chars: number): string {
  return chars < 1024 ? `${chars} bytes` : `${Math.round(chars / 1024)} KB`;
}

export function composeReport(snap: ReportSnapshot, choices: ReportChoices): ComposedReport {
  const document = choices.includeDocument ? snap.document : null;
  const report = buildReport({
    version: choices.version,
    channel: RELEASE_TAG,
    system: choices.system.system,
    webview: choices.system.webview,
    userAgent: navigator.userAgent,
    connected: snap.connected,
    safeMode: safeModeLine(),
    plugins: activePlugins(),
    description: choices.description,
    events: snap.events,
    errors: snap.errors,
    pipeline: snap.pipeline,
    log: choices.log,
    document,
  });
  const kept = document !== null && report.documentLeftOut === null && report.text.endsWith(document);
  const preview = kept
    ? report.text.slice(0, report.text.length - document.length) +
      `(the current document, ${formatSize(document.length)})`
    : report.text;
  return { report, preview };
}

/** Kept in memory only, since it can hold the design: a GitHub sign up or a verification code overwrites the
 *  clipboard, and a fresh report would have lost its crumbs from the ring of 20. */
let last: { text: string; at: number } | null = null;

export function lastReport(): { text: string; at: number } | null {
  return last;
}

const copyAgainAction = { label: "Copy Again", onClick: () => void copyAgain() };

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    last = { text, at: Date.now() };
    return true;
  } catch {
    toast(
      "Could not reach the clipboard, so the report was not copied. Select the text under What will be sent and copy it.",
      {
        kind: "error",
        timeout: 10000,
      },
    );
    return false;
  }
}

/** Resolves true when the dialog should close, false only when the clipboard was refused so the text is not lost. */
export async function copyReport(text: string): Promise<boolean> {
  if (!(await writeClipboard(text))) return false;
  toast("Report copied.", { kind: "info", action: copyAgainAction });
  return true;
}

export async function copyAgain(): Promise<boolean> {
  if (!last) return false;
  const text = last.text;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast("Could not reach the clipboard, so the report was not copied.", { kind: "error", timeout: 10000 });
    return false;
  }
  toast("Report copied.", { kind: "info", action: copyAgainAction });
  return true;
}

/** The clipboard write is the first await: WebKit refuses it once the click's user activation has passed. */
export async function openIssue(
  text: string,
  fields: { description: string; version: string; system: string },
  picture: string | null,
): Promise<boolean> {
  if (!(await writeClipboard(text))) return false;
  try {
    await openExternal(issueUrl(fields));
  } catch {
    toast(
      "Could not open the browser. The report is copied, paste it into a new issue at github.com/Paraxdev/fundacad/issues.",
      { kind: "warning", timeout: 15000, action: copyAgainAction },
    );
    return true;
  }
  const drag = picture ? ` Drag ${picture} into the issue too.` : "";
  toast(`Report copied. Paste it into the Report box on GitHub.${drag}`, {
    kind: "info",
    timeout: 15000,
    action: copyAgainAction,
  });
  return true;
}

export const PICTURE_NAME = "fundacad-report.png";

/** Rendered in the click's own task, which renderStill needs; realtime, so a path traced view does not stall it. */
export async function savePicture(viewport: Viewport): Promise<{ name: string; url: string } | null> {
  const url = viewport.renderStill(1, { edges: true, realtime: true });
  const path = await saveRenderedImage(url, PICTURE_NAME);
  if (!path) return null;
  return { name: path.split(/[\\/]/).pop() || PICTURE_NAME, url };
}
