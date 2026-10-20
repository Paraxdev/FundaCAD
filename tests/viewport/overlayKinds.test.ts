import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import {
  DEFAULT_OVERLAYS, OVERLAY_KINDS, allOverlaysOn, asOverlays, drawMask, markOverlay, overlayBit,
  overlayKindOf, overlayLayer, pickLayers, pickMask, pictureMask, setPickLayers, syncOverlayLayers,
  type OverlayKind, type OverlayState,
} from "../../src/viewport/overlayKinds";
import { hideForPicture } from "../../src/viewport/pictureScene";

const cam = (mask: number) => {
  const c = new THREE.PerspectiveCamera();
  c.layers.mask = mask;
  return c;
};
const withOff = (...off: OverlayKind[]): OverlayState => {
  const kinds = allOverlaysOn();
  for (const k of off) kinds[k] = false;
  return { on: true, kinds };
};

describe("overlay registry", () => {
  it("gives every kind its own layer above the model's", () => {
    const layers = OVERLAY_KINDS.map(overlayLayer);
    expect(new Set(layers).size).toBe(OVERLAY_KINDS.length);
    expect(Math.min(...layers)).toBe(1);
    expect(Math.max(...layers)).toBeLessThan(32);
  });

  it("puts a tagged object and its children on that kind's layer only", () => {
    const g = new THREE.Group();
    const child = new THREE.Mesh();
    const own = new THREE.Mesh();
    markOverlay(own, "highlight");
    g.add(child, own);
    markOverlay(g, "grid");
    expect(g.layers.mask).toBe(overlayBit("grid"));
    expect(child.layers.mask).toBe(overlayBit("grid"));
    expect(own.layers.mask).toBe(overlayBit("highlight"));
    expect(overlayKindOf(g)).toBe("grid");
  });

  it("covers a child added to a tagged top level object after it was tagged", () => {
    const scene = new THREE.Scene();
    const g = markOverlay(new THREE.Group(), "handles");
    scene.add(g);
    const late = new THREE.Mesh();
    g.add(late);
    expect(late.layers.mask).toBe(1);
    syncOverlayLayers(scene);
    expect(late.layers.mask).toBe(overlayBit("handles"));
  });

  it("draws a kind only while it and the master switch are on", () => {
    const edge = markOverlay(new THREE.Object3D(), "edges");
    const body = new THREE.Mesh();
    const off = cam(drawMask(withOff("edges")));
    expect(edge.layers.test(off.layers)).toBe(false);
    expect(body.layers.test(off.layers)).toBe(true);
    expect(edge.layers.test(cam(drawMask(DEFAULT_OVERLAYS)).layers)).toBe(true);
    const master = { on: false, kinds: allOverlaysOn() };
    for (const k of OVERLAY_KINDS) expect(drawMask(master) & overlayBit(k)).toBe(0);
    expect(drawMask(master) & 1).toBe(1);
  });

  it("draws a running tool's handles and the open sketch whatever the switches say", () => {
    const clean = { on: false, kinds: allOverlaysOn() };
    expect(drawMask(clean, { tool: true, sketch: false, planes: false }) & overlayBit("handles")).not.toBe(0);
    expect(drawMask(clean, { tool: false, sketch: true, planes: false }) & overlayBit("sketches")).not.toBe(0);
    expect(drawMask(clean, { tool: true, sketch: false, planes: false }) & overlayBit("grid")).toBe(0);
  });

  it("draws and picks the construction planes while a plane pick shows them, whatever the switches say", () => {
    const clean = { on: false, kinds: allOverlaysOn() };
    const picking = drawMask(clean, { tool: true, sketch: false, planes: true });
    expect(picking & overlayBit("origin")).not.toBe(0);
    expect(pickMask(picking) & overlayBit("origin")).not.toBe(0);
    expect(drawMask(withOff("origin"), { tool: true, sketch: false, planes: true }) & overlayBit("origin")).not.toBe(0);
    expect(drawMask(clean, { tool: true, sketch: false, planes: false }) & overlayBit("origin")).toBe(0);
  });

  it("keeps hidden outlines and highlight pickable, and a hidden gizmo not", () => {
    const m = pickMask(drawMask(withOff("edges", "highlight", "handles")));
    expect(m & overlayBit("edges")).not.toBe(0);
    expect(m & overlayBit("highlight")).not.toBe(0);
    expect(m & overlayBit("handles")).toBe(0);
  });

  it("lets no overlay into a picture unless the export asks for the edges", () => {
    for (const k of OVERLAY_KINDS) expect(pictureMask({}) & overlayBit(k)).toBe(0);
    expect(pictureMask({}) & 1).toBe(1);
    expect(pictureMask({ edges: true }) & overlayBit("edges")).not.toBe(0);
    expect(pictureMask({ edges: true }) & overlayBit("handles")).toBe(0);
  });

  it("lets reference images into a picture only when asked, and draws them in the view", () => {
    expect(pictureMask({ references: true }) & overlayBit("references")).not.toBe(0);
    expect(pictureMask({ edges: true }) & overlayBit("references")).toBe(0);
    expect(drawMask(DEFAULT_OVERLAYS) & overlayBit("references")).not.toBe(0);
    expect(OVERLAY_KINDS[OVERLAY_KINDS.length - 1]).toBe("references");
  });

  it("hides a reference image from a picture unless the picture asks for it", () => {
    const scene = new THREE.Scene();
    const model = new THREE.Group();
    const quad = markOverlay(new THREE.Mesh(), "references");
    const handle = markOverlay(new THREE.Mesh(), "handles");
    scene.add(model, quad, handle);
    const show = hideForPicture(scene, model);
    expect(quad.visible).toBe(false);
    show();
    const showAgain = hideForPicture(scene, model, { references: true });
    expect(quad.visible).toBe(true);
    expect(handle.visible).toBe(false);
    showAgain();
    expect(handle.visible).toBe(true);
  });

  it("fills a kind the saved state does not name with shown", () => {
    expect(asOverlays({ on: false, kinds: { grid: false } })).toEqual({
      on: false,
      kinds: { ...allOverlaysOn(), grid: false },
    });
    expect(asOverlays("junk")).toEqual({ on: true, kinds: allOverlaysOn() });
    expect(asOverlays({ kinds: { edges: "no" } }).kinds.edges).toBe(true);
  });
});

