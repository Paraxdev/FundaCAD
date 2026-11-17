// The plane row actions both tabs share, on a fake engine and the real treePick session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  BASE_PLANES,
  SELECTION_SPEECH_DELAY,
  routePlaneRow,
  sketchOnPlane,
  treeClickDeps,
  type PlanePick,
  type PlaneRowHost,
} from "../../src/app/planePick";
import { awaitTreePick, resetTreePicks, routeTreeClick, treePickRefusal } from "../../src/ui/treePick";
import { useToastStore } from "../../src/stores/toasts";
import { hintToast, toast } from "../../src/ui/toast";

const said = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../src/ui/announce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/announce")>()),
  announce: (...args: unknown[]) => void said.push(args),
}));

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

beforeEach(() => setActivePinia(createPinia()));
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
      (p) => treePickRefusal(p, "oneBody"),
      () => {},
    );
    expect(routePlaneRow(e, XZ)).toBe("refused");
    expect(setStatus.mock.calls[0]![0]).toContain("a base plane");
  });

  it("refuses when a tool holds the screen and takes no rows", () => {
    const { e, setStatus } = host({ owned: true });
    expect(routePlaneRow(e, XZ)).toBe("refused");
    const hint = setStatus.mock.calls[0]![0] as string;
    expect([hint.includes("active tool"), hint.includes("Esc"), /in the view/.test(hint)]).toEqual([true, true, false]);
  });

  it("lets a row through inside a sketch, whose own action then refuses", () => {
    const { e, setStatus } = host({ owned: true, sketch: true });
    expect(routePlaneRow(e, XZ)).toBe("row");
    expect(treeClickDeps(e).busyHint()).toBeNull();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("a refusal toast and the row taken after it", () => {
  const showing = () =>
    useToastStore()
      .items.filter((t) => !t.leaving)
      .map((t) => t.message);
  const toasting = () => {
    const h = host();
    h.setStatus.mockImplementation((text: string, _cls: string, opts?: { silent?: boolean }) => hintToast(text, opts));
    return h;
  };
  const wantsFace = () =>
    awaitTreePick(
      (p) => (p.kind === "face" ? true : treePickRefusal(p, "face")),
      () => {},
    );

  it("every refusal goes when a row is taken, other toasts stay, and the same refusal shows again", () => {
    vi.useFakeTimers();
    const { e } = toasting();
    toast("Copied.");
    wantsFace();
    expect(routePlaneRow(e, XZ)).toBe("refused");
    expect(routePlaneRow(e, DATUM)).toBe("refused");
    const datum = treePickRefusal(DATUM, "face");
    expect(showing()).toEqual(["Copied.", treePickRefusal(XZ, "face"), datum]);
    expect(routeTreeClick({ kind: "face", faceId: 14 }, treeClickDeps(e))).toBe("taken");
    expect(showing()).toEqual(["Copied."]);
    vi.advanceTimersByTime(200);
    expect(routePlaneRow(e, DATUM)).toBe("refused");
    expect(showing()).toEqual(["Copied.", datum]);
    vi.useRealTimers();
  });

  it("a row taken with no refusal before it takes nothing down", () => {
    const { e } = toasting();
    toast("Copied.");
    wantsFace();
    expect(routeTreeClick({ kind: "face", faceId: 3 }, treeClickDeps(e))).toBe("taken");
    expect(showing()).toEqual(["Copied."]);
  });

  it("a refusal is heard once, under the selection readout's key, and its toast only shows it", () => {
    const { e } = toasting();
    wantsFace();
    said.length = 0;
    expect(routePlaneRow(e, XZ)).toBe("refused");
    const text = treePickRefusal(XZ, "face");
    expect(showing()).toEqual([text]);
    expect(said).toEqual([[text, "polite", { key: "selection", delay: SELECTION_SPEECH_DELAY }]]);
  });

  it("a refusal repeated while it is still up shows once", () => {
    const { e } = toasting();
    wantsFace();
    routePlaneRow(e, XZ);
    routePlaneRow(e, XZ);
    expect(showing()).toEqual([treePickRefusal(XZ, "face")]);
  });
});
