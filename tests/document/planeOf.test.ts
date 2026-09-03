import { describe, it, expect } from "vitest";
import { planeOf } from "../../src/document/planeOf";
import type { PlaneDef, PlaneSpec } from "../../src/types";

/** A sketch that follows a body face is DRAWN from one place and BUILT from
 *  another unless every reader goes through here: the feature's own `plane` is
 *  the cache written when it was last closed, and the rebuild reports where it
 *  actually put it. */

const spec = (z: number): PlaneSpec =>
  ({ origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] });
const def = (z: number): PlaneDef =>
  ({ origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] });

describe("where a plane-carrying feature actually sits", () => {
  it("falls back to the feature's own plane when nothing was reported", () => {
    // The control every case below rests on: a document with no anchor in it
    // must read exactly as it always did.
    const f = { id: "s1", plane: spec(10) };
    expect(planeOf(f, undefined, undefined)).toBe(f.plane);
    expect(planeOf(f, {}, {})).toBe(f.plane);
  });

  it("prefers what the build reported for this very feature", () => {
    const f = { id: "s1", plane: spec(10) };
    expect(planeOf(f, { s1: def(20) }, undefined)).toEqual(def(20));
  });

  it("follows the datum a sketch is bound to when the sketch has no entry", () => {
    // A sketch made by "Offset plane" carries no face of its own — the anchor
    // rides on the DATUM — so the sidecar reports nothing under the sketch's id
    // while the datum does move. Without this the geometry follows and only the
    // drawing stays behind.
    const f = { id: "s1", plane: spec(10), planeId: "d1" };
    expect(planeOf(f, {}, { d1: def(35) })).toEqual(def(35));
  });

  it("lets the sketch's own entry win over its datum's", () => {
    const f = { id: "s1", plane: spec(10), planeId: "d1" };
    expect(planeOf(f, { s1: def(20) }, { d1: def(35) })).toEqual(def(20));
  });

  it("ignores a datum entry when the feature names no datum", () => {
    const f = { id: "s1", plane: spec(10) };
    expect(planeOf(f, {}, { d1: def(35) })).toBe(f.plane);
  });

  it("ignores an entry belonging to some other feature", () => {
    const f = { id: "s1", plane: spec(10), planeId: "d1" };
    expect(planeOf(f, { s2: def(20) }, { d2: def(35) })).toBe(f.plane);
  });

  it("reaches the datum map only through a feature's planeId, never its own id", () => {
    // This answers "where is the sketch", so the datum map is only ever a
    // lookup of what the sketch is BOUND to. A datum asked about itself belongs
    // to app/datumPlanes.ts, which reads that map directly and backs the offset
    // out of it — a job this function does not do and must not appear to.
    const d = { id: "d1", plane: spec(10) };
    expect(planeOf(d, undefined, { d1: def(35) })).toBe(d.plane);
  });
});
