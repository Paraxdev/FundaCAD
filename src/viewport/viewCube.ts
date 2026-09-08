// A custom navigation ViewCube drawn in the top-right corner of the viewport.
//
// Rendering: a SECOND THREE.Scene + OrthographicCamera, drawn AFTER the main
// render into a small scissored corner region (renderer.setViewport/setScissor).
// Each frame the cube's orientation is synced to the main camera so it always
// shows the current view direction.
//
// Interaction: pointer events on the main canvas, restricted to the corner box,
// are raycast against the cube's pickable parts (6 faces + 8 corners + 12 edges).
//   - LEFT click  -> animate the main camera to that part's view (honoring any
//                    per-side override the user has redefined).
//   - RIGHT click on a FACE -> a small context menu ("Set orientation from
//                    face…", "Reset") that enters a pick mode: the next left
//                    click on the model redefines what that cube side means.
//
// The cube is a pure UI affordance; it reads/writes overrides through callbacks
// supplied by the Viewport (which bridges to the document store).

import * as THREE from "three";
import type { StandardView } from "./cameras";
import type { ViewCubeSide, ViewOverride } from "../types";
import { contextMenu } from "../ui/menu";
import { themeColor } from "./themeColors";

const SIZE = 120; // corner viewport, CSS px
const MARGIN = 14; // gap from the top-right edge
const HALF = 0.5; // half-extent of the unit cube

// the six face sides, with the world-space view direction (eye relative to
// target) and up that each represents by default. Z-up CAD: front looks along
// -Y, top looks down -Z, etc. Exported so the Viewport can reuse the per-side
// default normal/up when applying a side that has no override.
export const FACE_VIEWS: Record<
  ViewCubeSide,
  { view: StandardView; normal: THREE.Vector3; up: THREE.Vector3; label: string }
> = {
  front: { view: "front", normal: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1), label: "FRONT" },
  back: { view: "back", normal: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1), label: "BACK" },
  right: { view: "right", normal: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1), label: "RIGHT" },
  left: { view: "left", normal: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 0, 1), label: "LEFT" },
  top: { view: "top", normal: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), label: "TOP" },
  bottom: { view: "bottom", normal: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0), label: "BOTTOM" },
};

// The cube's own surfaces, and why every one of these numbers changed.
//
// A face plate is painted WHOLE into its canvas texture, background and label
// together, and its material carries no tint. That is the fix, not a tidy-up. A
// MeshBasicMaterial's `color` MULTIPLIES its map, and the label canvas was
// cleared to rgba(0,0,0,0) with `transparent: false`, so the alpha was discarded
// and every face rendered as texRGB x COLOR_FACE: solid black where the canvas
// was clear, and #cdd4de x #2b313c, about #222934, where the text was. Near-black
// text on black. Multiplying can only ever darken, so no choice of label colour
// could have rescued it; the tint had to go.
//
// The other two were the rest of the same complaint. The filler cube under the
// plates was 0x161a20, near-black, so the gaps between plates read as holes
// rather than as a cube. The wireframe was 0x05070a: a black outline around a
// dark cube on a dark viewport draws nothing at all.
export const COLOR_FACE = 0x2b313c;
/** The filler cube under the plates. Light enough to read as one solid object. */
export const COLOR_BODY = 0x39414f;
/** The wireframe silhouette. Light enough to be a silhouette. */
export const COLOR_OUTLINE = 0x6b7686;
const COLOR_EDGE = 0x3a4250;

/** Label ink on an unhovered face, and on a hovered one, which is filled with
 *  the accent and needs dark ink to stay readable. */
export const LABEL_INK = "#e8edf5";
export const LABEL_INK_HOVER = "#10141a";

/** The edge and corner nubs were opacity 0 until hovered, which is to say
 *  invisible: nothing on screen said they could be clicked at all. Quiet, but
 *  present. */
export const NUB_IDLE_OPACITY = 0.35;
export const NUB_HOVER_OPACITY = 0.95;

/** Hover colours come from the theme's accent, so hovering a cube face reads the
 *  same as hovering anything else in the viewport. Read per call rather than
 *  captured: the theme can change while the app is running. */
