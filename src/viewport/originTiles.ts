// The origin planes as small tiles, one per quadrant so they never cross. A press is matched
// on screen by planeHit.ts, so a tile seen edge on is still found by its pad or its name.

import * as THREE from "three";
import { glyphScale, glyphWorldScale } from "./gizmoScale";
import { AXIS_COLOR } from "./originTriad";
import { SQUIRCLE_EXPONENT, roundedSquare, type Vec2 } from "./cornerProfile";
import { themeColor } from "./themeColors";
import { pickPlaneOnScreen, placeLabels, type P2, type PlaneHit, type PlaneOnScreen } from "./planeHit";
import type { Plane3 } from "../types";

type Sign = 1 | -1;
type Axis = "x" | "y" | "z";
export type Vec3 = [number, number, number];
export interface Octant {
  x: Sign;
  y: Sign;
  z: Sign;
}
export interface TileShape {
  sizePx: number;
  gapPx: number;
  /** The corner's leg from the vertex, as a CSS `border-radius`. */
  radiusPx: number;
  exponent: number;
  octant: Octant;
}
export type TileState = "idle" | "dim" | "hot";
export interface TilePose {
  centre: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

// The app's own squircle tiles scaled up from a 40 px rail tile with its 17 px corner and 6 px gap.
export const TILE_SIZE_PX = 68;
export const TILE_GAP_PX = 10;
export const TILE_CORNER_RADIUS_PX = 29;
/** The octant the home view looks into, so no tile hides another from there.
 *  { x: -1, y: 1, z: -1 } is the same corner seen from outside. */
export const TILE_OCTANT: Octant = { x: 1, y: -1, z: 1 };
export const TILE_EXTENT_PX = TILE_GAP_PX + TILE_SIZE_PX;
/** The tiles are click targets, so they stop shrinking at 41 px, about a rail tile. */
export const MIN_TILE_SCALE = 0.6;
export const CORNER_SEGMENTS = 24;
export const RIM_PX = 1.5;
export const RIM_INK_MIX = 0.4;
export const TILE_LOOK: Record<TileState, { fill: number; rim: number; label: number }> = {
  idle: { fill: 0.16, rim: 0.65, label: 0.8 },
  dim: { fill: 0.12, rim: 0.45, label: 0.6 },
  hot: { fill: 0.32, rim: 1, label: 1 },
};
export const LABEL_FONT_PX = 11;
export const LABEL_BOX_PX = { w: 28, h: 16 } as const;
/** The hovered name grows by this much, so hover shows which plane a press takes even edge on. */
export const LABEL_HOT_SCALE = 1.2;
const LABEL_DPR = 4;
const LABEL_FONT = `700 ${LABEL_FONT_PX * LABEL_DPR}px "Space Grotesk", Inter, system-ui, sans-serif`;
/** What a body hides keeps this share of the fill. */
export const GHOST_SHARE = 0.4;
export const TILE_ORDER = { ghost: 950, fill: 951, rim: 952, label: 953 } as const;

export const TILE_SHAPE: TileShape = {
  sizePx: TILE_SIZE_PX,
  gapPx: TILE_GAP_PX,
  radiusPx: TILE_CORNER_RADIUS_PX,
  exponent: SQUIRCLE_EXPONENT,
  octant: TILE_OCTANT,
};

const PLANES: Plane3[] = ["XY", "XZ", "YZ"];
const SPAN: Record<Plane3, [Axis, Axis]> = { XY: ["x", "y"], XZ: ["x", "z"], YZ: ["y", "z"] };
const UNIT: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** A plane takes the colour of its normal axis, as the triad reads. */
const TILE_COLOR: Record<Plane3, number> = { XY: AXIS_COLOR.z, XZ: AXIS_COLOR.y, YZ: AXIS_COLOR.x };
const NOIR_TEXT = 0xf6f0e4;
const NOIR_GROUND = 0x0b0912;

/** -0 becomes 0. */
const tidy = (n: number) => n + 0;

export function tilePose(plane: Plane3, shape: TileShape): TilePose {
  const [a, b] = SPAN[plane];
  const u = UNIT[a];
  const v = UNIT[b];
  const off = shape.gapPx + shape.sizePx / 2;
  const su = shape.octant[a] * off;
  const sv = shape.octant[b] * off;
  const centre = [0, 1, 2].map((i) => tidy(u[i]! * su + v[i]! * sv)) as Vec3;
  const normal: Vec3 = [
    tidy(u[1] * v[2] - u[2] * v[1]),
    tidy(u[2] * v[0] - u[0] * v[2]),
    tidy(u[0] * v[1] - u[1] * v[0]),
  ];
  return { centre, u: [u[0], u[1], u[2]], v: [v[0], v[1], v[2]], normal };
}

export function tileStates(hovered: Plane3 | null): Record<Plane3, TileState> {
  const s = (k: Plane3): TileState => (hovered === null ? "idle" : k === hovered ? "hot" : "dim");
  return { XY: s("XY"), XZ: s("XZ"), YZ: s("YZ") };
}

/** The canvas rectangle in client pixels and the camera drawing it. */
export interface ScreenFrame {
  camera: THREE.Camera;
  rect: { left: number; top: number; width: number; height: number };
}

const PICK_SEGMENTS = 4;

function toScreen(v: THREE.Vector3, f: ScreenFrame): P2 {
  const n = v.clone().project(f.camera);
  return { x: (n.x * 0.5 + 0.5) * f.rect.width + f.rect.left, y: (-n.y * 0.5 + 0.5) * f.rect.height + f.rect.top };
}

export function mixHex(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

function luminance(hex: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((hex >> 16) & 0xff) + 0.7152 * lin((hex >> 8) & 0xff) + 0.0722 * lin(hex & 0xff);
}

export function contrast(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ground drawn can be a fixed render ground that ignores the theme, so the
 *  name takes whichever of `--text` and `--viewport-bg` reads on it. */
export function labelInk(ground: number, text: number, viewportBg: number): number {
  return contrast(text, ground) >= contrast(viewportBg, ground) ? text : viewportBg;
}

function shapeOf(pts: Vec2[]): THREE.Shape {
  return new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
}

function outline(shape: TileShape, inset = 0): Vec2[] {
  return roundedSquare(shape.sizePx - 2 * inset, shape.radiusPx - inset, shape.exponent, CORNER_SEGMENTS);
}

function fillGeometry(shape: TileShape): THREE.BufferGeometry {
  return new THREE.ShapeGeometry(shapeOf(outline(shape)));
}

function rimGeometry(shape: TileShape): THREE.BufferGeometry {
  const ring = shapeOf(outline(shape));
  ring.holes.push(new THREE.Path(outline(shape, RIM_PX).map(([x, y]) => new THREE.Vector2(x, y))));
  return new THREE.ShapeGeometry(ring);
}

interface Tile {
  fill: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  ghost: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  rim: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  label: THREE.Sprite;
}

function tileMaterial(color: number, depthTest: boolean): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    side: THREE.DoubleSide,
    depthTest,
    depthWrite: false,
    // The XY tile lies in the plane of a part's floor, seen from below; the offset wins it that tie.
    ...(depthTest ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 } : {}),
  });
}