describe("a hidden outline still selects its edge", () => {
  const edgeLine = () => {
    const geo = new LineSegmentsGeometry();
    geo.setPositions([-10, 0, 0, 10, 0, 0]);
    const mat = new LineMaterial({ linewidth: 4 });
    mat.resolution.set(200, 200);
    return new LineSegments2(geo, mat);
  };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 50);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const shoot = (r: THREE.Raycaster, o: THREE.Object3D) => {
    r.setFromCamera(new THREE.Vector2(0, 0), camera);
    (r as unknown as { camera: THREE.Camera }).camera = camera;
    r.params.Line2 = { threshold: 4 };
    return r.intersectObject(o, false).length;
  };

  it("hits the tagged edge with the outlines switched off", () => {
    const line = markOverlay(edgeLine(), "edges");
    const view = cam(drawMask(withOff("edges")));
    expect(line.layers.test(view.layers)).toBe(false);
    setPickLayers(pickMask(view.layers.mask));
    expect(shoot(pickLayers(new THREE.Raycaster()), line)).toBeGreaterThan(0);
  });

  it("misses it on a ray that is not given the pick layers", () => {
    const line = markOverlay(edgeLine(), "edges");
    expect(shoot(new THREE.Raycaster(), line)).toBe(0);
  });

  it("misses a hidden gizmo and hits a drawn one", () => {
    const gizmo = markOverlay(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4)), "handles");
    gizmo.updateMatrixWorld();
    setPickLayers(pickMask(drawMask(withOff("handles"))));
    expect(shoot(pickLayers(new THREE.Raycaster()), gizmo)).toBe(0);
    setPickLayers(pickMask(drawMask(DEFAULT_OVERLAYS)));
    expect(shoot(pickLayers(new THREE.Raycaster()), gizmo)).toBeGreaterThan(0);
  });
});

describe("a picture leaves the overlays out", () => {
  it("drops a tagged overlay by its layer and by the allowlist", () => {
    const scene = new THREE.Scene();
    const model = new THREE.Group();
    scene.add(model);
    const body = new THREE.Mesh();
    const glow = markOverlay(new THREE.Mesh(), "highlight");
    const edges = markOverlay(new THREE.Object3D(), "edges");
    body.add(glow, edges);
    model.add(body);
    const handle = markOverlay(new THREE.Group(), "handles");
    scene.add(handle);
    const restore = hideForPicture(scene, model);
    expect(glow.visible).toBe(false);
    expect(handle.visible).toBe(false);
    expect(body.visible).toBe(true);
    // An export may ask for the edges, so the allowlist leaves them to the layer.
    expect(edges.visible).toBe(true);
    restore();
    expect(glow.visible && handle.visible).toBe(true);
    const picture = cam(pictureMask({}));
    expect(edges.layers.test(picture.layers)).toBe(false);
    expect(glow.layers.test(picture.layers)).toBe(false);
    expect(body.layers.test(picture.layers)).toBe(true);
  });
});
