// The protractor a ring drag shows: a dashed circle in the ring's plane with a
// tick per step, the swept wedge from where the ring was grabbed, and the angle
// in a badge at the leading edge. Built in gizmo units (screen pixels), so it is
// added to the gizmo group and scales with it.

import * as THREE from "three";
import { rotationFrame, type RotationFrame } from "../features/transformGizmo";

export const DIAL_RADIUS = 62;
const TICK = 3;
const MAJOR_TICK = 7;
const SEGMENTS_PER_TURN = 120;

/** Where the angle `a` (radians, right-handed in `frame`) lands at `radius`. */
export function dialPoint(frame: RotationFrame, a: number, radius: number): THREE.Vector3 {
  return frame.u.clone().multiplyScalar(Math.cos(a) * radius).addScaledVector(frame.v, Math.sin(a) * radius);
}

/** "345°", "-30°", "7.5°": whole degrees without a fraction, one decimal otherwise. */
export function formatTurn(deg: number): string {
  const r = Math.round(deg * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}°`;
}

export class RotateDial {
  readonly group = new THREE.Group();
  private readonly frame: RotationFrame;
  private readonly circle: THREE.LineLoop;
  private ticks: THREE.LineSegments | null = null;
  private tickStep = 0;
  private readonly wedge: THREE.Mesh;
  private readonly arms: THREE.LineSegments;
  private readonly lineMat: THREE.LineDashedMaterial;
  private readonly solidMat: THREE.LineBasicMaterial;
  private readonly wedgeMat: THREE.MeshBasicMaterial;
  private readonly label: HTMLDivElement;
  private tip = new THREE.Vector3();

  constructor(axis: THREE.Vector3, color: number) {
    this.frame = rotationFrame(axis);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < SEGMENTS_PER_TURN; i++) {
      pts.push(dialPoint(this.frame, (i / SEGMENTS_PER_TURN) * Math.PI * 2, DIAL_RADIUS));
    }
    const overlay = { depthTest: false, depthWrite: false, transparent: true };
    this.lineMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 4, gapSize: 3, opacity: 0.7, ...overlay });
    this.solidMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.85, ...overlay });
    this.wedgeMat = new THREE.MeshBasicMaterial({ color, opacity: 0.22, side: THREE.DoubleSide, ...overlay });
    this.circle = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.lineMat);
    this.circle.computeLineDistances();
    this.wedge = new THREE.Mesh(new THREE.BufferGeometry(), this.wedgeMat);
    this.arms = new THREE.LineSegments(new THREE.BufferGeometry(), this.solidMat);
    for (const o of [this.circle, this.wedge, this.arms]) o.renderOrder = 998;
    this.group.add(this.circle, this.wedge, this.arms);

    this.label = document.createElement("div");
    this.label.className = "rotate-dial-label";
    this.label.style.pointerEvents = "none";
    document.body.appendChild(this.label);
  }

  /** Show `turnedDeg` swept from the grab angle `start` (radians), ticked every `stepDeg`. */
  update(start: number, turnedDeg: number, stepDeg: number) {
    if (stepDeg !== this.tickStep) this.buildTicks(stepDeg);
    const sweep = (turnedDeg * Math.PI) / 180;
    const n = Math.max(1, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * SEGMENTS_PER_TURN));
    const fan: number[] = [];
    for (let i = 0; i < n; i++) {
      const a0 = dialPoint(this.frame, start + (sweep * i) / n, DIAL_RADIUS);
      const a1 = dialPoint(this.frame, start + (sweep * (i + 1)) / n, DIAL_RADIUS);
      fan.push(0, 0, 0, a0.x, a0.y, a0.z, a1.x, a1.y, a1.z);
    }
    this.wedge.geometry.dispose();
    this.wedge.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(fan, 3));
    const from = dialPoint(this.frame, start, DIAL_RADIUS);
    this.tip = dialPoint(this.frame, start + sweep, DIAL_RADIUS);
    this.arms.geometry.dispose();
    this.arms.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), from, new THREE.Vector3(), this.tip]);
    this.label.textContent = formatTurn(turnedDeg);
  }

  /** The badge sits just outside the leading edge of the sweep. */
  placeLabel(toScreen: (world: THREE.Vector3) => { x: number; y: number }) {
    const out = this.tip.clone().multiplyScalar((DIAL_RADIUS + 16) / DIAL_RADIUS);
    const s = toScreen(this.group.localToWorld(out));
    this.label.style.left = `${s.x}px`;
    this.label.style.top = `${s.y}px`;
  }

  dispose() {
    this.circle.geometry.dispose();
    this.ticks?.geometry.dispose();
    this.wedge.geometry.dispose();
    this.arms.geometry.dispose();
    this.lineMat.dispose();
    this.solidMat.dispose();
    this.wedgeMat.dispose();
    this.group.removeFromParent();
    this.label.remove();
  }

  private buildTicks(stepDeg: number) {
    this.tickStep = stepDeg;
    if (this.ticks) {
      this.group.remove(this.ticks);
      this.ticks.geometry.dispose();
    }
    const every = Math.max(stepDeg, 5);
    const pts: THREE.Vector3[] = [];
    for (let d = 0; d < 360; d += every) {
      const len = d % 90 === 0 ? MAJOR_TICK : TICK;
      const a = (d * Math.PI) / 180;
      pts.push(dialPoint(this.frame, a, DIAL_RADIUS - len), dialPoint(this.frame, a, DIAL_RADIUS + len));
    }
    this.ticks = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), this.solidMat);
    this.ticks.renderOrder = 998;
    this.group.add(this.ticks);
  }
}
