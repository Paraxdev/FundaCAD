// The model on screen when a Fillet or Chamfer opens is held for its picks: a preview that replaces a body takes it
// off screen but leaves it whole until the tool lets go.

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { BodyFinishLayer } from "../../src/viewport/bodyFinish";
import { ProgressiveModel } from "../../src/viewport/progressive";
import { DEFAULT_OVERLAYS } from "../../src/viewport/overlayKinds";
import { DisposeQueue } from "../../src/viewport/disposeQueue";
import { Picker } from "../../src/viewport/picking";
import type { BodyMesh } from "../../src/viewport/render";
import { Viewport } from "../../src/viewport/viewport";
import type { RebuildResult } from "../../src/types";

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
    progressive: new ProgressiveModel(group, (b: BodyMesh) =>
      (vp as unknown as { retireBody(b: BodyMesh): void }).retireBody(b),
    ),
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
    picker: new Picker(),
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

const disposed = (b: BodyMesh) => {
  const fn = vi.fn();
  b.mesh.geometry.addEventListener("dispose", fn);
  return fn;
};

describe("a held model", () => {
  it("keeps a replaced body whole and off screen, and frees it on release", () => {
    const vp = bare();
    const group = (vp.scene as { modelGroup: THREE.Group }).modelGroup;
    V(vp).setModel(reply(["b1", "b2"]));
    const held = V(vp).holdModel()!;
    const [kept, replaced] = held.bodies as [BodyMesh, BodyMesh];
    const keptGone = disposed(kept);
    const replacedGone = disposed(replaced);
    const next = reply(["b1", "b2"]);
    next.bodies![1]!.etag = "e2-b2";
    V(vp).setModel(next);
    expect(vp.model!.bodies[0]).toBe(kept);
    expect(vp.model!.bodies[1]).not.toBe(replaced);
    expect(group.children).not.toContain(replaced.mesh);
    expect(replacedGone).not.toHaveBeenCalled();
    expect(V(vp).heldDiff(held).gone).toEqual([replaced]);
    V(vp).releaseModel(held);
    expect(replacedGone).toHaveBeenCalledOnce();
    expect(keptGone).not.toHaveBeenCalled();
  });

  it("frees a replaced body at once when nothing holds it", () => {
    const vp = bare();
    V(vp).setModel(reply(["b1"]));
    const first = vp.model!.bodies[0]!;
    const gone = disposed(first);
    V(vp).setModel(reply(["b1"], "e2"));
    expect(gone).toHaveBeenCalledOnce();
  });
});
