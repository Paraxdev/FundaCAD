// Drawn as a second scene into a scissored corner after the main render. Right click on a face redefines
// that side from a model face, overrides reach the document through ViewCubeHooks.

import * as THREE from "three";
import type { StandardView } from "./cameras";
import type { ViewCubeSide, ViewOverride } from "../types";
import { contextMenu } from "../ui/menu";
import { themeColor } from "./themeColors";
import { hitScale } from "../input/pointerKind";

const SIZE = 120; // corner viewport, CSS px
const MARGIN = 14; // gap from the top-right edge
/** Pixel radii of the extra samples a finger's pick tries around the touch. */
const CUBE_PROBE_RINGS_PX = [6, 12];
const HALF = 0.5; // half-extent of the unit cube

// Default view direction (eye relative to target) and up of each side, Z up.
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

// A face plate is painted whole into its canvas and its material is untinted: `color` multiplies the map and
// can only darken it, which once made every label near black on black. Colours are read per call for theme changes.
const faceFill = () => themeColor("--raised-2", 0x2b313c);
/** A shade off the face fill so gaps between plates read as one solid object. */
const bodyFill = () => themeColor("--raised", 0x39414f);
/** The wireframe silhouette. */
const outlineFill = () => themeColor("--line-strong", 0x6b7686);
const edgeFill = () => themeColor("--line-strong", 0x3a4250);

/** A hovered face is filled with the accent and needs dark ink. */
const inkFill = () => themeColor("--text", 0xe8edf5);
const inkHoverFill = () => themeColor("--on-accent", 0x10141a);

/** Idle nubs stay faintly visible so they read as clickable. */
export const NUB_IDLE_OPACITY = 0.35;
export const NUB_HOVER_OPACITY = 0.95;

const faceHover = () => themeColor("--accent", 0xff7a3c);
const edgeHover = () => themeColor("--accent-hot", 0xff9a5c);

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
  /** Honors the side's override. */
  applySide(side: ViewCubeSide): void;
  /** Corners and edges. */
  applyDir(dir: THREE.Vector3, up: THREE.Vector3): void;
  getOverrides(): Partial<Record<ViewCubeSide, ViewOverride>>;
  /** Starts the pick mode that redefines this side from a model face. */
  beginSetOverride(side: ViewCubeSide): void;
  resetOverride(side: ViewCubeSide): void;
  /** Hover changed the cube's look, the canvas needs a frame. */
  redraw?(): void;
}

