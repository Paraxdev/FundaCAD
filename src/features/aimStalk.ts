// A lollipop on a stalk you drag like a joystick to aim a direction: the ball
// sits at the end of the stalk, and dragging it carries the direction over a
// sphere round the stalk's foot. Drawn in pixels and scaled by pixelWorldSize
// like every other handle; the caller owns what the direction means.

import * as THREE from "three";
import { HANDLE_HOT, HANDLE_IDLE } from "./manipulator";
import { themeColor } from "../viewport/themeColors";

export const STALK_PX = 88;
const BALL_R = 8;
const UP = new THREE.Vector3(0, 1, 0);

/** Where the cursor ray meets a sphere of `r` about `centre`, on the side facing
 *  the camera; a ray that misses lands on the sphere's outline under it, so an
 *  aim dragged off the ball keeps following the hand instead of stopping. */
export function aimPoint(ray: THREE.Ray, centre: THREE.Vector3, r: number): THREE.Vector3 {
  const hit = ray.intersectSphere(new THREE.Sphere(centre, r), new THREE.Vector3());
  if (hit) return hit;
  const near = ray.closestPointToPoint(centre, new THREE.Vector3()).sub(centre);
  if (near.lengthSq() < 1e-18) return centre.clone().addScaledVector(ray.direction, -r);
  return near.setLength(r).add(centre);
}

/** `dir` turned the way the cursor has moved over the sphere since the press,
 *  from unit `from` to unit `now`, so grabbing the ball off-centre does not make
 *  the direction jump to wherever the cursor is. */
export function aimFollow(dir: THREE.Vector3, from: THREE.Vector3, now: THREE.Vector3): THREE.Vector3 {
  return dir.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(from, now)).normalize();
}

export interface AimStalk {
  readonly group: THREE.Group;
  /** Stand the stalk at `foot` pointing along unit `dir`, `k` world units per pixel. */
  place(foot: THREE.Vector3, dir: THREE.Vector3, k: number, camera: THREE.Camera, hot: boolean): void;
  hit(ray: THREE.Raycaster): boolean;
  /** the ball's centre, in the world */
  tip(): THREE.Vector3;
  /** the drawn parts, for measuring what the handle covers */
  drawn(): THREE.Object3D[];
  dispose(): void;
}

/** `rays` draws short spokes round the ball, a sun, for a stalk that aims a light. */
export function createAimStalk(opts: { rays?: boolean; color?: number } = {}): AimStalk {
  const group = new THREE.Group();
  const stalk = new THREE.Group();
  const overlay = { transparent: true, depthTest: false, depthWrite: false };
  const idle = () => opts.color ?? themeColor("--accent", HANDLE_IDLE);
  const ball = new THREE.MeshBasicMaterial({ color: idle(), ...overlay });
  const shaft = new THREE.MeshBasicMaterial({ color: idle(), opacity: 0.85, ...overlay });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, STALK_PX - BALL_R - 6, 10), shaft);
  stem.position.y = (STALK_PX - BALL_R + 6) / 2;
  const head = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), ball);
  head.position.y = STALK_PX;
  const rim = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R + 1.3, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x0e0f12, opacity: 0.7, side: THREE.BackSide, ...overlay }),
  );
  rim.position.y = STALK_PX;
  stem.renderOrder = 999;
  rim.renderOrder = 1000;
  head.renderOrder = 1001;
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const hitBall = new THREE.Mesh(new THREE.SphereGeometry(16, 12, 8), hidden);
  hitBall.position.y = STALK_PX;
  const hitStem = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, STALK_PX * 0.55, 8), hidden);
  hitStem.position.y = STALK_PX * 0.7;
  stalk.add(stem, rim, head, hitBall, hitStem);
  group.add(stalk);

  // Screen-facing parts round the ball: the spokes, and the dashed outline of
  // the sphere the ball moves over, shown while the hand is on it.
  const face = new THREE.Group();
  const lines: THREE.Line[] = [];
  if (opts.rays) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      pts.push(new THREE.Vector3(c * (BALL_R + 4), s * (BALL_R + 4), 0), new THREE.Vector3(c * (BALL_R + 9), s * (BALL_R + 9), 0));
    }
    const spokes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: idle(), ...overlay }));
    spokes.renderOrder = 1001;
    lines.push(spokes);
    face.add(spokes);
  }
  const circle: THREE.Vector3[] = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    circle.push(new THREE.Vector3(Math.cos(a) * STALK_PX, Math.sin(a) * STALK_PX, 0));
  }
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(circle),
    new THREE.LineDashedMaterial({ color: 0xffffff, opacity: 0.28, dashSize: 5, gapSize: 4, ...overlay }),
  );
  outline.computeLineDistances();
  outline.renderOrder = 997;
  lines.push(outline);
  group.add(face, outline);

  const heads = [head, rim];
  return {
    group,
    place(foot, dir, k, camera, hot) {
      stalk.position.copy(foot);
      stalk.quaternion.setFromUnitVectors(UP, dir);
      stalk.scale.setScalar(k);
      const c = hot ? (opts.color !== undefined ? 0xffe9a8 : themeColor("--accent-hot", HANDLE_HOT)) : idle();
      ball.color.set(c);
      shaft.color.set(c);
      for (const h of heads) h.scale.setScalar(hot ? 1.25 : 1);
      face.position.copy(foot).addScaledVector(dir, STALK_PX * k);
      face.quaternion.copy(camera.quaternion);
      face.scale.setScalar(k * (hot ? 1.25 : 1));
      for (const l of lines) if (l !== outline) (l.material as THREE.LineBasicMaterial).color.set(c);
      outline.visible = hot;
      outline.position.copy(foot);
      outline.quaternion.copy(camera.quaternion);
      outline.scale.setScalar(k);
    },
    hit(ray) {
      return ray.intersectObjects([hitBall, hitStem], false).length > 0;
    },
    tip() {
      stalk.updateMatrixWorld(true);
      return stalk.localToWorld(new THREE.Vector3(0, STALK_PX, 0));
    },
    drawn() {
      return [stem, head, rim, ...lines.filter((l) => l !== outline)];
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      group.removeFromParent();
    },
  };
}
