// Glass refracts what three copies into its transmission target, and three picks
// that by material alone: its opaque list is copied, then glass is drawn over it,
// then the transparent list is drawn on top. So a viewport helper sorted into the
// opaque list shows a displaced copy of itself inside glass and is covered by it.
// The rule is asserted with three's own sorting code, on what each helper draws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { WebGLRenderList } from "three/src/renderers/webgl/WebGLRenderLists.js";
import { MoveTool } from "../../src/features/moveTool";
import { ALL_HANDLES, WORLD_FRAME, type MoveTarget } from "../../src/features/moveTarget";
import { BodyEdges } from "../../src/viewport/edgeLines";
import { EdgeEmphasis } from "../../src/viewport/edgeEmphasis";
import { makeFaceHoverOverlay, makeSelectionGlow } from "../../src/viewport/selectionGlow";
import { SketchOverlay } from "../../src/sketch/overlay";
import type { CadDocument } from "../../src/types";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";

type Lists = { opaque: string[]; transmissive: string[]; transparent: string[] };
// three r186 push() reads camera.reversedDepth, @types/three 0.186 still lists six arguments.
type RenderList = Omit<THREE.WebGLRenderList, "push"> & {
  push(...args: [...Parameters<THREE.WebGLRenderList["push"]>, camera: { reversedDepth: boolean }]): void;
};

function sort(root: THREE.Object3D): Lists {
  const list = new (WebGLRenderList as unknown as new () => RenderList)();
  list.init();
  root.traverse((o) => {
    const { material, geometry } = o as THREE.Mesh;
    if (!material || !geometry) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (m.visible) list.push(o, geometry, m, 0, 0, null, { reversedDepth: false });
    }
  });
  const names = (items: THREE.RenderItem[]) =>
    items.map((i) => `${i.object.type}${i.object.name ? `:${i.object.name}` : ""}`);
  return { opaque: names(list.opaque), transmissive: names(list.transmissive), transparent: names(list.transparent) };
}

const RES = new THREE.Vector2(800, 600);

describe("glass refracts only bodies", () => {
  it("three sorts a glass body as transmissive and a plain body as opaque", () => {
    const g = new THREE.Group();
    const box = new THREE.BoxGeometry(1, 1, 1);
    g.add(new THREE.Mesh(box, new THREE.MeshStandardMaterial()));
    g.add(new THREE.Mesh(box, new THREE.MeshPhysicalMaterial({ transmission: 1 })));
    const lists = sort(g);
    expect(lists.opaque).toHaveLength(1);
    expect(lists.transmissive).toHaveLength(1);
  });

  it("body edge lines stay out of the refraction, also after a reused body is reset", () => {
    const edges = new BodyEdges(
      [
        {
          id: "e0",
          body: "b",
          points: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
      ],
      RES,
    );
    expect(sort(edges.object).opaque).toEqual([]);
    edges.resetAppearance();
    expect(sort(edges.object).opaque).toEqual([]);
  });

  it("selection glow, face hover and edge emphasis stay out of the refraction", () => {
    const g = new THREE.Group();
    g.add(makeSelectionGlow(new THREE.BoxGeometry(1, 1, 1), "select"));
    g.add(makeFaceHoverOverlay(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new THREE.Color(1, 0, 0)));
    g.add(new EdgeEmphasis(RES, 0xff0000).object);
    expect(sort(g).opaque).toEqual([]);
  });

  it("sketch curves, construction lines and the snap marker stay out of the refraction", () => {
    const doc = {
      version: 4,
      parameters: {},
      features: [
        {
          id: "s1",
          type: "sketch",
          plane: "XY",
          entities: [
            { type: "rectangle", id: "r", x: 0, y: 0, width: 10, height: 10 },
            { type: "line", id: "c", x1: 0, y1: 0, x2: 10, y2: 10, construction: true },
            { type: "point", id: "p", x: 5, y: 5 },
          ],
        },
      ],
    } as unknown as CadDocument;
    const o = new SketchOverlay();
    o.update(doc);
    const lists = sort(o.group);
    expect(lists.opaque).toEqual([]);
    expect(lists.transparent.length).toBeGreaterThan(3);
  });

  describe("move gizmo", () => {
    let frames: (() => void)[] = [];
    beforeEach(() => {
      setActivePinia(createPinia());
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
        frames.push(fn);
        return frames.length;
      });
      vi.stubGlobal("cancelAnimationFrame", () => {});
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      document.body.innerHTML = "";
    });

    it("every drawn handle is an overlay, so glass neither refracts nor covers it", () => {
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(0, -500, 0);
      camera.lookAt(0, 0, 0);
      const vp = {
        suspendPicking: false,
        domElement: document.createElement("canvas"),
        camera,
        addToScene: (o: THREE.Object3D) => scene.add(o),
        removeFromScene: (o: THREE.Object3D) => scene.remove(o),
        requestRender: () => {},
        pixelWorldSize: () => 1,
        projectToScreen: (p: THREE.Vector3) => ({ x: p.x, y: -p.z }),
        hoverThrough: () => {},
        rayFrom: () => new THREE.Raycaster(),
        probe: () => null,
        screenToPlane: () => null,
        pointAt: () => null,
        overlayOn: () => true,
        watchOverlays: () => () => {},
      } as unknown as Viewport;
      const store = { onBuild: () => () => {} } as unknown as DocumentStore;
      const c = new THREE.Vector3();
      const target = {
        frame: WORLD_FRAME,
        handles: ALL_HANDLES,
        uniformScale: false,
        canCopy: false,
        ownsEscape: true,
        centroid: () => c.clone(),
        box: () => new THREE.Box3(c.clone().subScalar(5), c.clone().addScalar(5)),
        begin: () => {},
        preview: () => {},
        commit: () => ({ id: null, rebuild: false }),
        end: () => {},
        reopen: () => null,
      } as unknown as MoveTarget;

      new MoveTool(vp, store).startTarget(target, () => {});
      for (const f of frames.splice(0)) f();

      const lists = sort(scene);
      expect(lists.opaque).toEqual([]);
      expect(lists.transparent.length).toBeGreaterThan(9);
    });
  });
});
