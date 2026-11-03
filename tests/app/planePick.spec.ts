// The plane row actions both tabs share, on a fake engine and the real treePick session.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_PLANES,
  routePlaneRow,
  sketchOnPlane,
  treeClickDeps,
  type PlanePick,
  type PlaneRowHost,
} from "../../src/app/planePick";
import { awaitTreePick, resetTreePicks, treePickRefusal } from "../../src/ui/treePick";

const SLANTED = {
  origin: [113.5, -41.25, 37] as [number, number, number],
  normal: [0.6, 0, 0.8] as [number, number, number],
  xdir: [0.8, 0, -0.6] as [number, number, number],
};
const DATUM: PlanePick = { kind: "datumPlane", id: "f7", def: SLANTED };
const XZ: PlanePick = { kind: "basePlane", plane: "XZ" };

function host(o: { sketch?: boolean; owned?: boolean } = {}) {
  const store = {} as PlaneRowHost["store"];
  const enter = vi.fn();
  const setStatus = vi.fn();
  const e = {
    store,
    toolOwnsScreen: () => o.owned ?? false,
    setStatus,
    sketch: { active: o.sketch ?? false, enter },
  } as unknown as PlaneRowHost;
  return { e, store, enter, setStatus };
}

afterEach(resetTreePicks);

describe("the base planes", () => {
  it("are the three origin planes in the order Items draws them", () => {
    expect(BASE_PLANES).toEqual(["XY", "XZ", "YZ"]);
  });
});

describe("sketchOnPlane", () => {
  it("starts a sketch on an origin plane by its name", () => {
    const { e, store, enter, setStatus } = host();
    sketchOnPlane(e, XZ);
    expect(enter.mock.calls).toEqual([["XZ", store]]);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("starts a sketch on a datum where it stands, linked to the datum", () => {
    const { e, store, enter } = host();
    sketchOnPlane(e, DATUM);
    expect(enter.mock.calls).toEqual([[SLANTED, store, undefined, "f7"]]);
  });

  it.each([XZ, DATUM])("refuses in words while a sketch is open", (pick) => {
    const { e, enter, setStatus } = host({ sketch: true });
    sketchOnPlane(e, pick);
    expect(enter).not.toHaveBeenCalled();
    expect(setStatus.mock.calls[0]![0]).toContain("Finish this sketch");
  });
});

describe("routePlaneRow", () => {
  it("leaves the row to itself when nothing waits and no tool holds the screen", () => {
    const { e, setStatus } = host();
    expect(routePlaneRow(e, XZ)).toBe("row");
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("hands the row to a waiting pick, whole, with the datum's place", () => {
    const { e, enter } = host({ owned: true });
    const got: unknown[] = [];
    awaitTreePick(
      (p) => {
        got.push(p);
        return true;
      },
      () => {},
    );
    expect(routePlaneRow(e, DATUM)).toBe("taken");
    expect(got).toEqual([DATUM]);
    expect(enter).not.toHaveBeenCalled();
  });

  it("says why a waiting pick refused the row", () => {
    const { e, setStatus } = host();
    awaitTreePick(
      (p) => treePickRefusal(p, "one body"),
      () => {},
    );
    expect(routePlaneRow(e, XZ)).toBe("refused");
    expect(setStatus.mock.calls[0]![0]).toContain("a base plane");
  });

  it("refuses when a tool holds the screen and takes no rows", () => {
    const { e, setStatus } = host({ owned: true });
    expect(routePlaneRow(e, XZ)).toBe("refused");
    expect(setStatus.mock.calls[0]![0]).toContain("active tool");
  });

  it("lets a row through inside a sketch, whose own action then refuses", () => {
    const { e, setStatus } = host({ owned: true, sketch: true });
    expect(routePlaneRow(e, XZ)).toBe("row");
    expect(treeClickDeps(e).busyHint()).toBeNull();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
