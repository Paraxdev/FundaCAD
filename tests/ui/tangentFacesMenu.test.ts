// "Select tangent faces" on the face menu: offered once the engine names a
// tangent run for a round face, and selecting it lights every face of the run,
// the whole slot loop from one slot end.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createContextMenus, type ContextMenusDeps } from "../../src/ui/contextMenus";
import { useContextMenuStore } from "../../src/stores/contextMenu";
import type { FaceAxisReply } from "../../src/geometry/client";
import type { FaceHit } from "../../src/viewport/picking";
import type { Vec3 } from "../../src/types";

beforeEach(() => setActivePinia(createPinia()));

const END: Vec3 = [0, 9.125, 20];
const RUN: Vec3[] = [END, [0, 5.125, 20], [0, 7.125, 18], [0, 7.125, 22]];

function slotEndReply(run: Vec3[]): FaceAxisReply {
  return {
    reason: "the walls around the face do not all run along one axis",
    resize: {
      kind: "cylinder",
      size: 2,
      full: false,
      concave: true,
      axis: { origin: [0, 7.125, 20], dir: [1, 0, 0] },
      contact: 2,
      tangent: { faces: run.length - 1, lostWhen: "shrink", run, closed: true, followable: true },
    },
  };
}

function setup(reply: FaceAxisReply | null, pick: "planar" | "tangent" = "tangent") {
  const ids = new Map(RUN.map((p, i) => [p.join(), 10 + i]));
  const selected: number[] = [];
  const asked: unknown[] = [];
  let announced = 0;
  let status = "";
  const viewport = {
    facePlanePick: () => ({
      kind: pick,
      def: { origin: END, normal: [0, -1, 0], xdir: [1, 0, 0] },
      selector: { kind: "face", by: "nearest", point: END },
      at: END,
    }),
    faceIdToBodyId: () => "body1",
    faceIdNear: (p: Vec3) => ids.get(p.join()) ?? null,
    selectOnlyFace: (id: number) => { selected.length = 0; selected.push(id); announced++; },
    selectOnlyFaces: (list: number[]) => { selected.length = 0; selected.push(...list); announced++; },
  };
  const store = {
    document: { features: [] },
    faceAxis: async (face: unknown, body: string | null) => { asked.push({ face, body }); return reply; },
  };
  const deps = {
    store, viewport,
    toolBusy: () => false,
    dropBodyGizmo: () => {},
    setStatus: (text: string) => { status = text; },
    featureForFace: () => null,
    getLastAction: () => null,
  } as unknown as ContextMenusDeps;
  const menus = createContextMenus(deps);
  const hit: FaceHit = { kind: "face", faceId: 10, selector: { kind: "face", by: "nearest", point: END }, point: END };
  return { menus, hit, selected, asked, announced: () => announced, status: () => status };
}

const labels = () => useContextMenuStore().items.map((i) => i.label);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Select tangent faces", () => {
  it("joins the face menu beside Select coplanar faces once the engine names a tangent run", async () => {
    const s = setup(slotEndReply(RUN));
    s.menus.openFaceMenu(100, 100, s.hit);
    expect(labels()).not.toContain("Select tangent faces");
    await settle();
    const l = labels();
    expect(l.indexOf("Select tangent faces")).toBe(l.indexOf("Select coplanar faces") + 1);
    expect(s.asked).toEqual([{ face: { kind: "face", by: "nearest", point: END }, body: "body1" }]);
  });

  it("joins the open menu in place rather than opening it again", async () => {
    const s = setup(slotEndReply(RUN));
    s.menus.openFaceMenu(100, 100, s.hit);
    const menu = useContextMenuStore();
    const epoch = menu.epoch;
    const before = [...menu.items];
    await settle();
    expect(menu.open).toBe(true);
    expect(menu.epoch).toBe(epoch);
    expect(menu.items.filter((i) => i.label !== "Select tangent faces")).toEqual(before);
    expect(menu.items.length).toBe(before.length + 1);
  });

  it("selects the whole slot loop from one slot end, the clicked face first", async () => {
    const s = setup(slotEndReply(RUN));
    s.menus.openFaceMenu(100, 100, s.hit);
    await settle();
    useContextMenuStore().items.find((i) => i.label === "Select tangent faces")!.onClick!();
    expect(s.selected).toEqual([10, 11, 12, 13]);
    expect(s.announced()).toBe(1);
    expect(s.status()).toBe("Selected 4 tangent faces");
  });

  it("offers Sketch on this face on a round face, on its tangent plane", async () => {
    const s = setup(slotEndReply(RUN));
    s.menus.openFaceMenu(100, 100, s.hit);
    expect(useContextMenuStore().items.find((i) => i.label === "Sketch on this face")?.disabled).toBe(false);
  });

  it("is not offered for a round face with no tangent run", async () => {
    const s = setup(slotEndReply([END]));
    s.menus.openFaceMenu(100, 100, s.hit);
    await settle();
    expect(labels()).toContain("Select coplanar faces");
    expect(labels()).not.toContain("Select tangent faces");
  });

  it("is not offered when the engine has no resize for the face", async () => {
    const s = setup({ reason: "no axis" });
    s.menus.openFaceMenu(100, 100, s.hit);
    await settle();
    expect(labels()).not.toContain("Select tangent faces");
  });

  it("never asks the engine about a flat face", async () => {
    const s = setup(slotEndReply(RUN), "planar");
    s.menus.openFaceMenu(100, 100, s.hit);
    await settle();
    expect(s.asked).toEqual([]);
    expect(labels()).not.toContain("Select tangent faces");
  });

  it("leaves a menu opened since alone", async () => {
    const s = setup(slotEndReply(RUN));
    s.menus.openFaceMenu(100, 100, s.hit);
    s.menus.openEmptyMenu(200, 200);
    const before = labels();
    await settle();
    expect(labels()).toEqual(before);
  });
});
