// The Printability panel's controller: what would go wrong making the bodies
// layer by layer. The settings are edited in the panel (PrintabilityPanel.vue);
// this side picks the bodies, runs the engine's printability check with a
// Cancel, and tints the faces it flagged on a face-mark layer of its own.
//
// Everything it needs is on the engine a builtin is handed: the store for the
// document and the build, the viewport for the selection and the tints, the
// geometry client for the check. The app has no idea the panel exists.

import { shallowRef } from "vue";
import type { DocumentStore, GeometryBackend, Viewport } from "fundacad";
import {
  buildPrintabilityRequest, findingMarks, findingView, formatPrintabilityResult, problemCount,
} from "./printability";
import { createPrintabilityState } from "./printabilityState";

/** Its own layer of face marks, so the app's Stress marks and these come and go apart. */
export const PRINTABILITY_MARKS = "printability";

/** The finding a row puts forward is drawn in the app's hover amber, the
 *  colour of the face under the pointer. Its own copy, as a plugin cannot
 *  import the viewport's (viewport/highlight.ts, EDGE_HOVER_COLOR); a test
 *  holds the two together. */
export const EMPHASIS_COLOR = 0xffd089;

export interface PrintabilityDeps {
  store: Pick<DocumentStore, "buildState" | "builtDocument" | "isBodyVisible" | "onBuild" | "onDocChange" | "onOpen">;
  viewport: Pick<Viewport, "frameAround" | "getSelectedBodies" | "onStressOverlayChange" | "setFaceMarks" | "stressOverlayBody">;
  geometry: Pick<GeometryBackend, "cancel" | "printability">;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
}

