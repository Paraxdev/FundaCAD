// The 3D view's hidden summary kept current without frame work, the Describe model dialog's facts and Describe
// selection's speech, over a fake engine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import {
  describeSelectionAloud,
  installViewSummary,
  openDescribeModel,
  SUMMARY_DELAY,
  type DescribeHost,
} from "../../src/app/describeModel";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import { allCommands } from "../../src/ui/commands";
import { useDialogStore } from "../../src/stores/dialogs";
import { useSelectionStore } from "../../src/stores/selection";
import { viewSummaryText } from "../../src/ui/viewSummary";
import { announce } from "../../src/ui/announce";
import type { Engine } from "../../src/app/engine";

vi.mock(import("../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

const box = (min: number[], max: number[]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

function fake() {
  const builds = new Set<() => void>();
  const docs = new Set<() => void>();
  const sections = new Set<() => void>();
  const sel = { bodies: [] as string[], faces: [] as number[] };
  const look = { dir: new THREE.Vector3(0, 0, -1), flying: false, pose: 0 };
  const boxes: Record<string, THREE.Box3> = {
    body1: box([0, 0, 0], [40, 30, 20]),
    body2: box([0, 0, 30], [10, 10, 40]),
  };
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const e = {
    canvas,
    store: {
      document: {
        features: [
          { id: "s1", type: "sketch" },
          { id: "e1", type: "extrude" },
          { id: "e2", type: "extrude", name: "Boss" },
        ],
      },
      buildState: {
        result: {
          bodies: [
            { id: "body1", name: "Body", faceStart: 0, faceCount: 6 },
            { id: "body2", name: "Body", faceStart: 6, faceCount: 6, fault: "open shell" },
          ],
        },
        errorFeatureId: null,
        errorMessage: null,
      },
      rollbackIndex: 3,
      fileName: "plate.funda",
      isSuppressed: () => false,
      isBodyVisible: (id: string) => id !== "body2",
      bodyMaterialOf: () => undefined,
      bodyColorSlot: () => undefined,
      bodyName: (id: string) => (id === "body1" ? "Plate" : undefined),
      onBuild: (fn: () => void) => (builds.add(fn), () => builds.delete(fn)),
      onDocChange: (fn: () => void) => (docs.add(fn), () => docs.delete(fn)),
    },
    viewport: {
      getSelectedBodies: () => sel.bodies,
      getSelectedFaceIds: () => sel.faces,
      faceIdToBodyId: (id: number) => (id < 6 ? "body1" : "body2"),
      selectedEdgeLines: () => [],
      facesBox: () => box([0, 0, 20], [40, 30, 20]),
      bodyProperties: (ids: string[] | null) => {
        const id = ids?.[0];
        const b = id ? boxes[id] : undefined;
        return b ? { volume: 24000, area: 0, com: new THREE.Vector3(), bbox: b, ids: [id], names: [] } : null;
      },
      viewDirection: vi.fn(() => look.dir.clone()),
      rig: { isOrtho: () => true, isFlying: () => look.flying, poseVersion: () => look.pose },
    },
    tools: { section: { phase: "off", onChange: (fn: () => void) => (sections.add(fn), () => sections.delete(fn)) } },
  };
  const fire = (set: Set<() => void>) => set.forEach((fn) => fn());
  return { e: e as unknown as DescribeHost, raw: e, sel, look, builds, docs, sections, fire };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  viewSummaryText.value = "";
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("installViewSummary", () => {
  it("writes the summary once at install", () => {
    const f = fake();
    const off = installViewSummary(f.e);
    expect(viewSummaryText.value).toBe(
      "2 bodies (1 hidden), 3 features. Top view, orthographic. Section off. Nothing selected.",
    );
    off();
  });

  it("follows a build, a selection, a view and a section change after a pause, once for a burst", () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const f = fake();
    const off = installViewSummary(f.e);
    f.raw.viewport.viewDirection.mockClear();
    f.sel.bodies = ["body1"];
    f.look.dir.set(0, 1, 0);
    f.raw.tools.section.phase = "on";
    for (let i = 0; i < 20; i++) f.fire(f.builds);
    f.fire(f.docs);
    f.fire(f.sections);
    window.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("keyup"));
    window.dispatchEvent(new Event("wheel"));
    expect(viewSummaryText.value).toContain("Nothing selected");
    vi.advanceTimersByTime(SUMMARY_DELAY - 1);
    expect(viewSummaryText.value).toContain("Nothing selected");
    vi.advanceTimersByTime(1);
    expect(viewSummaryText.value).toBe(
      "2 bodies (1 hidden), 3 features. Front view, orthographic. Section on. Selected: Plate.",
    );
    expect(f.raw.viewport.viewDirection).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
    off();
  });

  it("follows a row picked in a list, which sends no pointer or key event", async () => {
    vi.useFakeTimers();
    const f = fake();
    const off = installViewSummary(f.e);
    f.sel.faces = [2];
    useSelectionStore().rows = { keys: ["f:body1:2"], anchor: null } as never;
    await Promise.resolve();
    vi.advanceTimersByTime(SUMMARY_DELAY);
    expect(viewSummaryText.value).toContain("Selected: 1 face.");
    off();
  });

  it("waits for a view flight to land before naming the view", () => {
    vi.useFakeTimers();
    const f = fake();
    const off = installViewSummary(f.e);
    f.look.flying = true;
    f.look.dir.set(-1, 0, 0);
    window.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(SUMMARY_DELAY * 3);
    expect(viewSummaryText.value).toContain("Top view");
    f.look.flying = false;
    vi.advanceTimersByTime(SUMMARY_DELAY);
    expect(viewSummaryText.value).toContain("Right view");
    off();
  });

  it("waits out a turn the rig does not call a flight, as the classic rig's own transition to a view", () => {
    vi.useFakeTimers();
    const f = fake();
    const off = installViewSummary(f.e);
    window.dispatchEvent(new Event("keyup"));
    f.look.dir.set(-1, 0, -1).normalize();
    for (let i = 0; i < 3; i++) {
      f.look.pose++;
      vi.advanceTimersByTime(SUMMARY_DELAY);
    }
    expect(viewSummaryText.value).toContain("Top view");
    f.look.dir.set(-1, 0, 0);
    f.look.pose++;
    vi.advanceTimersByTime(SUMMARY_DELAY);
    expect(viewSummaryText.value).toContain("Top view");
    vi.advanceTimersByTime(SUMMARY_DELAY);
    expect(viewSummaryText.value).toContain("Right view");
    off();
  });

  it("is current the moment the view takes focus, since that is when it is read", () => {
    vi.useFakeTimers();
    const f = fake();
    const off = installViewSummary(f.e);
    f.sel.bodies = ["body1", "body2"];
    f.raw.canvas.dispatchEvent(new FocusEvent("focus"));
    expect(viewSummaryText.value).toContain("Selected: 2 bodies.");
    off();
  });

  it("stops listening once removed", () => {
    vi.useFakeTimers();
    const f = fake();
    installViewSummary(f.e)();
    f.sel.bodies = ["body1"];
    window.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(SUMMARY_DELAY * 2);
    expect(viewSummaryText.value).toContain("Nothing selected");
    expect(f.builds.size + f.docs.size + f.sections.size).toBe(0);
  });
});

describe("openDescribeModel", () => {
  it("opens the dialog on every body with its size and center, and the numbered features", () => {
    const f = fake();
    openDescribeModel(f.e);
    const d = useDialogStore().describeModel!;
    const section = (h: string) => d.sections.find((s) => s.heading === h)!.items;
    expect(section("Bodies")).toEqual([
      "Plate: 40 × 30 × 20 mm, center at 20, 15, 10 mm, volume 24000 mm³",
      "Body: 10 × 10 × 10 mm, center at 5, 5, 35 mm, hidden, fault: open shell",
    ]);
    expect(section("Features")).toEqual(["Sketch 1", "Extrude 1", "Boss"]);
    expect(section("Overview")[0]).toBe("File: plate.funda");
  });
});

describe("describeSelectionAloud", () => {
  it("says the selected body with its size and center", () => {
    const f = fake();
    f.sel.bodies = ["body1"];
    describeSelectionAloud(f.e);
    expect(vi.mocked(announce)).toHaveBeenCalledWith(
      "Plate, 40 by 30 by 20 millimetres, center at 20, 15, 10 millimetres",
      "polite",
      { key: "describe-selection" },
    );
  });

  it("says the faces and the body they are on", () => {
    const f = fake();
    f.sel.faces = [1, 2];
    describeSelectionAloud(f.e);
    expect(vi.mocked(announce).mock.calls[0]![0]).toBe(
      "2 faces on Plate, 40 by 30 by 0 millimetres, center at 20, 15, 20 millimetres",
    );
  });

  it("says when nothing is selected", () => {
    describeSelectionAloud(fake().e);
    expect(vi.mocked(announce).mock.calls[0]![0]).toBe("Nothing selected");
  });
});

describe("the Describe commands", () => {
  it("are in the palette and the View menu's group, with no key until one is chosen", () => {
    const listed = allCommands().filter((c) => c.id.startsWith("describe-"));
    expect(listed.map((c) => [c.id, c.label, c.group, c.key])).toEqual([
      ["describe-model", "Describe Model…", "View", undefined],
      ["describe-selection", "Describe Selection", "View", undefined],
    ]);
    expect(listed.every((c) => NON_REPEATABLE.has(c.id))).toBe(true);
  });

  it("run from the dispatcher and leave an open sketch open", () => {
    const f = fake();
    const finish = vi.fn();
    const engine = { ...f.raw, sketch: { active: true, finish }, toolBusy: () => false, lastAction: null };
    const run = createActions(engine as unknown as Engine);
    run("describe-model");
    expect(useDialogStore().describeModel?.title).toBe("Model description");
    run("describe-selection");
    expect(vi.mocked(announce).mock.calls[0]![0]).toBe("Nothing selected");
    expect(finish).not.toHaveBeenCalled();
  });
});
