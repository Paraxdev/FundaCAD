// The readout and its speech under another language, on the real readout, composable and Viewport selection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { Highlighter } from "../../../src/viewport/highlight";
import { Picker, type Hit } from "../../../src/viewport/picking";
import type { ModelView } from "../../../src/viewport/render";
import { Viewport } from "../../../src/viewport/viewport";
import { setLanguage } from "../../../src/i18n";
import { describeChange } from "../../../src/ui/describePick";
import { countLine } from "../../../src/ui/selectionTools";
import { result, rig } from "../../app/geometryBrowserRig";
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

// `twins` adds a second body, both named Box as two_boxes.json's are.
async function voice(twins = false) {
  const box = twins ? { name: "Box" } : {};
  const r = rig(
    result([
      { id: "body1", etag: "e1", faceCount: 6, ...box },
      ...(twins ? [{ id: "body2", etag: "e2", faceCount: 6, ...box }] : []),
    ]),
  );
  const mesh = bodyMesh("body1", 0, [
    {
      id: "e1",
      points: [
        [32.5, -17.5, 18.5],
        [49.5, -17.5, 18.5],
      ],
    },
  ]);
  const model = {
    bodies: [mesh, ...(twins ? [bodyMesh("body2", 6, [])] : [])],
    edges: [],
  } as unknown as ModelView;
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
const shown = (v: { wrapper: { get: (s: string) => { text: () => string } } }) =>
  v.wrapper.get("[data-testid=selection-readout]").text();

afterEach(() => setLanguage("en"));

describe("the selection readout and its speech in the chosen language", () => {
  it("speaks one face, then several, added and removed, in de", async () => {
    await setLanguage("de");
    const v = await voice();
    v.click(1, false);
    await frame();
    expect(said()).toHaveLength(1);
    v.click(3, true);
    await frame();
    expect(said().at(-1)).toBe("Fläche 4 hinzugefügt, 2 ausgewählt");
    v.click(5, true);
    await frame();
    expect(said().at(-1)).toBe("Fläche 6 hinzugefügt, 3 ausgewählt");
    v.click(3, true);
    await frame();
    expect(said().at(-1)).toBe("Fläche 4 entfernt, 2 ausgewählt");
  });

  it("speaks added and removed in ja", async () => {
    await setLanguage("ja");
    const v = await voice();
    v.click(2, false);
    await frame();
    v.click(4, true);
    await frame();
    expect(said().at(-1)).toBe("面 5を追加しました。2 個を選択中");
    v.click(4, true);
    await frame();
    expect(said().at(-1)).toBe("面 5を外しました。1 個を選択中");
  });

  it("shows a count the speech contains, under de, ja and en", async () => {
    for (const lang of ["de", "ja", "en"] as const) {
      await setLanguage(lang);
      vi.mocked(announce).mockClear();
      setActivePinia(createPinia());
      const v = await voice();
      v.click(1, false);
      await frame();
      v.click(2, true);
      v.click(4, true);
      await frame();
      const count = countLine("face", 3);
      expect(shown(v)).toContain(count);
      expect(said().at(-1)).toContain(count);
      v.wrapper.unmount();
    }
  });

  it("follows a language switch on screen without speaking again", async () => {
    await setLanguage("en");
    const v = await voice();
    v.click(1, false);
    await frame();
    v.click(3, true);
    await frame();
    expect(shown(v)).toContain("2 faces");
    const spoken = said().length;
    await setLanguage("ja");
    await frame();
    expect(shown(v)).toContain(countLine("face", 2));
    expect(shown(v)).not.toContain("faces");
    expect(said()).toHaveLength(spoken);
    await setLanguage("de");
    await frame();
    expect(shown(v)).toContain("2 Flächen");
  });

  it("names the body of one added on another body, in de", async () => {
    await setLanguage("de");
    const v = await voice(true);
    v.click(1, false);
    await frame();
    v.click(7, true);
    await frame();
    expect(said().at(-1)).toBe("Fläche 2 von Box 2 hinzugefügt, 2 ausgewählt");
  });
});

describe("a selection change by kind", () => {
  const words = (key: string) => ({ label: `L:${key}`, spoken: `S:${key}` });
  const keys = {
    faces: ["f:b:1", "f:b:2", "f:b:3"],
    mixed: ["f:b:1", "f:b:2", "e:b:7"],
    all: ["f:b:1", "e:b:7", "e:b:8", "p:o:XY", "p:o:XZ", "b:body1", "r:s1", "x:y"],
  };

  it("counts faces, edges, planes, bodies, profiles and others in de", async () => {
    await setLanguage("de");
    expect(describeChange([], keys.mixed, words)).toBe("2 Flächen, 1 Kante ausgewählt");
    expect(describeChange([], keys.all, words)).toBe(
      "1 Fläche, 2 Kanten, 2 Ebenen, 1 Körper, 1 Profil, 1 Element ausgewählt",
    );
    expect(describeChange([], keys.faces, words)).toBe("3 Flächen ausgewählt");
  });

  it("counts the same in ja, with one verb", async () => {
    await setLanguage("ja");
    const line = describeChange([], keys.mixed, words)!;
    expect(line).toBe(`${countLine("face", 2)}、${countLine("edge", 1)}を選択中`);
    expect(line.endsWith("を選択中")).toBe(true);
    expect(describeChange(keys.faces, keys.faces.slice(0, 2), words)).toBe(`L:f:b:3を外しました。2 個を選択中`);
  });

  it("names a body, an edge and Nothing selected in de", async () => {
    await setLanguage("de");
    const bodyOf = (k: string) => (k.startsWith("b:") ? null : "Platte");
    expect(describeChange(["f:b:1"], ["f:b:1", "e:b:7"], words, bodyOf)).toBe("L:e:b:7 hinzugefügt, 2 ausgewählt");
    expect(describeChange(["f:b:1", "f:c:2"], ["f:b:1"], words, (k) => (k === "f:c:2" ? "Platte" : "Rahmen"))).toBe(
      "L:f:c:2 von Platte entfernt, 1 ausgewählt",
    );
    expect(describeChange(["b:body1"], [], words)).toBe("Nichts ausgewählt");
    expect(describeChange(["b:body1"], ["b:body1"], words)).toBeNull();
  });

  it("reads one left after several as that one's own words", async () => {
    await setLanguage("de");
    expect(describeChange(keys.faces, ["f:b:1"], words)).toBe("S:f:b:1");
  });
});
