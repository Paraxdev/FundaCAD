// The harness's short readouts. They are the one place outside the app that
// reads its state, so a renamed field breaks this file at compile time.

import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import { featureMeta } from "../ui/featureMeta";
import { logEntries } from "../ui/logStore";
import { sketchRail } from "../ui/railDefs";

export interface ReadHost {
  store: Pick<
    DocumentStore,
    "document" | "buildState" | "rollbackIndex" | "isSuppressed" | "isBodyVisible" | "bodyMaterialId" | "bodyColorSlot" | "previewError" | "canUndo" | "canRedo" | "dirty" | "fileName"
  >;
  viewport: Pick<Viewport, "getSelectedBodies" | "getSelectedFaceIds" | "selectedEdgeLines" | "faceIdToBodyId">;
}

export interface HistoryRow {
  id: string;
  name: string;
  type: string;
  state: string;
}

export function history(h: ReadHost): { count: number; at: string; rows: HistoryRow[] } {
  const { store } = h;
  const features = store.document.features;
  const result = store.buildState.result;
  const errors = new Map<string, string>();
  for (const e of result?.featureErrors ?? []) if (e.feature_id) errors.set(e.feature_id, e.message);
  const failed = store.buildState.errorFeatureId;
  if (failed && store.buildState.errorMessage) errors.set(failed, store.buildState.errorMessage);
  const roll = store.rollbackIndex;
  const rows = features.map((f, i): HistoryRow => {
    const named = (f as { name?: string }).name;
    let state = "";
    if (i >= roll) state = "rolled back";
    else if (store.isSuppressed(f.id)) state = "suppressed";
    else if (errors.has(f.id)) state = `error: ${errors.get(f.id)}`;
    return { id: f.id, name: named || featureMeta(f).label, type: f.type, state };
  });
  const at = roll >= features.length ? "at end" : `rolled back to ${roll}`;
  return { count: features.length, at, rows };
}

export interface BodyRow {
  id: string;
  name: string;
  faces: number;
  visible: boolean;
  material: string | null;
  /** The colour palette slot the body wears, when it was given one. */
  slot: number | null;
  fault: string | null;
}

export function bodies(h: ReadHost): BodyRow[] {
  return (h.store.buildState.result?.bodies ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    faces: b.faceCount,
    visible: h.store.isBodyVisible(b.id),
    material: h.store.bodyMaterialId(b.id) ?? null,
    slot: h.store.bodyColorSlot(b.id) ?? null,
    fault: b.fault ?? null,
  }));
}

export interface Selection {
  bodies: string[];
  faces: [string, number][];
  edges: string[];
  readout: string;
}

export function selection(h: ReadHost, doc: Document = document): Selection {
  const result = h.store.buildState.result;
  const starts = new Map((result?.bodies ?? []).map((b) => [b.id, b.faceStart]));
  const faces = h.viewport.getSelectedFaceIds().map((id): [string, number] => {
    const body = h.viewport.faceIdToBodyId(id) ?? "?";
    return [body, id - (starts.get(body) ?? 0)];
  });
  return {
    bodies: h.viewport.getSelectedBodies(),
    faces,
    edges: h.viewport.selectedEdgeLines().map((e) => e.id),
    readout: text(doc, "[data-testid=selection-readout]"),
  };
}

/** The element's own text, without its children's or a dev build's comments. */
function ownText(el: Element): string {
  return [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
}

function text(doc: Document, sel: string): string {
  return (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
}

export interface Message {
  seq: number;
  level: string;
  text: string;
  at: number;
}

export function messages(since = 0): { seq: number; rows: Message[] } {
  const all = logEntries();
  const rows = all.filter((e) => e.id > since).slice(-100)
    .map((e) => ({ seq: e.id, level: e.level, text: e.message, at: e.at }));
  return { seq: all.length ? all[all.length - 1]!.id : since, rows };
}

/** The newest log id, the mark a step takes so its readouts skip older messages. */
export function seq(): number {
  const all = logEntries();
  return all.length ? all[all.length - 1]!.id : 0;
}

/** The newest error: a failed build, a refused preview, or an error logged after `since`. */
export function lastError(h: ReadHost, since = 0): string | null {
  const b = h.store.buildState;
  if (b.heldRefusal) return b.heldRefusal.message;
  if (h.store.previewError) return h.store.previewError;
  if (b.errorMessage) return b.errorMessage;
  const errs = logEntries().filter((e) => e.level === "error" && e.id > since);
  return errs.length ? errs[errs.length - 1]!.message : null;
}

export interface Status {
  mode: string;
  tool: string | null;
  workspace: string;
  doc: string;
  dirty: boolean;
  undo: boolean;
  redo: boolean;
  prompt: string;
  selection: string;
  recent: Message | null;
  error: string | null;
  /** Warning buttons the view raises on its own, such as Low performance. */
  warnings: string[];
}

/** A sketch tool shows no running tool button, the rail lights its own button instead. */
function sketchToolLabel(action: string | undefined): string | null {
  if (!action) return null;
  for (const e of sketchRail()) {
    const t = e.kind === "tool" ? (e.action === action ? e : undefined) : e.items.find((i) => i.action === action);
    if (t) return t.label;
  }
  return null;
}

export function status(h: ReadHost, doc: Document = document, since = 0): Status {
  const rail = doc.querySelector<HTMLElement>("#toolrail");
  const running = doc.querySelector<HTMLElement>('[data-action="running-tool"]');
  const ws = doc.querySelector<HTMLElement>('[data-workspace][aria-pressed="true"]');
  const docName = doc.querySelector("#docname");
  const promptEl = doc.querySelector("#prompt");
  const prompt = promptEl?.closest(".hidden") ? "" : text(doc, "#prompt");
  const log = logEntries();
  const last = log.length && log[log.length - 1]!.id > since ? log[log.length - 1] : undefined;
  return {
    mode: rail?.dataset.mode ?? "unknown",
    tool: running
      ? (running.getAttribute("aria-label") ?? running.textContent ?? "").replace(/\s*\([^()]*\)\s*$/, "").trim()
      : sketchToolLabel(rail?.dataset.sketchTool),
    workspace: ws?.dataset.workspace ?? "model",
    doc: docName ? ownText(docName) : h.store.fileName,
    dirty: h.store.dirty,
    undo: h.store.canUndo,
    redo: h.store.canRedo,
    prompt,
    selection: text(doc, "[data-testid=selection-readout]"),
    recent: last ? { seq: last.id, level: last.level, text: last.message, at: last.at } : null,
    error: lastError(h, since),
    warnings: [...doc.querySelectorAll("#viewcontrols .perf-warn")].map((b) => b.getAttribute("title") ?? "").filter(Boolean),
  };
}
