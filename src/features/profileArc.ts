// The profile arc: a curved slider that sets a fillet's SECTION shape while the
// radius drag stays where it is.
//
// Radius and profile are two independent things about one blend, how far it
// reaches, and how full it is, so they get two controls that can be used in
// either order without disturbing each other. The arrow answers "how big"; this
// answers "what shape", from a chamfer's flat chord (-1), through the circular
// fillet (0), to a corner barely rounded at all (+1).
//
// Everything is drawn in the screen plane at a constant pixel size, like the
// arrow handle, and for the same reason: the control must stay grabbable at any
// zoom and from any orbit. That also makes the hit test cheap, a camera-facing
// pixel-scaled arc has the same shape on screen as in its own local frame, so
// "which point of the track is the cursor nearest" is a screen-space atan2
// rather than a ray/surface intersection.

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Viewport } from "../viewport/viewport";
import { screenPlaneOrientation } from "./manipulator";
import {
  clampProfile,
  formatProfile,
  fractionFromProfile,
  profileFromFraction,
  snapProfile,
} from "./profileArcMath";
import { themeColor } from "../viewport/themeColors";

// Painted from theme tokens, with these as the headless fallback (see
// viewport/themeColors.ts). The track is deliberately a muted surface colour and
// the knob the accent: the track is a scale, the knob is the control, and every
// theme has to keep that reading.
const TRACK = 0x4b525e; // --line-strong
const TRACK_HOT = 0x6b7280; // --text-mute
const KNOB = 0xff7a3c; // --accent
const KNOB_HOT = 0xff9a5c; // --accent-hot

const trackColor = () => themeColor("--line-strong", TRACK);
const trackHotColor = () => themeColor("--text-mute", TRACK_HOT);
const knobColor = () => themeColor("--accent", KNOB);
const knobHotColor = () => themeColor("--accent-hot", KNOB_HOT);

// Pixel geometry. The radius clears the handle's tip (52px) and its grab volume
// (a 17px sphere centred at 38), so the two controls never compete for a press
// however the model is orbited.
const RADIUS = 84;
const SPAN = (110 * Math.PI) / 180;
const KNOB_R = 6.5;
const GRAB_R = 16; // invisible, generous: the visible knob is small on purpose

/** Where the track's CENTRE sits relative to the drag axis, in radians.
 *
 *  Zero: the arc is centred on the handle's own direction, so it caps the
 *  handle like a crossbar rather than floating off to one side. That is what
 *  ties the two together as one control, the profile is a property of the
 *  blend the handle is sizing, and an arc hanging off at a quarter turn read as
 *  an unrelated widget that happened to be nearby. It also puts the circular
 *  fillet (profile 0, the detent) straight above the tip, which is where the
 *  eye already is mid-drag. */
const OFFSET = 0;

export class ProfileArc {
  private group: THREE.Group | null = null;
  private track: Line2 | null = null;
  private knob: THREE.Mesh | null = null;
  private grab: THREE.Mesh | null = null;
  private label: THREE.Sprite | null = null;
  private labelTex: THREE.CanvasTexture | null = null;
  private labelCanvas: HTMLCanvasElement | null = null;

  private anchor = new THREE.Vector3();
  private axis = new THREE.Vector3(1, 0, 0);
  private profile = 0;
  private hot = false;

  constructor(private viewport: Viewport) {}

  get visible() {
    return !!this.group;
  }

  get value() {
    return this.profile;
  }

  show(anchor: THREE.Vector3, axis: THREE.Vector3, profile: number) {
    this.anchor.copy(anchor);
    this.axis.copy(axis);
    this.profile = clampProfile(profile);
    if (!this.group) this.mount();
    this.refresh();
  }

  setAnchor(anchor: THREE.Vector3, axis: THREE.Vector3) {
    this.anchor.copy(anchor);
    this.axis.copy(axis);
  }

  setProfile(p: number) {
    const v = clampProfile(p);
    if (v === this.profile) return;
    this.profile = v;
    this.refresh();
  }

  setHot(on: boolean) {
    if (on === this.hot) return;
    this.hot = on;
    const km = this.knob?.material as THREE.MeshBasicMaterial | undefined;
    km?.color.set(on ? knobHotColor() : knobColor());
    (this.track?.material as LineMaterial | undefined)?.color.set(
      on ? trackHotColor() : trackColor(),
    );
    this.viewport.requestRender();
  }

