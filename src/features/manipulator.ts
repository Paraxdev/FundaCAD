// Shared math and glyphs for the 3D manipulators. Shared, not copied, because the passive selection
// handle hands its gesture to the fillet/chamfer tool mid-press, so both must be the same handle.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { GLYPH_MODEL_FRACTION, glyphScale } from "../viewport/gizmoScale";
import { themeColor } from "../viewport/themeColors";

/** Ill-conditioned when the camera looks down the axis, use axisDragDistance for interactive drags. */
export function distanceAlongAxis(ray: THREE.Ray, origin: THREE.Vector3, dir: THREE.Vector3): number {
  const w0 = ray.origin.clone().sub(origin);
  const b = ray.direction.dot(dir);
  const d = ray.direction.dot(w0);
  const e = dir.dot(w0);
  const denom = 1 - b * b; // a=c=1 (unit vectors)
  if (Math.abs(denom) < 1e-6) return -e;
  return (e - b * d) / denom;
}

/** Robust at every view angle: looking down the axis it measures the cursor along the axis's screen
 *  projection, and with no screen extent at all vertical mouse motion drives it, up = toward the viewer. */
export function axisDragDistance(
  viewport: Viewport,
  clientX: number,
  clientY: number,
  anchor: THREE.Vector3,
  axis: THREE.Vector3,
): number {
  const ray = viewport.rayFrom(clientX, clientY).ray;
  if (Math.abs(ray.direction.dot(axis)) < 0.95) {
    return distanceAlongAxis(ray, anchor, axis);
  }
  const px = viewport.pixelWorldSize(anchor);
  const step = px * 40;
  const p0 = viewport.projectToScreen(anchor);
  const p1 = viewport.projectToScreen(anchor.clone().addScaledVector(axis, step));
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len > 6) {
    return (((clientX - p0.x) * dx + (clientY - p0.y) * dy) / len) * (step / len);
  }
  const camDir = viewport.camera.getWorldDirection(new THREE.Vector3());
  const sign = axis.dot(camDir) < 0 ? 1 : -1;
  return (p0.y - clientY) * px * sign;
}

/** The glyph is modelled along +Y; orient it with `quat.setFromUnitVectors(HANDLE_UP, axis)`. */
export const HANDLE_UP = new THREE.Vector3(0, 1, 0);

/** `perp` is only defined up to a sign. Centre to anchor picks the outward one: exact for a convex
 *  body, ambiguous only deep inside a concave pocket. */
export function orientOutward(
  perp: THREE.Vector3,
  anchor: THREE.Vector3 | null,
  centre: THREE.Vector3 | null,
): THREE.Vector3 {
  if (!anchor || !centre) return perp;
  const out = anchor.clone().sub(centre);
  if (out.lengthSq() < 1e-9) return perp;
  return perp.dot(out) < 0 ? perp.negate() : perp;
}

/** Falls back to the camera's right with no tangent or an edge pointing at the camera. The passive handle
 *  and the armed tool compute this in the same pointerdown and must agree exactly, or the handle jumps. */
export function edgeHandleAxis(
  viewport: Viewport,
  tangent: THREE.Vector3 | null,
  anchor?: THREE.Vector3 | null,
  centre?: THREE.Vector3 | null,
): THREE.Vector3 {
  const fwd = viewport.camera.getWorldDirection(new THREE.Vector3());
  if (tangent) {
    const perp = tangent.clone().cross(fwd);
    if (perp.lengthSq() > 1e-6) {
      return orientOutward(perp.normalize(), anchor ?? null, centre ?? null);
    }
  }
  const right = new THREE.Vector3().setFromMatrixColumn(viewport.camera.matrixWorld, 0).normalize();
  return orientOutward(right, anchor ?? null, centre ?? null);
}

/** Local +X along `axis` as the screen sees it, +Y up the screen, +Z out of it. Must stay right-handed:
 *  setFromRotationMatrix on a reflection yields a non-unit quaternion, and hit tests read atan2 about +Y. */
