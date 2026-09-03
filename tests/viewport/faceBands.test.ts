import { describe, it, expect } from "vitest";
import { bandIndex, expandToBand } from "../../src/viewport/faceBands";

/** A body's runs arrive in that body's OWN face numbering; the index has to put
 *  them back into the global numbering the picker works in. Everything here is
 *  about that translation and about refusing to guess when a run is nonsense. */

const body = (faceStart: number, faceCount: number, faceBands?: number[][]) =>
  ({ faceStart, faceCount, ...(faceBands ? { faceBands } : {}) });

describe("face band lookup", () => {
  it("gives every member of a run the whole run", () => {
    const idx = bandIndex([body(0, 8, [[2, 5, 6]])]);
    for (const f of [2, 5, 6]) expect([...expandToBand(f, idx)]).toEqual([2, 5, 6]);
  });

  it("leaves a face that is in no run alone", () => {
    const idx = bandIndex([body(0, 8, [[2, 5, 6]])]);
    expect([...expandToBand(3, idx)]).toEqual([3]);
    expect([...expandToBand(0, idx)]).toEqual([0]);
  });

  it("is empty for a model whose bodies have no runs", () => {
    // The control the rest of the file rests on: nothing is banded by default,
    // so every pick stays exactly the one face the user clicked.
    const idx = bandIndex([body(0, 6), body(6, 12), body(18, 3)]);
    expect(idx.size).toBe(0);
    expect([...expandToBand(7, idx)]).toEqual([7]);
  });

  it("shifts a run into the global numbering of its own body", () => {
    // Two bodies, each with a run at the same LOCAL indices. Without the shift
    // the second body's run would land on the first body's faces.
    const idx = bandIndex([body(0, 4, [[1, 2]]), body(4, 4, [[1, 2]])]);
    expect([...expandToBand(1, idx)]).toEqual([1, 2]);
    expect([...expandToBand(5, idx)]).toEqual([5, 6]);
    expect([...expandToBand(2, idx)]).toEqual([1, 2]);
  });

  it("returns a run in ascending order whatever order it arrived in", () => {
    const idx = bandIndex([body(10, 8, [[6, 0, 3]])]);
    expect([...expandToBand(13, idx)]).toEqual([10, 13, 16]);
  });

  it("drops a run that reaches outside its own body", () => {
    // A run naming a face the body does not have would select another body's
    // faces. It is discarded whole rather than clamped: a run that is wrong
    // about its extent cannot be trusted about its members either.
    const idx = bandIndex([body(0, 4, [[1, 2, 9]]), body(4, 4, [[0, 1]])]);
    expect([...expandToBand(1, idx)]).toEqual([1]);
    expect([...expandToBand(2, idx)]).toEqual([2]);
    // ...and the sound run beside it still works, so the drop was the bad run's
    // own and not the whole index giving up.
    expect([...expandToBand(4, idx)]).toEqual([4, 5]);
  });

  it("drops a run with a negative member", () => {
    const idx = bandIndex([body(4, 4, [[-1, 1]])]);
    expect(idx.size).toBe(0);
  });

  it("ignores a run of one, which means nothing to a pick", () => {
    const idx = bandIndex([body(0, 4, [[2]])]);
    expect(idx.size).toBe(0);
    expect([...expandToBand(2, idx)]).toEqual([2]);
  });

  it("keeps several runs on one body apart", () => {
    const idx = bandIndex([body(0, 10, [[0, 1], [4, 5, 6]])]);
    expect([...expandToBand(1, idx)]).toEqual([0, 1]);
    expect([...expandToBand(5, idx)]).toEqual([4, 5, 6]);
    expect([...expandToBand(3, idx)]).toEqual([3]);
  });

  it("shares one array between a run's members rather than copying it", () => {
    // The lookup is on the hover path, which runs on every pointer move over
    // the model, so a run must not be rebuilt per member.
    const idx = bandIndex([body(0, 8, [[2, 5, 6]])]);
    expect(expandToBand(2, idx)).toBe(expandToBand(6, idx));
  });
});
