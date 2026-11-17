import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { awaitFaceRows } from "../../src/features/faceRows";
import {
  endCommandedPick,
  endRewoundPick,
  resetTreePicks,
  routeTreeClick,
  treePickWaiting,
} from "../../src/ui/treePick";
import type { Viewport } from "../../src/viewport/viewport";
import type { PressPullFaces } from "../../src/viewport/faceAnalysis";

afterEach(resetTreePicks);

const deps = () => {
  const hints: string[] = [];
  return { hints, busyHint: () => null, hint: (t: string) => hints.push(t) };
};

function faces(ids: number[]): PressPullFaces {
  return {
    selectors: ids.map((id) => ({ kind: "face", by: "nearest", point: [id * 1.5, -2.25, 7.5] })),
    faceIds: ids,
    normal: new THREE.Vector3(0, 0.6, 0.8),
    anchor: new THREE.Vector3(3, -2.25, 7.5),
    bodyId: "b2",
    round: null,
    lead: null,
  };
}

function rig(built = true) {
  const asked: number[][] = [];
  const vp = {
    facesForPressPull: (ids: readonly number[]) => {
      asked.push([...ids]);
      return built ? faces([...ids]) : null;
    },
  } as unknown as Viewport;
  return { vp, asked };
}

describe("a face row for a tool that waits for faces", () => {
  it("hands the take the face as the tool sees it selected, and is taken", () => {
    const { vp, asked } = rig();
    const got: PressPullFaces[] = [];
    awaitFaceRows(
      vp,
      "face",
      (f) => (got.push(f), true),
      () => {},
    );
    const d = deps();
    expect(routeTreeClick({ kind: "face", faceId: 14 }, d)).toBe("taken");
    expect([asked, got, d.hints]).toEqual([[[14]], [faces([14])], []]);
  });

  it("gives the take's hint back and keeps waiting, one row after another", () => {
    const { vp } = rig();
    const seen: number[] = [];
    awaitFaceRows(
      vp,
      "face",
      (f) => (seen.push(f.faceIds[0]!), seen.length < 2 ? "Not that one" : true),
      () => {},
    );
    const d = deps();
    expect(routeTreeClick({ kind: "face", faceId: 5 }, d)).toBe("refused");
    expect([d.hints, treePickWaiting()]).toEqual([["Not that one"], true]);
    expect(routeTreeClick({ kind: "face", faceId: 9 }, d)).toBe("taken");
    expect(seen).toEqual([5, 9]);
  });

  it("refuses an edge row naming what it wants, and a face row before the model is built", () => {
    const edge = {
      kind: "edge",
      edge: {
        body: "b2",
        points: [
          [0, 1, 2],
          [3, 4, 5],
        ],
      },
    } as never;
    const a = rig();
    let took = 0;
    awaitFaceRows(
      a.vp,
      "face",
      () => (took++, true),
      () => {},
    );
    const d = deps();
    expect(routeTreeClick(edge, d)).toBe("refused");
    expect([d.hints, a.asked, took, treePickWaiting()]).toEqual([
      ["That row is an edge, this step needs a face"],
      [],
      0,
      true,
    ]);

    resetTreePicks();
    const b = rig(false);
    awaitFaceRows(
      b.vp,
      "face",
      () => (took++, true),
      () => {},
    );
    const e = deps();
    expect(routeTreeClick({ kind: "face", faceId: 3 }, e)).toBe("refused");
    expect([e.hints.length, took, treePickWaiting()]).toEqual([1, 0, true]);
    expect(e.hints[0]).toMatch(/building/);
  });

  it("stays through a command and through undo, and a new pick ends it", () => {
    const { vp } = rig();
    const ended: string[] = [];
    awaitFaceRows(
      vp,
      "face",
      () => true,
      () => ended.push("rows"),
    );
    endCommandedPick();
    endRewoundPick();
    expect([ended, treePickWaiting()]).toEqual([[], true]);
    const release = awaitFaceRows(
      vp,
      "face",
      () => true,
      () => ended.push("second"),
    );
    expect(ended).toEqual(["rows"]);
    release();
    expect(treePickWaiting()).toBe(false);
  });
});