export function screenPlaneOrientation(
  forward: THREE.Vector3,
  axis: THREE.Vector3,
  fallbackRight: THREE.Vector3,
): THREE.Quaternion {
  const fwd = forward.clone().normalize();
  const back = fwd.clone().negate();
  const right = axis.clone().projectOnPlane(fwd);
  if (right.lengthSq() < 1e-9) right.copy(fallbackRight).projectOnPlane(fwd);
  // Only when the caller's right lies along the view direction; any perpendicular beats a non-basis.
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0).projectOnPlane(fwd);
  if (right.lengthSq() < 1e-9) right.set(0, 1, 0).projectOnPlane(fwd);
  right.normalize();
  // back x right: the obvious fwd x right has determinant -1.
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, back));
}

/** Sine of the angle to the view direction: 0.4 keeps ~21px of the 52px glyph and costs at most 24 degrees of lean. */
export const MIN_SCREEN_AXIS = 0.4;

/** For drawing only: tips an axis that points at the camera until `minScreen` of it shows, keeping its screen
 *  direction so an orbit leans it rather than snaps. Drag distances stay measured along the real normal. */
export function leanOutOfView(
  axis: THREE.Vector3,
  forward: THREE.Vector3,
  fallbackRight: THREE.Vector3,
  minScreen: number = MIN_SCREEN_AXIS,
): THREE.Vector3 {
  const fwd = forward.clone().normalize();
  const a = axis.clone().normalize();
  const along = a.dot(fwd);
  const flat = a.clone().addScaledVector(fwd, -along);
  if (flat.length() >= minScreen) return a;
  const dir = flat.lengthSq() > 1e-12 ? flat.normalize() : fallbackRight.clone().projectOnPlane(fwd);
  if (dir.lengthSq() < 1e-12) return a;
  dir.normalize();
  const depth = Math.sqrt(Math.max(0, 1 - minScreen * minScreen)) * (along < 0 ? -1 : 1);
  return dir.multiplyScalar(minScreen).addScaledVector(fwd, depth).normalize();
}

// Fallbacks for a headless context: each colour is read from its theme token at paint time
// (viewport/themeColors.ts) so a theme change reaches a manipulator too.

/** `--accent` */
export const HANDLE_IDLE = 0xff7a3c;
/** `--accent-hot`, for hover and grab */
export const HANDLE_HOT = 0xff9a5c;
/** `--error`, for a push that removes material rather than adding it */
export const HANDLE_CUT = 0xff5c5c;
/** `--bg`, so the handle keeps its outline against a light face. */
const HANDLE_OUTLINE = 0x0e0f12;

function idleColor() {
  return themeColor("--accent", HANDLE_IDLE);
}
function hotColor() {
  return themeColor("--accent-hot", HANDLE_HOT);
}
function cutColor() {
  return themeColor("--error", HANDLE_CUT);
}

export type HandleTone = "idle" | "cut";

export interface DragHandle {
  /** Add this to the scene; scale it by pixelWorldSize(anchor) each frame. */
  group: THREE.Group;
  /** Omitted fields keep their value. `refused` paints the error colour over hover and grab. */
  paint(opts: { hot?: boolean; tone?: HandleTone; opacity?: number; refused?: boolean }): void;
  /** Frees GPU resources; removing the group from its scene stays the caller's job. */
  dispose(): void;
}

/** (radius, height) in pixels, lathed as a polyline so the shaft steps stay sharp. Double-ended because the
 *  edge drag runs a fillet one way and a chamfer the other, through no feature at zero. */
const PROFILE: [number, number][] = [
  [0.0, 5.0], // lower point, stood off the surface so it never buries in the face
  [4.5, 14.0], // lower head, at its widest
  [1.5, 14.0], // step in to the shaft
  [1.5, 31.0], // shaft
  [4.5, 31.0], // upper head, at its widest
  [0.0, 45.0], // upper point
];

/** In profile pixels. A constant width, not a scale, so the thin shaft still gets a visible edge. */
const OUTLINE_PX = 0.9;

