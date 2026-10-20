// The page half of the agent harness (tools/harness). It answers where things
// are and what is on screen; every action is real input sent by the Python side.
// Loaded only in a dev build opened with ?harness=1.

import { findControl, HarnessError, stamp, covered, toolPath } from "./locate";
import { REGIONS, screenLines, walkControls, type WalkOptions } from "./screenTree";
import * as read from "./readouts";
import { settle, probe, describeQuiet, type SettleHost } from "./settle";
import * as picks from "./picks";
import { handleList, handlePoint, overHandle, type HandleHost } from "./handles";
import { harnessWanted } from "./wanted";

export { harnessWanted };

export const HARNESS_API = 1;

export type HarnessHost = read.ReadHost & SettleHost & picks.PickHost & HandleHost;

type Args = Record<string, unknown>;
type Method = (args: Args) => unknown;

export interface HarnessBridge {
  api: number;
  call(method: string, args?: Args): Promise<{ ok: true; value: unknown } | { ok: false; error: { kind: string; message: string; candidates: string[] } }>;
}


const str = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string") throw new HarnessError(`${k} must be a string`, "BadArgs");
  return v;
};

const num = (a: Args, k: string): number => {
  const v = a[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HarnessError(`${k} must be a number`, "BadArgs");
  return v;
};

const withBody = (a: Args): string => (typeof a.body === "string" && a.body ? `${a.body}:${str(a, "select")}` : str(a, "select"));

export function startScreen(doc: Document = document): "home" | "welcome" | "none" {
  if (doc.querySelector(".home")) return "home";
  if (doc.querySelector(".modal-overlay")) return "welcome";
  return "none";
}

export function createMethods(
  h: HarnessHost,
  doc: Document = document,
  walkOpts: WalkOptions = {},
  canvasCheck?: picks.CanvasTest,
): Record<string, Method> {
  const walk = () => walkControls(doc, walkOpts);
  const onCanvas = () => canvasCheck ?? picks.canvasTest(h.viewport.domElement, doc);
  const clear = (): picks.CanvasTest => {
    const base = onCanvas();
    return (x, y) => base(x, y) && !overHandle(h, x, y);
  };
  return {
    ready: () => {
      if (!doc.querySelector("#toolrail")) return { ready: false, why: "the tool rail is not mounted yet" };
      if (!h.geometry.connected) return { ready: false, why: "the engine socket is not open" };
      return { ready: true };
    },
    startScreen: () => startScreen(doc),
    stageInert: () => !!doc.querySelector("#stage[inert]"),
    screen: (a) => {
      if (typeof a.region === "string" && !(REGIONS as readonly string[]).includes(a.region)) {
        throw new HarnessError(`no region "${a.region}", the regions are ${REGIONS.join(", ")}`, "BadArgs");
      }
      return screenLines(walk(), {
        ...(typeof a.region === "string" ? { region: a.region } : {}),
        ...(typeof a.max === "number" ? { max: a.max } : {}),
      });
    },
    locate: (a) => {
      const c = findControl(walk(), str(a, "target"));
      return { marker: stamp(c.el), ref: c.ref, label: c.label, role: c.role, disabled: c.disabled, covered: covered(c.el, doc) };
    },
    toolPath: (a) => ({
      steps: toolPath(walk(), str(a, "label"), doc.querySelector<HTMLElement>("#toolrail")?.dataset.mode ?? "model"),
    }),
    fieldValue: (a) => {
      const c = findControl(walk(), str(a, "target"));
      if (!(c.el instanceof HTMLInputElement || c.el instanceof HTMLTextAreaElement)) {
        throw new HarnessError(`${c.ref} is not a value field`, "BadArgs");
      }
      const box = c.el.closest(".dim-input");
      const problem = box?.querySelector(".dim-problem")?.textContent
        ?? c.el.closest(".param-row")?.querySelector(".param-problem")?.textContent ?? "";
      return { ref: c.ref, text: c.el.value, typed: !!c.el.closest(".dim-field.typed"), problem: problem.trim() };
    },
    selection: () => read.selection(h, doc),
    history: () => read.history(h),
    bodies: () => read.bodies(h),
    status: () => read.status(h, doc),
    messages: (a) => read.messages(typeof a.since === "number" ? a.since : 0),
    lastError: () => read.lastError(h),
    settle: (a) => settle(h, {
      ...(typeof a.timeoutMs === "number" ? { timeoutMs: a.timeoutMs } : {}),
      ...(typeof a.trace === "number" ? { trace: a.trace } : {}),
    }),
    quiet: () => describeQuiet(probe(h)),
    facePoint: (a) => picks.facePoint(h, withBody(a), clear()),
    edgePoint: (a) => picks.edgePoint(h, withBody(a), a.via === "edge" ? "edge" : "select", clear()),
    planePoint: (a) => picks.planePoint(h, str(a, "name"), clear()),
    worldPoint: (a) => picks.worldPoint(h, num(a, "x"), num(a, "y"), num(a, "z"), onCanvas()),
    sketchPoint: (a) => picks.sketchPoint(h, num(a, "x"), num(a, "y"), onCanvas()),
    handlePoint: (a) => handlePoint(h, str(a, "name"), onCanvas()),
    handles: () => handleList(h, onCanvas()),
  };
}

export function createBridge(methods: Record<string, Method>): HarnessBridge {
  return {
    api: HARNESS_API,
    async call(method, args = {}) {
      try {
        const fn = methods[method];
        if (!fn) throw new HarnessError(`the page driver has no method "${method}"`, "BadArgs");
        return { ok: true, value: await fn(args ?? {}) };
      } catch (e) {
        if (e instanceof HarnessError) return { ok: false, error: { kind: e.kind, message: e.message, candidates: e.candidates } };
        return { ok: false, error: { kind: "Internal", message: e instanceof Error ? e.message : String(e), candidates: [] } };
      }
    },
  };
}

export function installHarness(h: HarnessHost, win: Window = window): boolean {
  if (!harnessWanted(win.location.search, import.meta.env.DEV)) return false;
  (win as unknown as { __harness: HarnessBridge }).__harness = createBridge(createMethods(h, win.document));
  return true;
}
