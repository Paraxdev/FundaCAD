// One speaker whichever route selected: the real readout, composable, list controller and Viewport selection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { Highlighter } from "../../../src/viewport/highlight";
import { Picker, type Hit } from "../../../src/viewport/picking";
import type { ModelView } from "../../../src/viewport/render";
import { Viewport } from "../../../src/viewport/viewport";
import { land, result, rig, topology } from "../../app/geometryBrowserRig";
import { bodyMesh } from "../../viewport/pickRig";

const host = vi.hoisted(() => ({ engine: null as unknown }));
vi.mock("../../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {} }));
vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));
vi.mock("../../../src/app/engineKey", () => ({ useEngine: () => host.engine }));

import SelectionReadout from "../../../src/components/shell/SelectionReadout.vue";
import { announce } from "../../../src/ui/announce";

enableAutoUnmount(afterEach);

let frames: FrameRequestCallback[] = [];
const frame = async () => {
  await nextTick();
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
  await nextTick();
};

beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.mocked(announce).mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function voice() {
  const r = rig(result([{ id: "body1", etag: "e1", faceCount: 6 }]));
  const mesh = bodyMesh("body1", 0, [
    {
      id: "e1",
      points: [
        [32.5, -17.5, 18.5],
        [49.5, -17.5, 18.5],
      ],
    },
  ]);
  const model = { bodies: [mesh], edges: [] } as unknown as ModelView;
  const vp = Object.create(Viewport.prototype) as Viewport;
  Object.assign(vp, {
    highlighter: new Highlighter(model),
    model,
    picker: new Picker(),
    faceBands: new Map(),
    selectPolicy: "auto",
    selectionMode: "faces",
    edgeScope: { scope: "single", reason: "tangent" },
    edgeClick: null,
    faceClick: null,
    suspendPicking: false,
    streaming: false,
    outOfDate: false,
    requestRender: () => {},
    onSelectionChange: () => r.browser.selectionChanged(),
    onBodySelectionChange: () => {},
  });
  Object.assign(r.viewport, {
    applyPicks: vp.applyPicks.bind(vp),
    getSelectedFaceIds: vp.getSelectedFaceIds.bind(vp),
    getSelectedBodies: vp.getSelectedBodies.bind(vp),
    selectedEdgeLines: vp.selectedEdgeLines.bind(vp),
    selectionBodyIds: vp.selectionBodyIds.bind(vp),
    selectedFacesForPressPull: () => null,
    planarFace: () => null,
  });
  host.engine = {
    ...r.host,
    geometryBrowser: r.browser,
    overlay: { selectedRegions: () => [] },
  };
  await r.build();
  const click = (faceId: number, additive: boolean) =>
    vp.applyPick({ kind: "face", faceId, selector: {}, point: [41, -13, 7] } as unknown as Hit, {
      additive,
      exact: false,
    });
  const row = (i: number) => r.list.rows.find((x) => x.key === `f:body1:${i}`)!;
  const wrapper = mount(SelectionReadout);
  await frame();
  return { ...r, click, row, wrapper };
}
const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);

describe("one voice for a selection", () => {
  it("says the same from a list row and a Ctrl-click, with no pointer or key release", async () => {
    const listed = await voice();
    listed.browser.show(true);
    await land(listed.asks[0]!, topology("body1", 6));
    expect(listed.browser.pickRows([listed.row(1)], { additive: false })).toBeNull();
    await frame();
    expect(listed.browser.pickRows([listed.row(3)], { additive: true })).toBeNull();
    await frame();
    const fromList = said();
    listed.wrapper.unmount();

    vi.mocked(announce).mockClear();
    setActivePinia(createPinia());
    const clicked = await voice();
    clicked.browser.show(true);
    await land(clicked.asks[0]!, topology("body1", 6));
    clicked.click(1, false);
    await frame();
    clicked.click(3, true);
    await frame();
    expect(said()).toEqual(fromList);
    expect(fromList[1]).toBe("Flat face 4 added, 2 selected");
    expect(fromList).toHaveLength(2);
  });

  it("names the body the way Items does, a rename included", async () => {
    const v = await voice();
    v.browser.show(true);
    await land(v.asks[0]!, topology("body1", 6));
    expect(v.browser.pickRows([v.row(2)], { additive: false })).toBeNull();
    await frame();
    expect(said().at(-1)).toMatch(/, BODY1(,|$)/);
    v.store.setBodyName("body1", "Lid");
    await frame();
    expect(v.browser.pickRows([v.row(4)], { additive: false })).toBeNull();
    await frame();
    expect(said().at(-1)).toMatch(/^Flat face 5, .*, Lid(,|$)/);
    expect(said().at(-1)).not.toContain("BODY1");
  });

  it("says a plain Face 4 from a Ctrl-click with the list closed, and asks the engine nothing for it", async () => {
    const v = await voice();
    v.click(1, false);
    await frame();
    expect(v.asks.map((a) => a.opts)).toEqual([{ faces: [1] }]);
    v.click(3, true);
    await frame();
    expect(said().at(-1)).toBe("Face 4 added, 2 selected");
    expect(v.asks).toHaveLength(1);
    v.click(1, true);
    await frame();
    expect(said().at(-1)).toBe("Face 2 removed, 1 selected");
  });

  it("speaks once per settled change, however many frames pass", async () => {
    const v = await voice();
    v.click(4, false);
    await frame();
    await frame();
    await frame();
    expect(said()).toHaveLength(1);
    expect(v.wrapper.get("[data-testid=selection-readout]").text()).toBe("1 face · curved");
  });

  it("is silent while a tool owns the screen, whichever route picks", async () => {
    const v = await voice();
    v.browser.show(true);
    await land(v.asks[0]!, topology("body1", 6));
    const engine = host.engine as { toolOwnsScreen: () => boolean };
    engine.toolOwnsScreen = () => true;
    v.click(2, false);
    await frame();
    v.click(3, true);
    await frame();
    expect(said()).toEqual([]);
    expect(v.wrapper.find("[data-testid=selection-readout]").exists()).toBe(false);
  });
});