/** The ends extend by `k` too, so a cone's point is covered rather than poking through its outline. */
function outset(profile: [number, number][], k: number): [number, number][] {
  return profile.map(([r, y], i) => {
    const prev = profile[i - 1] ?? profile[i]!;
    const next = profile[i + 1] ?? profile[i]!;
    // Outward normal of the polyline, radial at a lone point.
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    const nx = ty / len;
    const ny = -tx / len;
    const endY = i === 0 ? -k : i === profile.length - 1 ? k : 0;
    return [Math.max(0, r + nx * k), y + ny * k + endY];
  });
}

/** The profile's last y. handleScale reads it for the size cap, so keep it in step with PROFILE. */
export const HANDLE_LENGTH = 45;

/** Grab proxy radii in pixels, deliberately larger than the drawn glyph. Three's raycaster tests layers,
 *  not `visible`, so an invisible mesh stays pickable (a test locks this down). */
const GRAB_HEAD = 17;
const GRAB_STEM = 11;

/** Shared with the origin arrows through viewport/gizmoScale.ts, so the rule cannot drift. */
export const HANDLE_MODEL_FRACTION = GLYPH_MODEL_FRACTION;

/** At 0.45 of the 45 unit glyph it is still ~20px with a ~7px grab radius; any smaller is unusable. */
export const MIN_HANDLE_SCALE = 0.45;

/** Constant screen size until the handle would exceed a fraction of the model's on-screen size, then
 *  both shrink together. Returns 1, never 0, when there is nothing to measure against. */
export function handleScale(modelDiagonal: number | null, pixelWorldSize: number | null): number {
  return glyphScale(HANDLE_LENGTH, modelDiagonal, pixelWorldSize, MIN_HANDLE_SCALE);
}

/** In screen pixels. Whatever must stand clear of the handle uses this; a guessed 64px toolbar offset
 *  left zero clearance on a fitted 40mm box. */
export function handleReachPx(modelDiagonal: number | null, pixelWorldSize: number | null): number {
  return HANDLE_LENGTH * handleScale(modelDiagonal, pixelWorldSize);
}

function lathe(profile: [number, number][]): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    28,
  );
}

/** Unlit and untoned, like its outline: the handle must show its token colour whatever lights, exposure or tone
 *  curve the scene draws with (a lit blob went missing while its outline still showed). */
function handleMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: idleColor(),
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1,
  });
}

export function createDragHandle(tone: HandleTone = "idle"): DragHandle {
  const group = new THREE.Group();
  group.renderOrder = 999;

  const body = handleMaterial();
  const geo = lathe(PROFILE);
  const blob = new THREE.Mesh(geo, body);
  blob.renderOrder = 999;

  // A back-face shell of constant width as the outline, so the handle holds its shape over a pale face.
  // Its own geometry, since a scaled copy would thin the edge to nothing on the shaft.
  const outlineMat = new THREE.MeshBasicMaterial({
    color: themeColor("--bg", HANDLE_OUTLINE),
    side: THREE.BackSide,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1,
  });
  const outlineGeo = lathe(outset(PROFILE, OUTLINE_PX));
  const outline = new THREE.Mesh(outlineGeo, outlineMat);
  outline.renderOrder = 998;

  // Direct children because every consumer hit tests intersectObjects(group.children, false).
  const hidden = new THREE.MeshBasicMaterial({ visible: false, depthTest: false });
  const grabHead = new THREE.Mesh(new THREE.SphereGeometry(GRAB_HEAD, 10, 8), hidden);
  grabHead.position.y = 38;
  const grabStem = new THREE.Mesh(new THREE.CylinderGeometry(GRAB_STEM, GRAB_STEM, 30, 8), hidden);
  grabStem.position.y = 19;

  group.add(outline, blob, grabHead, grabStem);

  let hot = false;
  let refused = false;
  let currentTone: HandleTone = tone;
  // Resolved on every repaint so a theme change reaches a handle already on screen.
  const apply = () => {
    const base = currentTone === "cut" ? cutColor() : idleColor();
    const c = refused ? cutColor() : hot ? hotColor() : base;
    body.color.set(c);
    outlineMat.color.set(themeColor("--bg", HANDLE_OUTLINE));
  };
  apply();

  return {
    group,
    paint(opts) {
      if (opts.hot !== undefined) hot = opts.hot;
      if (opts.tone !== undefined) currentTone = opts.tone;
      if (opts.refused !== undefined) refused = opts.refused;
      if (opts.hot !== undefined || opts.tone !== undefined || opts.refused !== undefined) apply();
      if (opts.opacity !== undefined) {
        body.opacity = opts.opacity;
        // At the passive handle's 55% a full-strength outline would be the loudest thing on screen.
        outlineMat.opacity = opts.opacity * 0.8;
      }
    },
    dispose() {
      geo.dispose();
      outlineGeo.dispose();
      grabHead.geometry.dispose();
      grabStem.geometry.dispose();
      body.dispose();
      outlineMat.dispose();
      hidden.dispose();
    },
  };
}

