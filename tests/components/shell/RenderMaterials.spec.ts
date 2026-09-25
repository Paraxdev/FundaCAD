// FI-6: the "Applied" badge says what the selection wears in the document, and
// nothing else. A single click only picks a tile to edit and look at, so it must
// move the dashed "picked" outline and never the badge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RenderMaterials from "../../../src/components/shell/RenderMaterials.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { useBrowserStore } from "../../../src/stores/browser";
import type { MaterialDef } from "../../../src/document/materials";
import type { Engine } from "../../../src/app/engine";

vi.mock("../../../src/viewport/materialPreview", () => ({
  materialPreview: () => null,
  onPreviewsChanged: () => () => {},
}));

const LIBRARY: MaterialDef[] = [
  { id: "m-brass", name: "Brass", color: "#b5a642", metalness: 1, roughness: 0.3 },
  { id: "m-gold", name: "Gold", color: "#d4af37", metalness: 1, roughness: 0.3 },
  { id: "m-steel", name: "Steel", color: "#888888", metalness: 1, roughness: 0.4 },
];

function makeEngine() {
  const buildVersion = ref(0);
  const bodyMaterial = new Map<string, string>([["body1", "m-brass"]]);
  const faceMaterial = new Map<string, string>();
  let selectedFaces: string[] = [];
  const store = {
    get materialLibrary() { return LIBRARY; },
    bodyMaterialId: (id: string) => bodyMaterial.get(id),
    faceMaterialId: (body: string, face: number) => faceMaterial.get(`${body}#${face}`),
    faceMaterialEntries: () => [...faceMaterial],
    setFacesMaterial(faces: { body: string; face: number }[], m: string | null) {
      for (const f of faces) {
        if (m === null) faceMaterial.delete(`${f.body}#${f.face}`);
        else faceMaterial.set(`${f.body}#${f.face}`, m);
      }
      buildVersion.value++;
    },
    setBodiesMaterial(ids: string[], m: string | null) {
      for (const id of ids) {
        if (m === null) bodyMaterial.delete(id);
        else bodyMaterial.set(id, m);
      }
      buildVersion.value++;
    },
    updateMaterial: vi.fn(),
    buildState: { building: false, result: { bodies: [{ id: "body1", name: "Body1" }] } },
  };
  return {
    store,
    bodyMaterial,
    faceMaterial,
    selectFace(ids: string[]) { selectedFaces = ids; },
    engine: {
      store,
      bridge: { buildVersion },
      viewport: {
        getSelectedFaceIds: () => [...selectedFaces],
        localFaceBand: (fid: string) => ({ bodyId: "body1", faces: [Number(fid.split("#")[1])] }),
      },
    } as unknown as Engine,
  };
}

let fake: ReturnType<typeof makeEngine>;
let w: VueWrapper;

function tile(id: string) {
  return w.get(`.rd-tile[data-material="${id}"]`);
}
function badged() {
  return w.findAll(".rd-tile").filter((t) => t.find(".rd-worn").exists()).map((t) => t.attributes("data-material"));
}
async function poll() {
  vi.advanceTimersByTime(300);
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  fake = makeEngine();
  w = mount(RenderMaterials, { global: { provide: { [ENGINE as symbol]: fake.engine } } });
});

afterEach(() => {
  w.unmount();
  vi.useRealTimers();
});

describe("RenderMaterials Applied badge", () => {
  it("marks the material a picked face inherits from its body", async () => {
    fake.selectFace(["body1#2"]);
    await poll();
    expect(badged()).toEqual(["m-brass"]);
    expect(tile("m-brass").classes()).toContain("is-worn");
  });

  it("a single click picks a tile without applying it or moving the badge", async () => {
    fake.selectFace(["body1#2"]);
    await poll();
    await tile("m-gold").trigger("click");
    await poll();
    expect(tile("m-gold").classes()).toContain("is-selected");
    expect(tile("m-gold").classes()).not.toContain("is-worn");
    expect(tile("m-gold").find(".rd-worn").exists()).toBe(false);
    expect(badged()).toEqual(["m-brass"]);
    expect(fake.faceMaterial.size).toBe(0);
    expect(fake.bodyMaterial.get("body1")).toBe("m-brass");
  });

  it("the badge follows a real application, not a pick", async () => {
    fake.selectFace(["body1#2"]);
    await poll();
    await tile("m-gold").trigger("dblclick");
    await poll();
    expect(fake.faceMaterial.get("body1#2")).toBe("m-gold");
    expect(badged()).toEqual(["m-gold"]);
  });

  it("with a body selected, a pick leaves the badge on what the body wears", async () => {
    useBrowserStore().setSelectedBodies(["body1"]);
    await poll();
    await tile("m-steel").trigger("click");
    await poll();
    expect(badged()).toEqual(["m-brass"]);
    expect(tile("m-steel").classes()).toEqual(expect.arrayContaining(["is-selected"]));
  });

  it("nothing selected shows no badge at all, whatever is picked", async () => {
    await tile("m-gold").trigger("click");
    await poll();
    expect(badged()).toEqual([]);
  });
});