export class ViewCube {
  /** CSS px kept clear on the right, for the floating controls column. */
  rightInset = 0;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private group = new THREE.Group(); // the cube; its quaternion = inverse main-camera orientation
  private parts: Part[] = [];
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hovered: Part | null = null;
  private faceTextures = new Map<ViewCubeSide, { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture }>();
  private bodyMesh!: THREE.Mesh;
  private outlineMesh!: THREE.LineSegments;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: THREE.WebGLRenderer,
    private hooks: ViewCubeHooks,
  ) {
    // Framed a little past the cube's half diagonal (√3·HALF ≈ 0.87).
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

  private buildCube() {
    // Plates inset slightly so the edge and corner nubs sit proud.
    for (const side of Object.keys(FACE_VIEWS) as ViewCubeSide[]) {
      const f = FACE_VIEWS[side];
      const tex = this.makeLabelTexture(side);
      const geo = new THREE.PlaneGeometry(0.78, 0.78);
      // No tint, see faceFill.
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.normal);
      mesh.position.copy(f.normal).multiplyScalar(HALF + 0.001);
      this.group.add(mesh);
      this.parts.push({
        kind: "face",
        side,
        dir: f.normal.clone(),
        up: f.up.clone(),
        mesh,
        baseColor: faceFill(),
        hoverColor: faceHover(),
      });
    }

    // Filler under the plates so the body looks solid and occludes.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.97, 0.97, 0.97),
      new THREE.MeshBasicMaterial({ color: bodyFill() }),
    );
    this.group.add(body);
    this.bodyMesh = body;

    for (const dir of edgeDirs()) {
      this.addNub("edge", dir, 0.16, edgeFill(), edgeHover());
    }
    for (const dir of cornerDirs()) {
      this.addNub("corner", dir, 0.18, edgeFill(), edgeHover());
    }

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: outlineFill() }),
    );
    this.group.add(outline);
    this.outlineMesh = outline;
  }

  private addNub(kind: "edge" | "corner", dir: THREE.Vector3, s: number, base: number, hover: number) {
    const geo = new THREE.BoxGeometry(s, s, s);
    const mat = new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: NUB_IDLE_OPACITY });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(Math.sign(dir.x) * HALF, Math.sign(dir.y) * HALF, Math.sign(dir.z) * HALF);
    this.group.add(mesh);
    const up = dir.z !== 0 && dir.x === 0 && dir.y === 0 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
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
    // Painted opaque and final, hover swaps fill and ink rather than tinting.
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = hovered ? hex(faceHover()) : hex(faceFill());
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = hovered ? hex(inkHoverFill()) : hex(inkFill());
    ctx.font = "600 56px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(FACE_VIEWS[side].label, W / 2, W / 2);
    if (redefined) {
      ctx.beginPath();
      ctx.fillStyle = hovered ? hex(inkHoverFill()) : hex(faceHover());
      ctx.arc(W / 2, W * 0.78, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    texture.needsUpdate = true;
  }

  private repaintFace(side: ViewCubeSide, hovered: boolean) {
    this.paintLabel(side, !!this.hooks.getOverrides()[side], hovered);
  }

  /** Call when overrides change. */
  refreshOverrideMarks() {
    const ov = this.hooks.getOverrides();
    for (const side of Object.keys(FACE_VIEWS) as ViewCubeSide[]) {
      this.paintLabel(side, !!ov[side], this.hovered?.side === side);
    }
  }

  /** Call on a theme change, the cube cannot re-cascade CSS. A hovered nub keeps its colour until setHover
   *  restores it on leave. */
  applyTheme() {
    (this.bodyMesh.material as THREE.MeshBasicMaterial).color.setHex(bodyFill());
    (this.outlineMesh.material as THREE.LineBasicMaterial).color.setHex(outlineFill());
    for (const part of this.parts) {
      part.baseColor = part.kind === "face" ? faceFill() : edgeFill();
      part.hoverColor = part.kind === "face" ? faceHover() : edgeHover();
      if (part.kind !== "face" && part !== this.hovered) {
        (part.mesh.material as THREE.MeshBasicMaterial).color.setHex(part.baseColor);
      }
    }
    this.refreshOverrideMarks();
  }

  render(mainCamera: THREE.Camera) {
    // Inverse of the camera rotation, so looking from +Y shows the BACK face.
    this.group.quaternion.copy(mainCamera.quaternion).invert();

    const rect = this.canvas.getBoundingClientRect();
    // setViewport and setScissor take CSS px and apply pixelRatio themselves, pre-multiplying left
    // the next main render offset and oversized on HiDPI.
    const x = rect.width - SIZE - MARGIN - this.rightInset;
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
    // The next main render expects the full viewport.
    this.renderer.setViewport(0, 0, rect.width, rect.height);
  }

  hitsRegion(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const left = rect.right - SIZE - MARGIN - this.rightInset;
    const top = rect.top + MARGIN;
    return clientX >= left && clientX <= left + SIZE && clientY >= top && clientY <= top + SIZE;
  }

  private installPointer() {
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.hitsRegion(e.clientX, e.clientY)) {
        this.setHover(null);
        return;
      }
      this.setHover(this.pick(e.clientX, e.clientY));
    });
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    // Left click arrives through handleLeftClick, so the Viewport can also skip model picking.
    this.canvas.addEventListener("contextmenu", (e) => {
      if (!this.hitsRegion(e.clientX, e.clientY)) return;
      const part = this.pick(e.clientX, e.clientY);
      if (part?.kind === "face" && part.side) {
        e.preventDefault();
        this.openMenu(e.clientX, e.clientY, part.side);
      }
    });
  }

  /** True when the cube consumed the click, so the model picker skips it. */
  handleLeftClick(clientX: number, clientY: number): boolean {
    if (!this.hitsRegion(clientX, clientY)) return false;
    const part = this.pick(clientX, clientY);
    if (!part) return false;
    if (part.kind === "face" && part.side) this.hooks.applySide(part.side);
    else this.hooks.applyDir(part.dir, part.up);
    return true;
  }

  /** For a finger, a miss also tries two rings of pixels around it, nearest first, since a nub is a few
   *  pixels across and a fingertip is not. */
  private pick(clientX: number, clientY: number): Part | null {
    const part = this.pickExact(clientX, clientY);
    if (part || hitScale() === 1) return part;
    for (const r of CUBE_PROBE_RINGS_PX) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const p = this.pickExact(clientX + r * Math.cos(a), clientY + r * Math.sin(a));
        if (p) return p;
      }
    }
    return null;
  }

  private pickExact(clientX: number, clientY: number): Part | null {
    const rect = this.canvas.getBoundingClientRect();
    const left = rect.right - SIZE - MARGIN - this.rightInset;
    const top = rect.top + MARGIN;
    // NDC within the corner box
    this.ndc.set(((clientX - left) / SIZE) * 2 - 1, -((clientY - top) / SIZE) * 2 + 1);
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
        // A face repaints its canvas, a tint would multiply the map. The nubs have no map.
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
    this.hooks.redraw?.();
  }

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

function edgeDirs(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const ax = [-1, 1];
  for (const a of ax)
    for (const b of ax) {
      out.push(new THREE.Vector3(a, b, 0));
      out.push(new THREE.Vector3(a, 0, b));
      out.push(new THREE.Vector3(0, a, b));
    }
  return out;
}

function cornerDirs(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1]) {
        out.push(new THREE.Vector3(x, y, z));
      }
  return out;
}