/** For the agent harness (src/harness/handles.ts), which aims at visible named objects. */
export function nameHandle<T extends DragHandle | THREE.Object3D>(h: T, name: string): T {
  const obj = h instanceof THREE.Object3D ? h : h.group;
  obj.userData.handle = name;
  return h;
}

/** In pixels, the glyph's own units. */
const ARC_RADIUS = 21;
/** Just over a third of a turn: reads as a rotation, yet sits as a cap above the straight handle. */
const ARC_SWEEP_RAD = 2.3;
/** Tube radius and cone size of the arc, in pixels. */
const ARC_TUBE = 2.4;
const ARC_HEAD_R = 5.2;
const ARC_HEAD_LEN = 10;

/** The rotation counterpart of createDragHandle, for a control that swings (an extrude's taper). Modelled in
 *  pixels in local XY centred on +Y: orient it with a full basis, scale it by pixelWorldSize. */
export function createRotationArc(
  tone: HandleTone = "idle",
  shape: { radius?: number; sweep?: number } = {},
): DragHandle {
  const r = shape.radius ?? ARC_RADIUS;
  const sweep = shape.sweep ?? ARC_SWEEP_RAD;
  const group = new THREE.Group();
  group.renderOrder = 999;
  // TorusGeometry sweeps from local +X; rotate so the sweep centres on local +Y, the axis a caller aims.
  const start = Math.PI / 2 - sweep / 2;

  const body = handleMaterial();
  const arcGeo = new THREE.TorusGeometry(r, ARC_TUBE, 10, 40, sweep);
  const arc = new THREE.Mesh(arcGeo, body);
  arc.rotation.z = start;
  arc.renderOrder = 999;

  const headGeos: THREE.ConeGeometry[] = [];
  const makeHead = (angle: number, sign: number) => {
    const g = new THREE.ConeGeometry(ARC_HEAD_R, ARC_HEAD_LEN, 12);
    headGeos.push(g);
    const m = new THREE.Mesh(g, body);
    m.position.set(Math.cos(angle) * r, Math.sin(angle) * r, 0);
    const tan = new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0).multiplyScalar(sign);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
    m.renderOrder = 999;
    return m;
  };
  const head1 = makeHead(start, -1);
  const head2 = makeHead(start + sweep, 1);

  // A direct child, so callers hit test group.children as they do the straight handle's.
  const hidden = new THREE.MeshBasicMaterial({ visible: false, depthTest: false });
  const grabGeo = new THREE.TorusGeometry(r, 9, 6, 32, sweep);
  const grab = new THREE.Mesh(grabGeo, hidden);
  grab.rotation.z = start;

  group.add(arc, head1, head2, grab);

  let hot = false;
  let refused = false;
  let currentTone: HandleTone = tone;
  const apply = () => {
    const base = currentTone === "cut" ? cutColor() : idleColor();
    const c = refused ? cutColor() : hot ? hotColor() : base;
    body.color.set(c);
  };
  apply();

  return {
    group,
    paint(opts) {
      if (opts.hot !== undefined) hot = opts.hot;
      if (opts.tone !== undefined) currentTone = opts.tone;
      if (opts.refused !== undefined) refused = opts.refused;
      if (opts.hot !== undefined || opts.tone !== undefined || opts.refused !== undefined) apply();
      if (opts.opacity !== undefined) body.opacity = opts.opacity;
    },
    dispose() {
      arcGeo.dispose();
      grabGeo.dispose();
      for (const g of headGeos) g.dispose();
      body.dispose();
      hidden.dispose();
    },
  };
}
