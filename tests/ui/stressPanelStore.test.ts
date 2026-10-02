import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { usePanelsStore } from "../../src/stores/panels";
import type { StressFaceSet } from "../../src/ui/stress";

// The Stress panel's state: the setup survives reopening, a body change drops
// the faces of the old body, supports and loads are numbered and removed by id,
// and a Run moves through started, sent, finished.

beforeEach(() => setActivePinia(createPinia()));

const someFaces: StressFaceSet = {
  selectors: [{ kind: "face", by: "nearest", point: [0, 0, 0], body: "b1" }],
  faceIds: [7],
  normalSum: [0, 0, 1],
  area: 1,
};

describe("stress panel store", () => {
  it("opens with a fresh setup seeded with the body, one fixed support and one load", () => {
    const p = usePanelsStore();
    expect(p.stress).toBeNull();
    p.showStress("b1");
    expect(p.stress?.setup.body).toBe("b1");
    expect(p.stress?.setup.loads.map((l) => l.id)).toEqual([1]);
    expect(p.stress?.setup.supports.map((x) => [x.id, x.type])).toEqual([[1, "fixed"]]);
    expect(p.stress?.setup.gravity).toEqual({ on: false, direction: "-Z" });
    expect(p.stress?.setup.material).toBe("PLA");
    expect(p.stress?.setup.size).toBeNull();
    expect(p.stress?.running).toBe(false);
  });

  it("keeps the setup when opened again, filling only a missing body", () => {
    const p = usePanelsStore();
    p.showStress(null);
    p.setStressSupportFaces(1, someFaces);
    p.showStress("b2");
    expect(p.stress?.setup.body).toBe("b2");
    expect(p.stress?.setup.supports[0]?.faces.faceIds).toEqual([7]);
    p.showStress("b3");
    expect(p.stress?.setup.body).toBe("b2");
  });

  it("drops every face set when the body changes", () => {
    const p = usePanelsStore();
    p.showStress("b1");
    p.setStressSupportFaces(1, someFaces);
    p.setStressLoadFaces(1, someFaces);
    p.setStressBody("b1");
    expect(p.stress?.setup.supports[0]?.faces.faceIds).toEqual([7]);
    p.setStressBody("b2");
    expect(p.stress?.setup.supports[0]?.faces.faceIds).toEqual([]);
    expect(p.stress?.setup.loads[0]?.faces.faceIds).toEqual([]);
  });

  it("numbers new loads past the highest and removes by id", () => {
    const p = usePanelsStore();
    p.showStress("b1");
    p.addStressLoad();
    p.addStressLoad();
    p.removeStressLoad(2);
    p.addStressLoad();
    expect(p.stress?.setup.loads.map((l) => l.id)).toEqual([1, 3, 4]);
    p.setStressLoadFaces(3, someFaces);
    expect(p.stress?.setup.loads.map((l) => l.faces.faceIds.length)).toEqual([0, 1, 0]);
  });

  it("adds supports of a kind past the highest id and removes them by id", () => {
    const p = usePanelsStore();
    p.showStress("b1");
    p.addStressSupport("pinned");
    p.addStressSupport("slider");
    p.removeStressSupport(1);
    p.addStressSupport();
    expect(p.stress?.setup.supports.map((x) => [x.id, x.type])).toEqual([[2, "pinned"], [3, "slider"], [4, "fixed"]]);
    p.setStressSupportFaces(3, someFaces);
    expect(p.stress?.setup.supports.map((x) => x.faces.faceIds.length)).toEqual([0, 1, 0]);
  });

  it("puts a read-back setup in place and drops the result drawn from the old one", () => {
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressFinished({ result: { rows: [], warnings: [], legend: { min: 0, max: 1 }, yields: false } });
    p.setStressColours("shown");
    p.setStressDeform({ scale: 10, auto: 10, max: 40, animate: false });
    p.setStressProbe(true);
    p.addStressPin({ tri: 0, weights: [1, 0, 0], label: "3 MPa" });
    const setup = p.stress!.setup;
    p.replaceStressSetup({ ...setup, material: "ABS" });
    expect(p.stress?.setup.material).toBe("ABS");
    expect(p.stress?.result).toBeNull();
    expect(p.stress?.colours).toBe("none");
    expect(p.stress?.deform).toBeNull();
    expect(p.stress?.probe).toBe(false);
    expect(p.stress?.pins).toEqual([]);
  });

  it("numbers probes and removes them by id", () => {
    const p = usePanelsStore();
    p.showStress("b1");
    p.addStressPin({ tri: 0, weights: [1, 0, 0], label: "a" });
    p.addStressPin({ tri: 1, weights: [0, 1, 0], label: "b" });
    p.removeStressPin(1);
    p.addStressPin({ tri: 2, weights: [0, 0, 1], label: "c" });
    expect(p.stress?.pins.map((x) => [x.id, x.label])).toEqual([[2, "b"], [3, "c"]]);
  });

  it("tracks a Run from start to result, and a cancel leaves the last result", () => {
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressFinished({ error: "set the fixed faces" });
    expect(p.stress?.error).toBe("set the fixed faces");
    p.stressStarted();
    expect(p.stress?.running).toBe(true);
    expect(p.stress?.error).toBeNull();
    p.stressSent("req-1");
    expect(p.stress?.requestId).toBe("req-1");
    const result = { rows: [{ k: "Peak von Mises", v: "3 MPa" }], warnings: [], legend: { min: 0, max: 3 }, yields: false };
    p.stressFinished({ result });
    expect(p.stress?.running).toBe(false);
    expect(p.stress?.requestId).toBeNull();
    expect(p.stress?.result?.rows[0]?.v).toBe("3 MPa");
    p.stressStarted();
    p.stressFinished({});
    expect(p.stress?.result?.rows[0]?.v).toBe("3 MPa");
    expect(p.stress?.error).toBeNull();
  });

  it("ignores an id that arrives after the Run settled", () => {
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressSent("late");
    expect(p.stress?.requestId).toBeNull();
  });
});