export class OriginTiles {
  readonly group = new THREE.Group();
  readonly planes: Record<Plane3, THREE.Mesh>;
  private shape: TileShape;
  private readonly tiles: Record<Plane3, Tile>;
  private states = tileStates(null);
  private labelsPainted = false;
  private k = 1;
  private ink = NOIR_TEXT;

  constructor(scene: THREE.Scene, shape: Partial<TileShape> = {}) {
    this.shape = { ...TILE_SHAPE, ...shape };
    const make = (k: Plane3): Tile => {
      const fill = new THREE.Mesh(fillGeometry(this.shape), tileMaterial(TILE_COLOR[k], true));
      fill.userData.plane = k;
      fill.renderOrder = TILE_ORDER.fill;
      fill.visible = false;
      // Drawn through whatever is in front, so a tile inside or behind a part is still found.
      const ghost = new THREE.Mesh(fill.geometry, tileMaterial(TILE_COLOR[k], false));
      ghost.userData.role = "ghost";
      ghost.renderOrder = TILE_ORDER.ghost;
      const rim = new THREE.Mesh(rimGeometry(this.shape), tileMaterial(TILE_COLOR[k], true));
      rim.userData.role = "rim";
      rim.renderOrder = TILE_ORDER.rim;
      const label = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: new THREE.Texture(),
          transparent: true,
          depthTest: false,
          depthWrite: false,
        }),
      );
      label.userData.role = "label";
      label.renderOrder = TILE_ORDER.label;
      label.scale.set(LABEL_BOX_PX.w, LABEL_BOX_PX.h, 1);
      fill.add(ghost, rim, label);
      this.group.add(fill);
      return { fill, ghost, rim, label };
    };
    this.tiles = { XY: make("XY"), XZ: make("XZ"), YZ: make("YZ") };
    this.planes = { XY: this.tiles.XY.fill, XZ: this.tiles.XZ.fill, YZ: this.tiles.YZ.fill };
    this.pose();
    this.paintLook();
    this.applyTheme(themeColor("--viewport-bg", NOIR_GROUND));
    scene.add(this.group);
  }

  reshape(shape: Partial<TileShape>) {
    this.shape = { ...this.shape, ...shape };
    for (const k of PLANES) {
      const t = this.tiles[k];
      t.fill.geometry.dispose();
      t.rim.geometry.dispose();
      t.fill.geometry = fillGeometry(this.shape);
      t.ghost.geometry = t.fill.geometry;
      t.rim.geometry = rimGeometry(this.shape);
    }
    this.pose();
  }

  setShown(on: boolean) {
    for (const k of PLANES) this.tiles[k].fill.visible = on;
    this.states = tileStates(null);
    this.paintLook();
    if (on) this.paintLabels();
  }

  hover(kind: Plane3 | null) {
    this.states = tileStates(kind);
    this.paintLook();
  }

  /** `pixelWorldSize` is the world size of one screen pixel at the origin. With `rect`, the canvas in client
   *  pixels, each name is placed on screen where `placeLabels` puts it. */
  update(
    pixelWorldSize: number | null,
    modelDiagonal: number | null,
    camera: THREE.Camera,
    rect?: ScreenFrame["rect"],
  ) {
    const extent = this.shape.gapPx + this.shape.sizePx;
    this.k = glyphScale(extent, modelDiagonal, pixelWorldSize, MIN_TILE_SCALE);
    this.group.scale.setScalar(glyphWorldScale(extent, modelDiagonal, pixelWorldSize, MIN_TILE_SCALE));
    if (rect && rect.width > 0 && rect.height > 0 && this.group.scale.x > 0) this.placeNames({ camera, rect });
    this.paintLook();
  }

  /** Each tile as drawn, in client pixels. */
  onScreen(frame: ScreenFrame): PlaneOnScreen[] {
    frame.camera.updateMatrixWorld();
    this.group.updateMatrixWorld(true);
    const cam = frame.camera;
    const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
    const eyeDir = cam.getWorldDirection(new THREE.Vector3()).negate();
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const ring = roundedSquare(this.shape.sizePx, this.shape.radiusPx, this.shape.exponent, PICK_SEGMENTS);
    const h = this.shape.sizePx / 2;
    return PLANES.map((plane) => {
      const m = this.tiles[plane].fill.matrixWorld;
      const at = (x: number, y: number) => toScreen(new THREE.Vector3(x, y, 0).applyMatrix4(m), frame);
      const centreW = new THREE.Vector3().applyMatrix4(m);
      const centre = toScreen(centreW, frame);
      const u = at(h, 0);
      const v = at(0, h);
      const normal = new THREE.Vector3(...tilePose(plane, this.shape).normal);
      const toEye = ortho ? eyeDir : eye.clone().sub(centreW).normalize();
      return {
        plane,
        centre,
        outline: ring.map(([x, y]) => at(x, y)),
        su: { x: u.x - centre.x, y: u.y - centre.y },
        sv: { x: v.x - centre.x, y: v.y - centre.y },
        facing: Math.abs(toEye.dot(normal)),
      };
    });
  }

  /** Where each name is drawn, in client pixels. */
  labelsOnScreen(frame: ScreenFrame, tiles = this.onScreen(frame)): Record<string, P2> {
    return placeLabels(tiles, LABEL_BOX_PX);
  }

  /** The plane a press at client (`x`, `y`) takes, null while the tiles are hidden. */
  pick(x: number, y: number, frame: ScreenFrame, minPx: number): PlaneHit | null {
    if (!this.tiles.XY.fill.visible || this.group.scale.x <= 0) return null;
    const tiles = this.onScreen(frame);
    return pickPlaneOnScreen(tiles, this.labelsOnScreen(frame, tiles), { x, y }, minPx, LABEL_BOX_PX);
  }

  private placeNames(frame: ScreenFrame) {
    const tiles = this.onScreen(frame);
    const at = this.labelsOnScreen(frame, tiles);
    const { left, top, width, height } = frame.rect;
    for (const p of PLANES) {
      const fill = this.tiles[p].fill;
      const ndcZ = new THREE.Vector3().applyMatrix4(fill.matrixWorld).project(frame.camera).z;
      const s = at[p]!;
      const world = new THREE.Vector3(
        ((s.x - left) / width) * 2 - 1,
        -(((s.y - top) / height) * 2 - 1),
        ndcZ,
      ).unproject(frame.camera);
      this.tiles[p].label.position.copy(fill.worldToLocal(world));
    }
  }

  /** `ground` is the colour actually drawn behind the tiles. */
  applyTheme(ground: number) {
    this.ink = labelInk(ground, themeColor("--text", NOIR_TEXT), themeColor("--viewport-bg", NOIR_GROUND));
    for (const k of PLANES) this.tiles[k].rim.material.color.setHex(mixHex(TILE_COLOR[k], this.ink, RIM_INK_MIX));
    this.paintLook();
  }

  dispose() {
    for (const k of PLANES) {
      const t = this.tiles[k];
      t.fill.geometry.dispose();
      t.fill.material.dispose();
      t.ghost.material.dispose();
      t.rim.geometry.dispose();
      t.rim.material.dispose();
      t.label.material.map?.dispose();
      t.label.material.dispose();
    }
    this.group.removeFromParent();
  }

  private pose() {
    const basis = new THREE.Matrix4();
    for (const k of PLANES) {
      const p = tilePose(k, this.shape);
      const fill = this.tiles[k].fill;
      fill.position.set(...p.centre);
      basis.makeBasis(new THREE.Vector3(...p.u), new THREE.Vector3(...p.v), new THREE.Vector3(...p.normal));
      fill.quaternion.setFromRotationMatrix(basis);
    }
  }

  private paintLook() {
    for (const k of PLANES) {
      const look = TILE_LOOK[this.states[k]];
      const t = this.tiles[k];
      t.fill.material.opacity = look.fill;
      t.ghost.material.opacity = look.fill * GHOST_SHARE;
      t.rim.material.opacity = look.rim;
      t.label.material.opacity = look.label;
      const hot = this.states[k] === "hot";
      // The hovered name takes its rim's colour, the only colour left of a tile seen edge on.
      t.label.material.color.setHex(hot ? t.rim.material.color.getHex() : this.ink);
      const grow = hot ? LABEL_HOT_SCALE : 1;
      t.label.scale.set((LABEL_BOX_PX.w * grow) / this.k, (LABEL_BOX_PX.h * grow) / this.k, 1);
    }
  }

  // Painted white and tinted by the material, on the first show rather than at
  // boot, so the web font has loaded; repainted until it has.
  private paintLabels() {
    if (this.labelsPainted || typeof document === "undefined") return;
    const w = LABEL_BOX_PX.w * LABEL_DPR;
    const h = LABEL_BOX_PX.h * LABEL_DPR;
    for (const k of PLANES) {
      const tex = this.tiles[k].label.material.map!;
      const canvas = (tex.image as HTMLCanvasElement | null) ?? document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#ffffff";
      ctx.font = LABEL_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(k, w / 2, h / 2);
      tex.image = canvas;
      tex.needsUpdate = true;
    }
    this.labelsPainted = document.fonts?.check(LABEL_FONT) ?? true;
  }
}
