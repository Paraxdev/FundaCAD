import { describe, it, expect, vi, afterEach } from "vitest";
import type { CadDocument, ParamDef, ParamExtras } from "../../src/types";
import { commitDeleteParam, commitRenameParam, deleteBlockers, defsOf, recompute } from "../../src/params/engine";
import {
  captureConfiguration, checkResults, clampToControl, configurationDrift, controlProblem, trialConfiguration,
} from "../../src/params/extras";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

vi.stubGlobal("window", globalThis);

function fixture(defs: Record<string, ParamDef>, extras?: ParamExtras): CadDocument {
  const doc: CadDocument = { parameters: {}, paramDefs: defs, features: [], ...(extras ? { paramExtras: extras } : {}) };
  recompute(doc);
  return doc;
}

const user = (expr: string): ParamDef => ({ expr, value: 0, unit: "count" });

describe("parameter extras", () => {
  it("rename follows checks and configurations, keys and expressions both, and keeps table order", () => {
    const doc = fixture(
      { rings: user("22"), gap: user("0.5"), wall: user("0.8") },
      {
        checks: [{ id: "k1", expr: "gap >= 0.3 && rings > 1", message: "gap too small", level: "warning" }],
        configurations: [{ id: "c1", name: "Dense", values: { rings: "30", wall: "gap + 0.3" } }],
      },
    );
    commitRenameParam(doc, "gap", "clearance");
    commitRenameParam(doc, "rings", "count");
    expect(Object.keys(defsOf(doc))).toEqual(["count", "clearance", "wall"]);
    expect(doc.paramExtras!.checks![0]!.expr).toBe("clearance >= 0.3 && count > 1");
    expect(doc.paramExtras!.configurations![0]!.values).toEqual({ count: "30", wall: "clearance + 0.3" });
  });

  it("a check or a configuration value that READS a parameter blocks its delete; one that only sets it does not", () => {
    const doc = fixture(
      { rings: user("22"), gap: user("0.5") },
      {
        checks: [{ id: "k1", expr: "gap >= 0.3", message: "gap too small", level: "warning" }],
        configurations: [{ id: "c1", name: "Dense", values: { rings: "30" } }],
      },
    );
    expect(deleteBlockers(doc, "gap")).toMatch(/check "gap too small"/);
    expect(deleteBlockers(doc, "rings")).toBeNull();
    commitDeleteParam(doc, "rings");
    expect(doc.paramExtras!.configurations![0]!.values).toEqual({});
  });

  it("checks hold, fail, and fail loudly when they cannot be evaluated", () => {
    const doc = fixture(
      { gap: user("0.2") },
      {
        checks: [
          { id: "a", expr: "gap >= 0.3", message: "gap too small", level: "warning" },
          { id: "b", expr: "gap > 0", message: "gap must exist", level: "error" },
          { id: "c", expr: "missing > 0", message: "stale", level: "error" },
        ],
      },
    );
    const r = checkResults(doc);
    expect(r.map((x) => x.ok)).toEqual([false, true, false]);
    expect(r[2]!.error).toMatch(/unknown parameter/);
  });

  it("clampToControl keeps a value in range, on its step, and on a listed choice", () => {
    expect(clampToControl({ kind: "slider", min: 0, max: 22, step: 1 }, 30)).toBe(22);
    expect(clampToControl({ kind: "slider", min: 0, max: 22, step: 1 }, 2.6)).toBe(3);
    expect(clampToControl({ kind: "number", min: 0.3, step: 0.1 }, 0.44)).toBe(0.4);
    expect(clampToControl({ kind: "number", min: 0.3 }, 0.1)).toBe(0.3);
    expect(clampToControl({ kind: "toggle" }, 5)).toBe(1);
    expect(clampToControl({ kind: "choice", choices: [{ label: "S", value: 10 }, { label: "L", value: 30 }] }, 22)).toBe(30);
    expect(clampToControl(undefined, 7)).toBe(7);
    expect(controlProblem({ ...user("30"), value: 30, control: { kind: "slider", min: 0, max: 22 } })).toMatch(/maximum of 22/);
    expect(controlProblem({ ...user("3"), value: 3, control: { kind: "slider", min: 0, max: 22, step: 1 } })).toBeNull();
  });

  it("capture takes user parameters only, and a trial applies values in order or not at all", () => {
    const doc = fixture({
      rings: user("22"),
      wall: user("0.8"),
      d1: { expr: "4", value: 4, unit: "mm", target: { kind: "feature", feature: "f1", field: "distance" } },
    });
    const cfg = captureConfiguration(doc, "c1", "Classic");
    expect(cfg.values).toEqual({ rings: "22", wall: "0.8" });

    const ok = trialConfiguration(doc, { id: "c2", name: "Dense", values: { rings: "30", wall: "rings / 30" } });
    expect(ok.ok && defsOf(ok.doc)["wall"]!.value).toBe(1);
    expect(defsOf(doc)["rings"]!.expr).toBe("22"); // the trial never touched the original

    const bad = trialConfiguration(doc, { id: "c3", name: "Broken", values: { rings: "30", wall: "nope" } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/Broken: wall = nope: unknown parameter/);
    expect(configurationDrift(doc, { id: "c", name: "x", values: { rings: "22", wall: "1" } })).toEqual(["wall"]);
  });
});

describe("store: configurations and extras", () => {
  afterEach(() => void vi.useRealTimers());

  const backend = {
    async rebuild() { return { ok: false, error: { message: "stub" } }; },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;

  it("applies a configuration as one undoable step, refuses a broken one, and saves the extras", async () => {
    vi.useFakeTimers();
    const store = new DocumentStore(backend, fixture({ rings: user("22"), solid: user("0") }));
    store.updateParamExtras((x) => {
      x.groups = [{ id: "g1", name: "Core" }];
      x.configurations = [
        { id: "c1", name: "Solid", values: { solid: "1", rings: "20" } },
        { id: "c2", name: "Broken", values: { rings: "nope" } },
      ];
    });
    store.setParamMeta("solid", { control: { kind: "toggle" }, group: "g1" });

    expect(store.applyConfiguration("c2")).toMatch(/unknown parameter/);
    expect(store.applyConfiguration("c1")).toBeNull();
    await vi.runAllTimersAsync();
    const defs = store.document.paramDefs!;
    expect([defs["solid"]!.value, defs["rings"]!.value]).toEqual([1, 20]);
    expect(store.document.paramExtras!.activeConfiguration).toBe("c1");

    const saved = JSON.parse(store.toJSON()) as CadDocument;
    expect(saved.paramDefs!["solid"]!.control).toEqual({ kind: "toggle" });
    expect(saved.paramExtras!.configurations!.map((c) => c.id)).toEqual(["c1", "c2"]);

    store.undo();
    await vi.runAllTimersAsync();
    expect(store.document.paramDefs!["solid"]!.value).toBe(0);

    // deleting the group ungroups its parameter rather than leaving a dangling id
    store.updateParamExtras((x) => void (x.groups = []));
    expect(store.document.paramDefs!["solid"]!.group).toBeUndefined();

    const reloaded = new DocumentStore(backend, { parameters: {}, features: [] });
    reloaded.load(JSON.stringify(saved));
    expect(reloaded.document.paramExtras?.groups).toEqual([{ id: "g1", name: "Core" }]);
  });
});
