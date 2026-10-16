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
import { setEmissionProgress } from "../../../src/ui/emissionProgress";

vi.mock("../../../src/viewport/materialPreview", () => ({
  materialPreview: () => null,
  onPreviewsChanged: () => () => {},
}));

const LIBRARY: MaterialDef[] = [
  { id: "m-brass", name: "Brass", color: "#b5a642", metalness: 1, roughness: 0.3 },
  { id: "m-gold", name: "Gold", color: "#d4af37", metalness: 1, roughness: 0.3 },
  { id: "m-steel", name: "Steel", color: "#888888", metalness: 1, roughness: 0.4 },
  { id: "m-glass", name: "Glass", color: "#cfe4ee", metalness: 0, roughness: 0.05, opacity: 0.25 },
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

describe("RenderMaterials glass controls", () => {
  it("shows them for a see-through material only, and the IOR chips write the index", async () => {
    await tile("m-brass").trigger("click");
    await poll();
    expect(w.find("[data-glass]").exists()).toBe(false);
    await tile("m-glass").trigger("click");
    await poll();
    expect(w.find("[data-glass]").exists()).toBe(true);
    await w.get('[data-ior="1.33"]').trigger("click");
    expect(fake.store.updateMaterial).toHaveBeenLastCalledWith("m-glass", { ior: 1.33 });
    await w.get('[data-ior="2.42"]').trigger("click");
    expect(fake.store.updateMaterial).toHaveBeenLastCalledWith("m-glass", { ior: 2.42 });
  });

  it("names the see-through amount Transmission and writes it back as opacity", async () => {
    await tile("m-glass").trigger("click");
    await poll();
    const slider = w.get('[data-field="transmission"]');
    expect(slider.element.closest("label")?.textContent).toContain("Transmission");
    expect((slider.element as HTMLInputElement).value).toBe("0.75");
    (slider.element as HTMLInputElement).value = "0.9";
    await slider.trigger("input");
    expect(fake.store.updateMaterial).toHaveBeenLastCalledWith("m-glass", { opacity: 0.1 });
  });

  it("brings a tint depth along with the first tint colour, since a tint without one does nothing", async () => {
    await tile("m-glass").trigger("click");
    await poll();
    const tint = w.get('[data-field="attenuationColor"]');
    (tint.element as HTMLInputElement).value = "#2a8f6a";
    await tint.trigger("input");
    expect(fake.store.updateMaterial).toHaveBeenLastCalledWith("m-glass", {
      attenuationColor: "#2a8f6a", attenuationDistance: 20,
    });
  });
});

describe("RenderMaterials Emission control", () => {
  it("is named Emission and warns that it is a heavy effect", async () => {
    await tile("m-glass").trigger("click");
    await poll();
    const label = w.get('[data-field="emissive"]').element.closest("label")!;
    expect(label.textContent).toContain("Emission");
    expect(label.textContent).not.toContain("Glow");
    const warn = w.get('[data-heavy="emissive"]');
    expect(warn.find('[data-icon="warning"]').exists()).toBe(true);
    expect(warn.attributes("title")).toMatch(/heavy/i);
  });

  it("lands a drag as one edit per frame, with the last value", async () => {
    await tile("m-glass").trigger("click");
    await poll();
    fake.store.updateMaterial.mockClear();
    const slider = w.get('[data-field="emissive"]');
    for (const v of ["0.1", "0.2", "0.35"]) {
      (slider.element as HTMLInputElement).value = v;
      await slider.trigger("input");
    }
    expect(fake.store.updateMaterial).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(fake.store.updateMaterial).toHaveBeenCalledTimes(1);
    expect(fake.store.updateMaterial).toHaveBeenLastCalledWith("m-glass", { emissive: 0.35 });
    (slider.element as HTMLInputElement).value = "0.5";
    await slider.trigger("input");
    await slider.trigger("change");
    expect(fake.store.updateMaterial).toHaveBeenLastCalledWith("m-glass", { emissive: 0.5 });
  });

  it("shows how far the lights have filled in while the viewport is still at it", async () => {
    await tile("m-glass").trigger("click");
    await poll();
    expect(w.find(".rd-emitting").exists()).toBe(false);
    setEmissionProgress(0.4);
    await nextTick();
    expect(w.get(".rd-emitting").attributes("aria-valuenow")).toBe("40");
    setEmissionProgress(null);
    await nextTick();
    expect(w.find(".rd-emitting").exists()).toBe(false);
  });
});