export function createPrintabilityPanel(deps: PrintabilityDeps) {
  const { store, viewport, geometry, hasBody, setStatus } = deps;
  const state = createPrintabilityState();
  const { data } = state;

  /** The bodies the panel can check, in build order, for its Bodies line. */
  const bodies = shallowRef<{ id: string; name: string }[]>([]);

  // Bumped on every document change, so a result for a model the user has
  // edited since is not tinted over the new one.
  let docEpoch = 0;
  // Bumped per Check and on close, so a reply for an earlier Check is dropped.
  let checkSeq = 0;
  // The document the result's face ids were taken on.
  let checkedEpoch = -1;

  function builtBodies(): { id: string; name: string }[] {
    return (store.buildState.result?.bodies ?? []).map((b) => ({ id: b.id, name: b.name }));
  }

  /** What a Check covers: the selected bodies, or none named when none is
   *  selected, so the engine checks every body of the document it is sent
   *  rather than of a build that may be about to be replaced. */
  function scope(): string[] {
    const all = builtBodies().map((b) => b.id);
    return viewport.getSelectedBodies().filter((id) => all.includes(id));
  }

  function show() {
    if (!hasBody()) {
      setStatus("Printability: create or import a body first", "");
      return;
    }
    if (!geometry.printability) {
      setStatus("Printability: this geometry engine cannot run the check", "error");
      return;
    }
    state.show();
    refreshMarks();
    setStatus("Printability: checks the selected bodies, or every body when none is selected", "");
  }

  /** Tint the faces the last Check flagged, one colour per kind, and the
   *  finding a row puts forward in the hover colour. Nothing once the model
   *  has changed since, when the face ids may name other faces, nor on a body
   *  the user has hidden or the stress colours are on. */
  function refreshMarks() {
    const d = data.value;
    if (d?.result && !d.stale && checkedEpoch !== docEpoch) state.setStale();
    if (!d?.result || d.stale) {
      viewport.setFaceMarks(null, PRINTABILITY_MARKS);
      return;
    }
    // The engine numbers each body's faces from 0; the viewport numbers on
    // from the body's faceStart. An index past the body's faces is left plain
    // rather than tinted on the next body.
    const built = new Map((store.buildState.result?.bodies ?? []).map((b) => [b.id, b]));
    // A body painted by stress shows its stress, not these.
    const stressed = viewport.stressOverlayBody();
    const faceOf = (body: string, face: number): number | null => {
      const b = built.get(body);
      if (!b || body === stressed || !store.isBodyVisible(body) || !Number.isInteger(face) || face < 0 || face >= b.faceCount) return null;
      return b.faceStart + face;
    };
    viewport.setFaceMarks(findingMarks(d.result.findings, d.hovered ?? d.picked, EMPHASIS_COLOR, faceOf), PRINTABILITY_MARKS);
  }

  /** Put a finding forward while the pointer is over its row, null once it leaves. */
  function hover(index: number | null) {
    const d = data.value;
    if (!d || d.hovered === index) return;
    state.setFocus("hovered", index);
    refreshMarks();
  }

  /** Put a finding forward until another is clicked, and look at it. */
  function pick(index: number) {
    const f = data.value?.result?.findings[index];
    if (!f) return;
    state.setFocus("picked", index);
    refreshMarks();
    const v = findingView(f);
    viewport.frameAround(v.at, v.size);
  }

  async function run() {
    const d = data.value;
    if (!d || d.running) return;
    if (!geometry.printability) {
      setStatus("Printability: this geometry engine cannot run the check", "error");
      return;
    }
    const req = buildPrintabilityRequest(d.setup, scope());
    if (!req.ok) {
      state.finished({ error: req.message });
      setStatus(`Printability: ${req.message}`, "");
      return;
    }
    const seq = ++checkSeq;
    const epoch = docEpoch;
    state.started();
    state.clearResult();
    viewport.setFaceMarks(null, PRINTABILITY_MARKS);
    setStatus("Checking printability…", "");
    const res = await geometry.printability(store.builtDocument(), req.options, (id) => {
      if (seq === checkSeq) state.sent(id);
    });
    if (seq !== checkSeq || !data.value) return;
    if (!res.ok) {
      state.finished(res.cancelled ? {} : { error: res.message });
      setStatus(res.cancelled ? "Printability check cancelled" : `Printability check failed: ${res.message}`, res.cancelled ? "" : "error");
      return;
    }
    const view = formatPrintabilityResult(res.result);
    checkedEpoch = epoch;
    state.finished({ result: view });
    const n = problemCount(view);
    setStatus(n ? `Printability: ${n} thing${n === 1 ? "" : "s"} to look at` : "Printability: nothing found", n ? "" : "connected");
    refreshMarks();
    if (epoch !== docEpoch) setStatus("Printability: the model changed while it ran, check again to see the faces", "");
  }

  /** Stop the Check in flight. Only by its own id: without one the client
   *  falls back to the most recent request, which may be a rebuild. */
  async function cancel() {
    const id = data.value?.running ? data.value.requestId : null;
    if (id) await geometry.cancel?.(id);
  }

  /** Close the panel, stopping a Check in flight, and drop its tints. */
  function close() {
    if (data.value?.running) void cancel();
    checkSeq++;
    state.close();
    viewport.setFaceMarks(null, PRINTABILITY_MARKS);
  }

  const offs = [
    store.onDocChange(() => { docEpoch++; }),
    // Another document took this one's place: the result names its bodies.
    store.onOpen(() => { if (data.value) close(); }),
    // setModel drops every face mark with the old face ids, so tint again on
    // each completed build. The app's rebuild bridge subscribed before any
    // plugin was started (app/engine.ts mountUi installs it, then
    // activatePlugins starts this one asynchronously), and the store calls its
    // build listeners in the order they subscribed, so the new model is already
    // drawn when this runs.
    store.onBuild((s) => {
      bodies.value = builtBodies();
      if (s.result && !s.building) refreshMarks();
    }),
    // The Stress panel's colours went onto a body or came off one: these
    // tints step aside for them, or come back.
    viewport.onStressOverlayChange(() => refreshMarks()),
  ];

  /** Close, drop the tints and stop listening: what switching the plugin off
   *  leaves behind is nothing. */
  function dispose() {
    close();
    for (const off of offs) off();
  }

  return { state, data, bodies, show, close, run, cancel, hover, pick, refreshMarks, dispose };
}

export type PrintabilityPanel = ReturnType<typeof createPrintabilityPanel>;

/** The running panel, for the overlay component to draw: set by activate(),
 *  null once the plugin is switched off. */
export const printabilityPanel = shallowRef<PrintabilityPanel | null>(null);
