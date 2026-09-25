// The navigator as a CameraRig: it owns the three.js cameras and writes the
// pose into them the moment it changes, so every raycast and projection is
// taken from the pose on screen.

import * as THREE from "three";
import type {
  CameraRig, CameraState, FitOptions, NavLimits, ProjectionMode, StandardView,
} from "../cameras";
import { cameraFlightsOn } from "../../ui/motion";
import { orthoClip, perspClip, NEAR_AT_REST } from "../clipPlanes";
import { boxDepthRange } from "./anchor";
import { bindInput } from "./input";
import { Navigator, lookQuatUp } from "./navigator";
import { clonePose, distanceOf, eyeOf, forwardOf, setOrientation } from "./pose";
import { getNavPrefs, onNavPrefsChange } from "../../ui/interactionPrefs";

const STANDARD: Record<StandardView, { dir: [number, number, number]; up: [number, number, number] }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1, -1, 0.8], up: [0, 0, 1] },
};

export function createNavigatorRig(dom: HTMLElement, aspect: number): CameraRig & { navigator: Navigator } {
  const nav = new Navigator();
  const persp = new THREE.PerspectiveCamera(nav.pose.fov, aspect, NEAR_AT_REST, 10000);
  const ortho = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, -10000, 10000);
  let active: THREE.Camera = persp;
  const r0 = dom.getBoundingClientRect?.();
  nav.setFrame(r0?.width || 800 * aspect, r0?.height || 800);
  nav.resetView(null, 0, false);

  const applyPrefs = () => {
    const p = getNavPrefs();
    nav.opts.inertia = p.inertia;
    nav.opts.smoothTime = p.smoothTime;
  };
  applyPrefs();
  onNavPrefsChange(applyPrefs);

  const eye = new THREE.Vector3();
  const upV = new THREE.Vector3();
  let written = -1;
  function write() {
    const p = nav.pose;
    if (written === nav.poseVersion()) return;
    written = nav.poseVersion();
    eyeOf(p, eye);
    upV.set(0, 1, 0).applyQuaternion(p.q);
    const box = nav.contentBox();
    const [zmin, zmax] = boxDepthRange(p, box);
    const a = nav.frame.width / nav.frame.height;
    for (const cam of [persp, ortho]) {
      cam.position.copy(eye);
      cam.quaternion.copy(p.q);
      cam.up.copy(upV);
    }
    const pc = perspClip(distanceOf(p), zmin, zmax);
    persp.fov = p.fov;
    persp.aspect = a;
    persp.near = pc.near;
    persp.far = pc.far;
    persp.updateProjectionMatrix();
    const oc = orthoClip(p.scale, zmin, zmax);
    ortho.top = p.scale;
    ortho.bottom = -p.scale;
    ortho.left = -p.scale * a;
    ortho.right = p.scale * a;
    ortho.zoom = 1;
    ortho.near = oc.near;
    ortho.far = oc.far;
    ortho.updateProjectionMatrix();
    persp.updateMatrixWorld(true);
    ortho.updateMatrixWorld(true);
    active = p.ortho ? ortho : persp;
  }
  nav.on("change", write);
  write();

  const input = bindInput(dom, nav, { scrollPans: () => getNavPrefs().scrollPans });

  const local = (clientX: number, clientY: number): [number, number] => {
    const r = dom.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  };
  const animate = (want: boolean | undefined) => (want ?? true) && cameraFlightsOn();
  const fitOpts = (o?: boolean | FitOptions): FitOptions => (typeof o === "boolean" ? { animate: o } : (o ?? {}));

  const rig: CameraRig & { navigator: Navigator } = {
    navigator: nav,
    get active() {
      write();
      return active;
    },
    isOrtho() {
      return nav.pose.ortho;
    },
    projectionMode(): ProjectionMode {
      return nav.projectionMode();
    },
    setProjectionMode(m) {
      nav.setProjectionMode(m);
      write();
    },
    resize(w, h) {
      nav.setFrame(w, h);
      write();
    },
    update(dt) {
      const moved = nav.update(dt);
      write();
      return moved;
    },
    getTarget(out = new THREE.Vector3()) {
      return out.copy(nav.pose.target);
    },
    getPosition(out = new THREE.Vector3()) {
      return eyeOf(nav.pose, out);
    },
    viewDirection(out = new THREE.Vector3()) {
      return forwardOf(nav.pose, out);
    },
    poseVersion() {
      return nav.poseVersion();
    },
    viewScale() {
      return nav.pose.scale;
    },
    getState(): CameraState {
      const p = nav.pose;
      return {
        target: [p.target.x, p.target.y, p.target.z],
        quaternion: [p.q.x, p.q.y, p.q.z, p.q.w],
        scale: p.scale,
        fov: p.fov,
        mode: nav.projectionMode(),
      };
    },
    setState(st, anim = false) {
      nav.setProjectionMode(st.mode);
      const p = clonePose(nav.pose);
      p.target.set(...st.target);
      setOrientation(p, new THREE.Quaternion(...st.quaternion));
      p.scale = st.scale;
      p.fov = st.fov;
      nav.flyTo(p, { animate: anim && cameraFlightsOn() });
    },
    setScene(s) {
      nav.setScene(s);
    },
    setContentBox(box) {
      nav.setContentBox(box);
      nav.touch();
    },
    setAnchorPlane(plane) {
      nav.setAnchorPlane(plane);
    },
    setLimits(l: Partial<NavLimits>) {
      nav.setLimits(l);
    },
    on(ev, fn) {
      return nav.on(ev, fn);
    },
    onInputStart(fn) {
      return nav.on("inputstart", fn);
    },
    wheel(e) {
      input.wheel(e);
    },
    pivotAt(clientX, clientY) {
      const [x, y] = local(clientX, clientY);
      return nav.pivotAt(x, y);
    },
    setOrbitLocked(locked) {
      nav.setOrbitLocked(locked);
    },
    orbitLocked() {
      return nav.orbitLocked();
    },
    zoomBy(f, pivot) {
      nav.zoomBy(f, pivot);
    },
    panScreen(dx, dy) {
      nav.panScreen(dx, dy);
    },
    orbitBy(az, pol) {
      nav.orbitBy(az, pol);
    },
    tumble(az, pol) {
      nav.tumble(az, pol);
    },
    roll(angle) {
      nav.roll(angle);
    },
    rotateTo(az, polar, anim = false) {
      nav.rotateTo(az, polar, anim && cameraFlightsOn());
    },
    moveTo(p, anim = false) {
      nav.moveTo(p, anim && cameraFlightsOn());
    },
    setLookAt(e, t, anim = false) {
      nav.setLookAt(e, t, anim && cameraFlightsOn());
    },
    lerpLookAt(eA, tA, eB, tB, t, anim = false) {
      nav.setLookAt(eA.clone().lerp(eB, t), tA.clone().lerp(tB, t), anim && cameraFlightsOn());
    },
    setViewScale(s, anim = false) {
      nav.setViewScale(s, anim && cameraFlightsOn());
    },
    setOrbitPoint(p) {
      nav.setOrbitPoint(p);
    },
    fov() {
      return nav.pose.fov;
    },
    setFov(deg, opts) {
      nav.setFov(deg, opts?.keepScale ?? false, (opts?.animate ?? false) && cameraFlightsOn());
    },
    fit(box, opts) {
      const o = fitOpts(opts);
      const empty = box.isEmpty();
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      nav.fitSphere(empty ? new THREE.Vector3() : sphere.center, empty ? -1 : sphere.radius, {
        animate: animate(o.animate),
        ...(o.padding !== undefined ? { padding: o.padding } : {}),
      });
    },
    fitSphere(sphere, opts) {
      const o = fitOpts(opts);
      nav.fitSphere(sphere.center, sphere.radius, {
        animate: animate(o.animate),
        ...(o.padding !== undefined ? { padding: o.padding } : {}),
      });
    },
    resetView(box) {
      if (!box || box.isEmpty()) nav.resetView(null, 0, cameraFlightsOn());
      else {
        const s = box.getBoundingSphere(new THREE.Sphere());
        nav.resetView(s.center, s.radius, cameraFlightsOn());
      }
    },
    setStandardView(view) {
      const v = STANDARD[view];
      nav.turnTo(lookQuatUp(new THREE.Vector3(...v.dir).normalize(), new THREE.Vector3(...v.up)), cameraFlightsOn());
    },
    setViewDir(dir, up) {
      nav.turnTo(lookQuatUp(dir.clone().normalize(), up), cameraFlightsOn());
    },
    lookAtPlane(origin, normal, up, opts) {
      nav.lookAtPlane(origin, normal, up, !!opts?.animate && cameraFlightsOn(), opts?.onArrive);
    },
    isFlying() {
      return nav.isFlying();
    },
    restoreUp() {
      nav.restoreUp(cameraFlightsOn());
    },
  };
  return rig;
}
