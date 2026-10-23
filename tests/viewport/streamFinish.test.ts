// A body must wear the finish the toggles say on every path onto the screen: set in one go, added by a stream chunk,
// held from the previous model, or committed at the end. The desktop streams a big reply and used to leave those
// bodies in the loading ghost look until a toggle re-applied the finish.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BodyFinishLayer } from "../../src/viewport/bodyFinish";
import { ProgressiveModel } from "../../src/viewport/progressive";
import { DEFAULT_OVERLAYS } from "../../src/viewport/overlayKinds";
import { DisposeQueue } from "../../src/viewport/disposeQueue";
import { disposeBody } from "../../src/viewport/render";
import type { BodyMesh } from "../../src/viewport/render";
import { Viewport } from "../../src/viewport/viewport";
import type { RebuildResult } from "../../src/types";

type Flag = "xray" | "stale" | "wireframe";
const FLAGS: Flag[] = ["xray", "stale", "wireframe"];

function reply(ids: string[], etag = "e1"): RebuildResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  ids.forEach((id, b) => {
    const v0 = b * 4;
    for (let v = 0; v < 4; v++) positions.push(v0 + v, v, b);
    indices.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 2, v0 + 3);
    faceIds.push(b * 2, b * 2 + 1);
    bodies.push({ id, name: id, faceStart: b * 2, faceCount: 2, etag: `${etag}-${id}` });
  });
  return {
    mesh: { positions, indices, faceIds },
    edges: [],
    bbox: { min: [0, 0, 0], max: [ids.length, 4, 1] },
    bodies,
  };
}

/** The Viewport's private state a load path reads, set by hand since the real one needs a WebGL canvas. */
interface Bare {
  model: { bodies: BodyMesh[] } | null;
  finish: BodyFinishLayer;
  scene: unknown;
  xray: boolean;
  stale: boolean;
  wireframe: boolean;
}
const V = (b: Bare) => b as unknown as Viewport;

function bare() {
  const group = new THREE.Group();
  const vp = Object.create(Viewport.prototype) as Bare;
  const noop = () => {};
  Object.assign(vp, {
    scene: {
      modelGroup: group,
      scene: new THREE.Scene(),
      frameShadows: noop,
      renderer: { shadowMap: { enabled: false } },
    },
    progressive: new ProgressiveModel(group, disposeBody),
    resolution: new THREE.Vector2(800, 600),
    model: null,
    streaming: false,
    streamMemo: null,
    lastResult: null,
    highlighter: null,
    xray: false,
    stale: false,
    wireframe: false,
    peek: new Set<string>(),
    analysis: "none",
    faceBands: new Map(),
    savedMats: new Map(),
    caps: new Map(),
    // The drawing side of a commit, none of which touches a body's material.
    applyAnalysis: noop,
    adoptProgressiveView: function (this: Record<string, unknown>, view: unknown) {
      this.model = view;
    },
    setInterferenceOverlay: noop,
    setStressOverlay: noop,
    clearFaceMarks: noop,
    setComMarker: noop,
    dropAreaProjection: noop,
    showSketchFace: noop,
    captureSelection: () => null,
    restoreSelection: noop,
    hideFlushSeams: noop,
    syncBloomable: noop,
    auditScene: noop,
    requestRender: noop,
    bodyBoxes: () => [],
    picker: { invalidate: noop },
    rig: { setContentBox: noop, fit: noop },
    overlays: DEFAULT_OVERLAYS,
    disposeQueue: new DisposeQueue((run) => run()),
    ghostMeshes: [],
    combsObj: null,
  });
  vp.finish = new BodyFinishLayer({
    model: () => vp.model as never,
    scene: () => vp.scene as never,
    faceIdToBodyId: () => null,
    addToScene: noop,
    requestRender: noop,
    savedMats: () => new Map(),
  });
  return vp;
}

const look = (b: BodyMesh) => {
  const m = b.mesh.material as THREE.MeshStandardMaterial;
  return [b.id, m.transparent, m.opacity, m.depthWrite, m.colorWrite];
};
const looks = (vp: Bare) => vp.model!.bodies.map(look);

function setFlag(vp: Bare, flag: Flag, on: boolean) {
  vp[flag] = on;
}

/** Drive a chunked reply the way rebuildBridge does: begin, one append per chunk, then the commit. */
function streamThenCommit(vp: Bare, r: RebuildResult, size: number, commit = true) {
  const metas = r.bodies!;
  V(vp).beginProgressiveModel(1, metas, r, r.bbox, [], false);
  for (let i = 0; i < metas.length; i += size) {
    const slice = metas.slice(i, i + size);
    V(vp).appendProgressiveBodies(
      1,
      r,
      slice,
      new Map(slice.map((m) => [m.id, []])),
      { triStart: slice[0]!.faceStart, triEnd: slice.at(-1)!.faceStart + slice.at(-1)!.faceCount },
      [],
    );
  }
  if (commit) V(vp).setModel(r);
}

describe("finish across the load paths", () => {
  for (const flag of FLAGS) {
    for (const on of [true, false]) {
      it(`${flag} ${on ? "on" : "off"}: chunks, held bodies and the commit match a one-go load`, () => {
        const ids = ["a", "b", "c", "d", "e"];
        const oneGo = bare();
        setFlag(oneGo, flag, on);
        V(oneGo).setModel(reply(ids));
        const expected = looks(oneGo);

        // Mid stream: the chunk's bodies already wear it, before any commit.
        const streamed = bare();
        setFlag(streamed, flag, on);
        streamThenCommit(streamed, reply(ids), 2, false);
        expect(looks(streamed)).toEqual(expected);

        streamThenCommit(streamed, reply(ids), 2);
        expect(looks(streamed)).toEqual(expected);
      });
    }
  }

  it("bodies held from the previous model wear the current finish while the next stream runs", () => {
    const vp = bare();
    V(vp).setModel(reply(["a", "b"]));
    // The toggle flipped with no finish pass in between, and the stream holds both bodies by etag.
    setFlag(vp, "xray", true);
    streamThenCommit(vp, reply(["a", "b", "c"], "e1"), 1, false);
    expect(looks(vp).map((l) => [l[1], l[2]])).toEqual([
      [true, 0.35],
      [true, 0.35],
      [true, 0.35],
    ]);
  });

  it("a ghost from an earlier model does not survive a new one", () => {
    const vp = bare();
    setFlag(vp, "xray", true);
    V(vp).setModel(reply(["a", "b"]));
    V(vp).clearModel();
    setFlag(vp, "xray", false);
    V(vp).setModel(reply(["a", "b"], "e2"));
    expect(looks(vp).every(([, transparent, opacity]) => transparent === false && opacity === 1)).toBe(true);
  });

  it("wireframe keeps depth writes off however often the finish is applied", () => {
    const vp = bare();
    setFlag(vp, "wireframe", true);
    V(vp).setModel(reply(["a"]));
    const mat = vp.model!.bodies[0]!.mesh.material as THREE.MeshStandardMaterial;
    vp.finish.apply({ xray: false, stale: false, wireframe: true });
    vp.finish.apply({ xray: false, stale: false, wireframe: true });
    expect([mat.colorWrite, mat.depthWrite]).toEqual([false, false]);
  });
});