  private mount() {
    const group = new THREE.Group();
    group.renderOrder = 999;

    // The track, sampled in the group's local XY plane.
    const pts: number[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = -SPAN / 2 + SPAN * (i / 48) + OFFSET;
      pts.push(Math.cos(a) * RADIUS, Math.sin(a) * RADIUS, 0);
    }
    const geo = new LineGeometry();
    geo.setPositions(pts);
    const el = this.viewport.domElement;
    const mat = new LineMaterial({
      color: trackColor(),
      linewidth: 3,
      worldUnits: false,
      depthTest: false,
      transparent: true,
    });
    mat.resolution.set(el.clientWidth, el.clientHeight);
    const track = new Line2(geo, mat);
    track.renderOrder = 999;
    group.add(track);

    const knobMat = new THREE.MeshBasicMaterial({
      color: knobColor(),
      depthTest: false,
      depthWrite: false,
    });
    const knob = new THREE.Mesh(new THREE.SphereGeometry(KNOB_R, 20, 14), knobMat);
    knob.renderOrder = 1000;
    group.add(knob);

    // Invisible and larger: a 5px sphere is honest as a mark but miserable as a
    // target, and the alternative, a big visible knob, would swamp the arc.
    const grab = new THREE.Mesh(
      new THREE.SphereGeometry(GRAB_R, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false, depthTest: false }),
    );
    group.add(grab);

    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
    );
    sprite.renderOrder = 1001;
    group.add(sprite);

    this.group = group;
    this.track = track;
    this.knob = knob;
    this.grab = grab;
    this.label = sprite;
    this.labelTex = tex;
    this.labelCanvas = canvas;
    this.viewport.addToScene(group);
  }

  /** Redraw the readout and move the knob to the current profile. */
  private refresh() {
    const canvas = this.labelCanvas;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(19,21,26,0.88)"; // --bg, near-black graphite
      ctx.strokeStyle = "#ff7a3c"; // --accent
      ctx.lineWidth = 3;
      const w = 108;
      const h = 40;
      const x = (canvas.width - w) / 2;
      const y = (canvas.height - h) / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#e6e8ec"; // --text
      ctx.font = "600 24px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(formatProfile(this.profile), canvas.width / 2, canvas.height / 2);
    }
    if (this.labelTex) this.labelTex.needsUpdate = true;
    this.place();
    this.viewport.requestRender();
  }

  /** Put the knob and its label at the current profile's angle. */
  private place() {
    if (!this.knob || !this.grab || !this.label) return;
    const a = this.angleFor(this.profile);
    const x = Math.cos(a) * RADIUS;
    const y = Math.sin(a) * RADIUS;
    this.knob.position.set(x, y, 0);
    this.grab.position.set(x, y, 0);
    // Just outside the knob, pushed further along the same radial so the label
    // never sits between the knob and the model it is describing.
    this.label.position.set(Math.cos(a) * (RADIUS + 30), Math.sin(a) * (RADIUS + 30), 0);
    this.label.scale.set(64, 32, 1);
  }

  private angleFor(profile: number) {
    return -SPAN / 2 + SPAN * fractionFromProfile(profile) + OFFSET;
  }

  /** Per-frame: lie flat against the screen with local +X along the drag axis,
   *  so the whole control rotates WITH the handle rather than swimming against
   *  it, and hold a constant on-screen size. */
  update() {
    if (!this.group) return;
    const cam = this.viewport.camera;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    this.group.position.copy(this.anchor);
    // Not a hand-rolled makeBasis. Getting the handedness wrong there fails
    // silently, setFromRotationMatrix does not object to a reflection, it just
    // returns a rotation nobody asked for, and this control spent its whole
    // life drawn edge-on because of it. See manipulator.screenPlaneOrientation.
    this.group.quaternion.copy(screenPlaneOrientation(fwd, this.axis, camRight));
    this.group.scale.setScalar(this.viewport.pixelWorldSize(this.anchor));
    // A raycast reads matrixWorld, which only a render refreshes, without this
    // the knob is hit-tested where it was last drawn, not where it now is.
    this.group.updateMatrixWorld(true);
    const el = this.viewport.domElement;
    (this.track?.material as LineMaterial | undefined)?.resolution.set(
      el.clientWidth,
      el.clientHeight,
    );
  }

  hitTest(x: number, y: number): boolean {
    if (!this.grab) return false;
    return this.viewport.rayFrom(x, y).intersectObject(this.grab, false).length > 0;
  }

  /** The profile the cursor is pointing at.
   *
   *  The group is camera-facing and pixel-scaled, so its local frame and the
   *  screen agree up to a flip in y, which makes this an atan2 about the
   *  projected anchor rather than an intersection against the track. That also
   *  means it keeps working when the cursor leaves the track entirely: the angle
   *  is still defined, so the knob follows round instead of sticking. */
  profileAt(x: number, y: number): number {
    const centre = this.viewport.projectToScreen(this.anchor);
    const edge = this.viewport.projectToScreen(
      this.anchor.clone().addScaledVector(this.axis, this.viewport.pixelWorldSize(this.anchor)),
    );
    // The screen direction of local +X, so the reading follows the same rotation
    // the track was drawn with.
    const base = Math.atan2(-(edge.y - centre.y), edge.x - centre.x);
    const here = Math.atan2(-(y - centre.y), x - centre.x);
    let d = here - base - OFFSET + SPAN / 2;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return snapProfile(profileFromFraction(d / SPAN));
  }

  hide() {
    if (!this.group) return;
    this.viewport.removeFromScene(this.group);
    this.track?.geometry.dispose();
    (this.track?.material as LineMaterial | undefined)?.dispose();
    this.knob?.geometry.dispose();
    (this.knob?.material as THREE.Material | undefined)?.dispose();
    this.grab?.geometry.dispose();
    (this.grab?.material as THREE.Material | undefined)?.dispose();
    (this.label?.material as THREE.Material | undefined)?.dispose();
    this.labelTex?.dispose();
    this.group = null;
    this.track = null;
    this.knob = null;
    this.grab = null;
    this.label = null;
    this.labelTex = null;
    this.labelCanvas = null;
    this.hot = false;
  }
}
