// What the press/pull tool makes of the engine's faceAxis answer: whether the
// Along axis switch is offered, which way it starts, and where the arrow stands.

import { describe, it, expect } from "vitest";
import { anchorOnAxis, initialDirection, offeredAxis, offeredResize, resizeAxis } from "../../src/features/pressPullAxis";
import type { FaceAxisReply } from "../../src/geometry/client";

const ceiling = { axis: { origin: [0, 0, 22.5], dir: [0, 0, -1] }, hole: true, sameAsNormal: false } as const;

describe("offeredAxis", () => {
  it("offers a hole's cone ceiling, and starts on the axis", () => {
    const axis = offeredAxis({ ...ceiling, axis: { origin: [0, 0, 22.5], dir: [0, 0, -1] } });
    expect(axis).toEqual({ origin: [0, 0, 22.5], dir: [0, 0, -1], hole: true });
    expect(initialDirection(axis)).toBe("axis");
  });

  it("offers a face off its bore's axis, but starts along the normal", () => {
    const axis = offeredAxis({ axis: { origin: [0, 0, 0], dir: [0, 0, 2] }, hole: false });
    expect(axis?.dir).toEqual([0, 0, 1]);
    expect(initialDirection(axis)).toBe("normal");
  });

  it("does not offer a flat floor square to its axis, which moves the same either way", () => {
    expect(offeredAxis({ axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, hole: false, sameAsNormal: true })).toBeNull();
  });

  it("does not offer a face with no axis, a failed call or a broken reply", () => {
    expect(offeredAxis({ reason: "the walls around the face do not all run along one axis" })).toBeNull();
    expect(offeredAxis(null)).toBeNull();
    expect(offeredAxis({ axis: { origin: [0, 0, 0], dir: [0, 0, 0] }, hole: true })).toBeNull();
    expect(offeredAxis({ axis: { origin: [0, Number.NaN, 0], dir: [0, 0, 1] }, hole: true })).toBeNull();
    expect(initialDirection(null)).toBe("normal");
  });
});

describe("anchorOnAxis", () => {
  it("drops the picked point onto the axis line", () => {
    const axis = { origin: [1, 2, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number], hole: true };
    expect(anchorOnAxis([1.3, 2.4, 7], axis)).toEqual([1, 2, 7]);
  });

  it("keeps a point already on a slanted axis where it is", () => {
    const s = Math.SQRT1_2;
    const axis = { origin: [0, 0, 0] as [number, number, number], dir: [s, 0, s] as [number, number, number], hole: false };
    const [x, y, z] = anchorOnAxis([3, 0, 3], axis);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(3);
  });
});