const faceHover = () => themeColor("--accent", 0xff7a3c);
const edgeHover = () => themeColor("--accent-hot", 0xff9a5c);

/** `#rrggbb` for a canvas fill, from a three.js hex. */
function hex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

type PartKind = "face" | "edge" | "corner";
interface Part {
  kind: PartKind;
  side?: ViewCubeSide; // faces only
  // the view direction (eye - target) this part orients the camera to
  dir: THREE.Vector3;
  up: THREE.Vector3;
  mesh: THREE.Mesh;
  baseColor: number;
  hoverColor: number;
}

export interface ViewCubeHooks {
  /** apply a face side's view (honoring overrides), left-click a face. */
  applySide(side: ViewCubeSide): void;
  /** apply an arbitrary diagonal view direction (corners/edges). */
  applyDir(dir: THREE.Vector3, up: THREE.Vector3): void;
  /** current overrides (for marking redefined sides). */
  getOverrides(): Partial<Record<ViewCubeSide, ViewOverride>>;
  /** begin "redefine this side from a model face" pick mode. */
  beginSetOverride(side: ViewCubeSide): void;
  /** clear a side's override (back to default orientation). */
  resetOverride(side: ViewCubeSide): void;
}

export class ViewCube {
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private group = new THREE.Group(); // the cube; its quaternion = inverse main-camera orientation
  private parts: Part[] = [];
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hovered: Part | null = null;
  private faceTextures = new Map<ViewCubeSide, { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture }>();

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: THREE.WebGLRenderer,
    private hooks: ViewCubeHooks,
  ) {
    // orthographic so the cube doesn't distort; framed a touch larger than the
    // cube's corner-to-corner extent (√3·HALF ≈ 0.87) for padding.
    const r = 1.15;
    this.camera = new THREE.OrthographicCamera(-r, r, r, -r, 0.01, 100);
    this.camera.position.set(0, 0, 6); // looks down -Z at the group (screen space)
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(2, 3, 4);
    this.scene.add(dir);

    this.scene.add(this.group);
    this.buildCube();
    this.installPointer();
  }

  // ---- geometry -----------------------------------------------------------

  private buildCube() {
    // six faces, thin plates inset slightly so edges/corners sit proud and the
    // outline reads cleanly. Each face carries a canvas-texture label.
    for (const side of Object.keys(FACE_VIEWS) as ViewCubeSide[]) {
      const f = FACE_VIEWS[side];
      const tex = this.makeLabelTexture(side);
      const geo = new THREE.PlaneGeometry(0.78, 0.78);
      // No tint: the plate's canvas already holds its final colours (see the
      // COLOR_FACE note, a tint here multiplies the map and can only darken).
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: false });
      const mesh = new THREE.Mesh(geo, mat);
      // orient the plate so its +Z points along the face normal, at the surface
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.normal);
      mesh.position.copy(f.normal).multiplyScalar(HALF + 0.001);
      this.group.add(mesh);
      this.parts.push({
        kind: "face",
        side,
        dir: f.normal.clone(),
        up: f.up.clone(),
        mesh,
        baseColor: COLOR_FACE,
        hoverColor: faceHover(),
      });
    }

    // a solid filler cube under the plates so the body looks solid + occludes
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.97, 0.97, 0.97),
      new THREE.MeshBasicMaterial({ color: COLOR_BODY }),
    );
    this.group.add(body);

    // edges (12) and corners (8): small clickable nubs for diagonal views.
    for (const dir of edgeDirs()) {
      this.addNub("edge", dir, 0.16, COLOR_EDGE, edgeHover());
    }
    for (const dir of cornerDirs()) {
      this.addNub("corner", dir, 0.18, COLOR_EDGE, edgeHover());
    }

    // crisp wireframe outline around the cube
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: COLOR_OUTLINE }),
    );
    this.group.add(outline);
  }

  private addNub(kind: "edge" | "corner", dir: THREE.Vector3, s: number, base: number, hover: number) {
    const geo = new THREE.BoxGeometry(s, s, s);
    const mat = new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: NUB_IDLE_OPACITY });
    const mesh = new THREE.Mesh(geo, mat);
    // place at the cube surface in the direction's components (±HALF per nonzero axis)
    mesh.position.set(
      Math.sign(dir.x) * HALF,
      Math.sign(dir.y) * HALF,
      Math.sign(dir.z) * HALF,
    );
    this.group.add(mesh);
    const up = dir.z !== 0 && dir.x === 0 && dir.y === 0
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
    this.parts.push({
      kind,
      dir: dir.clone().normalize(),
      up,
      mesh,
      baseColor: base,
      hoverColor: hover,
    });
  }

  private makeLabelTexture(side: ViewCubeSide): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    this.faceTextures.set(side, { canvas, texture: tex });
    this.paintLabel(side, false);
    return tex;
  }

  private paintLabel(side: ViewCubeSide, redefined: boolean, hovered = false) {
    const entry = this.faceTextures.get(side);
    if (!entry) return;
    const { canvas, texture } = entry;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    // Fill the plate OPAQUELY. The material no longer tints the map, so what is
    // painted here is exactly what is seen; hover swaps the fill for the accent
    // and the ink for something readable on it, rather than multiplying a colour
    // over the top, which could only darken.
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = hovered ? hex(faceHover()) : hex(COLOR_FACE);
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = hovered ? LABEL_INK_HOVER : LABEL_INK;
    ctx.font = "600 56px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(FACE_VIEWS[side].label, W / 2, W / 2);
    if (redefined) {
      // small accent dot marking a user-redefined side
      ctx.beginPath();
      ctx.fillStyle = hovered ? LABEL_INK_HOVER : hex(faceHover());
      ctx.arc(W / 2, W * 0.78, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    texture.needsUpdate = true;
  }

  /** Repaint one face from the CURRENT hover and override state. */
  private repaintFace(side: ViewCubeSide, hovered: boolean) {
    this.paintLabel(side, !!this.hooks.getOverrides()[side], hovered);
  }

  /** refresh the "redefined" markers on faces (call when overrides change). */
  refreshOverrideMarks() {
    const ov = this.hooks.getOverrides();
    for (const side of Object.keys(FACE_VIEWS) as ViewCubeSide[]) {
      this.paintLabel(side, !!ov[side], this.hovered?.side === side);
    }
  }

  // ---- per-frame render ----------------------------------------------------

  /** Sync cube orientation to the main camera and draw it into the corner. */
  render(mainCamera: THREE.Camera) {
    // the cube should mirror the camera's orientation: rotate the cube by the
    // INVERSE of the camera's world rotation so "looking from +Y" shows the BACK
    // face, etc. Equivalent: cube.quaternion = inverse(camera.quaternion).
    this.group.quaternion.copy(mainCamera.quaternion).invert();

    const rect = this.canvas.getBoundingClientRect();
    // NOTE: renderer.setViewport/setScissor take CSS pixels and apply the
    // renderer's pixelRatio internally, so we must NOT pre-multiply by it here.
    // (Doing so applied pixelRatio twice, leaving a dpr²-sized viewport set for
    // the next main render → the whole model rendered offset/oversized on any
    // HiDPI / fractional-scaled display. Invisible at dpr=1.)
    const x = rect.width - SIZE - MARGIN;
    const y = rect.height - SIZE - MARGIN; // WebGL viewport origin is bottom-left

    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setViewport(x, y, SIZE, SIZE);
    this.renderer.setScissor(x, y, SIZE, SIZE);
    this.renderer.setScissorTest(true);
    this.renderer.clearDepth(); // draw the cube over the main scene
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
    this.renderer.autoClear = prevAutoClear;
    // restore the full viewport for the next main render (CSS px; pixelRatio
    // is applied by setViewport itself).
    this.renderer.setViewport(0, 0, rect.width, rect.height);
  }

  // ---- pointer interaction -------------------------------------------------

  /** Is (clientX,clientY) inside the cube's corner box? Used by the Viewport to
   *  decide whether a click belongs to the cube or the model. */
  hitsRegion(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const left = rect.right - SIZE - MARGIN;
    const top = rect.top + MARGIN;
    return (
      clientX >= left && clientX <= left + SIZE && clientY >= top && clientY <= top + SIZE
    );
  }

  private installPointer() {
    // hover highlight (only when over the corner box)
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.hitsRegion(e.clientX, e.clientY)) {
        this.setHover(null);
        return;
      }
      this.setHover(this.pick(e.clientX, e.clientY));
    });
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    // left click handled by the Viewport (it routes via onLeftClick) so it can
    // also suppress model picking; right-click context menu is owned here.
    this.canvas.addEventListener("contextmenu", (e) => {
      if (!this.hitsRegion(e.clientX, e.clientY)) return;
      const part = this.pick(e.clientX, e.clientY);
      if (part?.kind === "face" && part.side) {
        e.preventDefault();
        this.openMenu(e.clientX, e.clientY, part.side);
      }
    });
  }

  /** Called by the Viewport on a left-click that landed in the cube region.
   *  Returns true if the cube consumed it (so the model picker should skip). */
  handleLeftClick(clientX: number, clientY: number): boolean {
    if (!this.hitsRegion(clientX, clientY)) return false;
    const part = this.pick(clientX, clientY);
    if (!part) return false;
    if (part.kind === "face" && part.side) this.hooks.applySide(part.side);
    else this.hooks.applyDir(part.dir, part.up);
    return true;
  }

  private pick(clientX: number, clientY: number): Part | null {
    const rect = this.canvas.getBoundingClientRect();
    const left = rect.right - SIZE - MARGIN;
    const top = rect.top + MARGIN;
    // NDC within the corner box
    this.ndc.set(
      ((clientX - left) / SIZE) * 2 - 1,
      -((clientY - top) / SIZE) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const meshes = this.parts.map((p) => p.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    const hit = hits[0];
    if (!hit) return null;
    const mesh = hit.object;
    return this.parts.find((p) => p.mesh === mesh) ?? null;
  }

  private setHover(part: Part | null) {
    if (part === this.hovered) return;
    if (this.hovered) {
      const m = this.hovered.mesh.material as THREE.MeshBasicMaterial;
      if (this.hovered.kind === "face" && this.hovered.side) {
        // A face repaints its CANVAS. Tinting the material would multiply the
        // map and could only darken it, which is the whole fault this change is
        // about; the nubs have no map and are tinted as before.
        this.repaintFace(this.hovered.side, false);
      } else {
        m.color.setHex(this.hovered.baseColor);
        m.opacity = NUB_IDLE_OPACITY;
      }
    }
    this.hovered = part;
    if (part) {
      const m = part.mesh.material as THREE.MeshBasicMaterial;
      if (part.kind === "face" && part.side) {
        this.repaintFace(part.side, true);
      } else {
        m.color.setHex(part.hoverColor);
        m.opacity = NUB_HOVER_OPACITY;
      }
      this.canvas.style.cursor = "pointer";
    } else {
      this.canvas.style.cursor = "";
    }
  }

  // ---- right-click context menu -------------------------------------------

  // This used to be a near-duplicate of the context-menu engine: its own body
  // portal, its own deferred document pointerdown/keydown dismissers, and a
  // cleanup function monkey-patched onto the element as `_cleanup`. It now pops
  // the one shared menu, so overflow flipping, Escape handling that doesn't also
  // clear the app selection, and "opening one closes the other" all come for
  // free, and ~60 lines of duplicated dismissal bookkeeping are gone.
  private openMenu(clientX: number, clientY: number, side: ViewCubeSide) {
    const has = !!this.hooks.getOverrides()[side];
    contextMenu(clientX, clientY, [
      {
        label: `Set "${FACE_VIEWS[side].label}" from face…`,
        onClick: () => this.hooks.beginSetOverride(side),
      },
      {
        label: "Reset to default",
        disabled: !has,
        onClick: () => {
          this.hooks.resetOverride(side);
          this.refreshOverrideMarks();
        },
      },
    ]);
  }

}

// the 12 edge midpoint directions (two nonzero ±1 components)
function edgeDirs(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const ax = [-1, 1];
  for (const a of ax) for (const b of ax) {
    out.push(new THREE.Vector3(a, b, 0));
    out.push(new THREE.Vector3(a, 0, b));
    out.push(new THREE.Vector3(0, a, b));
  }
  return out;
}

// the 8 corner directions (all three components ±1)
function cornerDirs(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    out.push(new THREE.Vector3(x, y, z));
  }
  return out;
}