describe("offeredResize", () => {
  const slotEnd = {
    reason: "the walls around the face do not all run along one axis",
    resize: {
      kind: "cylinder" as const,
      size: 2,
      full: false,
      concave: true,
      axis: { origin: [0, 7.125, 20] as [number, number, number], dir: [1, 0, 0] as [number, number, number] },
      contact: 2,
      tangent: {
        faces: 2,
        lostWhen: "shrink" as const,
        run: [[0, 9.125, 20], [0, 0, 18], [0, 0, 22], [0, -16.875, 20]] as [number, number, number][],
        closed: true,
        followable: true,
      },
    },
  };

  it("reads a slot end's exact radius, wrap and tangent run", () => {
    expect(offeredResize(slotEnd)).toEqual({
      kind: "cylinder",
      radius: 2,
      full: false,
      concave: true,
      contact: 2,
      tangent: slotEnd.resize.tangent,
    });
  });

  it("reads a round hole with nothing running into it", () => {
    const hole = { ...slotEnd, resize: { ...slotEnd.resize, size: 3.369, full: true, contact: null, tangent: { faces: 0, lostWhen: null, run: [[0, 0, 0]] as [number, number, number][], closed: false, followable: false } } };
    expect(offeredResize(hole)).toMatchObject({ radius: 3.369, full: true, contact: null, tangent: { faces: 0, lostWhen: null } });
  });

  it("offers nothing for a face that is not a cylinder, or a reply with no resize", () => {
    expect(offeredResize({ ...slotEnd, resize: { ...slotEnd.resize, kind: "sphere" as const } })).toBeNull();
    expect(offeredResize({ reason: "flat" })).toBeNull();
    expect(offeredResize(null)).toBeNull();
  });

  it("rejects a malformed reply rather than resizing from it", () => {
    const bad = (patch: Record<string, unknown>, tangent: Record<string, unknown> = {}) =>
      offeredResize({ ...slotEnd, resize: { ...slotEnd.resize, ...patch, tangent: { ...slotEnd.resize.tangent, ...tangent } } } as never);
    expect(bad({ size: 0 })).toBeNull();
    expect(bad({ size: -2 })).toBeNull();
    expect(bad({ size: Number.NaN })).toBeNull();
    expect(bad({ size: "2" })).toBeNull();
    expect(bad({ full: "no" })).toBeNull();
    expect(bad({ concave: undefined })).toBeNull();
    expect(bad({ contact: -1 })).toBeNull();
    expect(bad({ contact: Number.POSITIVE_INFINITY })).toBeNull();
    expect(offeredResize({ ...slotEnd, resize: { ...slotEnd.resize, tangent: null } } as never)).toBeNull();
    expect(bad({}, { faces: 1.5 })).toBeNull();
    expect(bad({}, { faces: -1 })).toBeNull();
    expect(bad({}, { lostWhen: "sideways" })).toBeNull();
    expect(bad({}, { run: [[0, Number.NaN, 0]] })).toBeNull();
    expect(bad({}, { run: "here" })).toBeNull();
    expect(bad({}, { closed: 1 })).toBeNull();
    expect(bad({}, { followable: undefined })).toBeNull();
  });

  const curved = (kind: "sphere" | "cone" | "torus", patch: Record<string, unknown> = {}) =>
    ({ ...slotEnd, resize: { ...slotEnd.resize, kind, full: false, contact: null, ...patch } }) as never;

  it("reads a sphere, a cone and a torus when asked for them", () => {
    const all = ["sphere", "cone", "torus"] as const;
    expect(offeredResize(curved("sphere", { size: 4, centre: [0, 0, 10] }), all)).toMatchObject({ kind: "sphere", radius: 4, centre: [0, 0, 10] });
    expect(offeredResize(curved("cone", { size: 0 }), all)).toMatchObject({ kind: "cone", radius: 0 });
    expect(offeredResize(curved("torus", { size: 1.5 }), all)).toMatchObject({ kind: "torus", radius: 1.5 });
    expect(offeredResize(curved("torus", { size: 1.5 }), all)?.centre).toBeUndefined();
  });

  it("still offers only a cylinder unless asked, and refuses a malformed sphere or cone", () => {
    const all = ["sphere", "cone", "torus"] as const;
    expect(offeredResize(curved("sphere", { size: 4, centre: [0, 0, 10] }))).toBeNull();
    expect(offeredResize(slotEnd, all)).toBeNull();
    expect(offeredResize(curved("sphere", { size: 4 }), all)).toBeNull();
    expect(offeredResize(curved("sphere", { size: 4, centre: [0, Number.NaN, 0] }), all)).toBeNull();
    expect(offeredResize(curved("cone", { size: 1 }), all)).toBeNull();
    expect(offeredResize(curved("torus", { size: 0 }), all)).toBeNull();
  });
});

describe("resizeAxis", () => {
  const reply = (axis: unknown): FaceAxisReply =>
    ({
      reason: "none",
      resize: {
        kind: "cylinder", size: 2, full: false, concave: true, axis, contact: 2,
        tangent: { faces: 2, lostWhen: "shrink", run: [], closed: true, followable: true },
      },
    }) as FaceAxisReply;

  it("reads the engine's axis with a unit direction", () => {
    expect(resizeAxis(reply({ origin: [0, 7.125, 20], dir: [-3, 0, 0] }))).toEqual({ origin: [0, 7.125, 20], dir: [-1, 0, 0] });
  });

  it("has none for a sphere, a malformed axis or no reply", () => {
    expect(resizeAxis(reply(undefined))).toBeNull();
    expect(resizeAxis(reply({ origin: [0, NaN, 0], dir: [1, 0, 0] }))).toBeNull();
    expect(resizeAxis(reply({ origin: [0, 0, 0], dir: [0, 0, 0] }))).toBeNull();
    expect(resizeAxis(null)).toBeNull();
  });
});
