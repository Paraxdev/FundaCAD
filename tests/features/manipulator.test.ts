import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  createDragHandle,
  HANDLE_CUT,
  HANDLE_HOT,
  HANDLE_IDLE,
  MIN_SCREEN_AXIS,
  fluentRelease,
  leanOutOfView,
  orientOutward,
  screenPlaneOrientation,
  HANDLE_LENGTH,
  HANDLE_MODEL_FRACTION,
  MIN_HANDLE_SCALE,
  handleScale,
  handleReachPx,
} from "../../src/features/manipulator";

describe("orientOutward", () => {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  it("keeps an axis that already points away from the body", () => {
    expect(orientOutward(v(1, 0, 0), v(10, 0, 0), v(0, 0, 0)).x).toBe(1);
  });

  it("flips an axis that points into the material", () => {
    // The actual bug: tangent x cameraForward has an arbitrary sign, so the
    // handle stood outward or buried itself in the solid depending on nothing
    // but which way the camera happened to be facing.
    expect(orientOutward(v(-1, 0, 0), v(10, 0, 0), v(0, 0, 0)).x).toBe(1);
  });

  it("leaves the axis alone when there is no outward to speak of", () => {
    // No bbox yet (empty document), or a handle sitting exactly on the centre:
    // any answer is arbitrary, so don't churn the axis between frames.
    expect(orientOutward(v(-1, 0, 0), null, v(0, 0, 0)).x).toBe(-1);
    expect(orientOutward(v(-1, 0, 0), v(1, 0, 0), null).x).toBe(-1);
    expect(orientOutward(v(-1, 0, 0), v(0, 0, 0), v(0, 0, 0)).x).toBe(-1);
  });

  it("decides on the component along outward, not on the nearest axis", () => {
    // An edge handle is perpendicular to its edge and lies in the screen plane,
    // so it is usually oblique to the centre-to-anchor line. Only the sign of
    // the projection matters.
    const perp = v(0.2, 0.98, 0).normalize();
    expect(orientOutward(perp.clone(), v(0, 5, 0), v(0, 0, 0)).y).toBeGreaterThan(0);
    const inward = v(0.2, -0.98, 0).normalize();
    expect(orientOutward(inward, v(0, 5, 0), v(0, 0, 0)).y).toBeGreaterThan(0);
  });
});

/** A camera on a sphere around the origin, looking in — one orbit position. */
function orbit(az: number, el: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1000);
  cam.position.setFromSphericalCoords(200, Math.PI / 2 - el, az);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}
const forwardOf = (cam: THREE.Camera) => cam.getWorldDirection(new THREE.Vector3());
const rightOf = (cam: THREE.Camera) =>
  new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
const upOf = (cam: THREE.Camera) =>
  new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();

/** Every orbit position and axis the sweeps below cover. */
function* orbits() {
  for (let az = 0; az < 6.28; az += 0.37) {
    for (let el = -1.4; el < 1.4; el += 0.29) {
      const cam = orbit(az, el);
      for (const axis of [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0.3, -0.5, 0.81).normalize(),
        forwardOf(cam).clone().negate(), // straight at the camera
      ]) {
        yield { cam, axis };
      }
    }
  }
}

describe("screenPlaneOrientation", () => {
  it("keeps the control facing the camera at every orbit", () => {
    // The bug this exists for: the shipped basis put `fwd x right` — which
    // points DOWN the screen — in the +Y column, making it left-handed.
    // setFromRotationMatrix does not object to a reflection, it just returns a
    // quaternion for some other rotation, so the profile arc was drawn at an
    // arbitrary tilt: over a full orbit sweep its plane averaged 40 degrees off
    // camera-facing and was frequently edge-on. An 84px arc then showed up on
    // screen as a stub, while its sphere knob and sprite readout — neither of
    // which has an orientation to get wrong — went on looking correct.
    for (const { cam, axis } of orbits()) {
      const q = screenPlaneOrientation(forwardOf(cam), axis, rightOf(cam));
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      expect(normal.dot(forwardOf(cam))).toBeCloseTo(-1, 6); // +Z out of the screen
    }
  });

  it("returns a unit quaternion", () => {
    // A non-unit quaternion is not merely a wrong rotation: Object3D composes it
    // straight into its matrix, so it silently scales the object by |q|^2 too.
    // The old basis produced lengths as low as 0.7 — the control shrank as well
    // as tilting.
    for (const { cam, axis } of orbits()) {
      expect(screenPlaneOrientation(forwardOf(cam), axis, rightOf(cam)).length()).toBeCloseTo(1, 6);
    }
  });

  it("lines local +X up with the drag axis as the screen sees it", () => {
    // The arc is a crossbar on the handle, so its zero angle has to be the
    // handle's own direction on screen. Anything else reads as an unrelated
    // widget that happens to be nearby.
    for (const { cam, axis } of orbits()) {
      const fwd = forwardOf(cam);
      const flat = axis.clone().projectOnPlane(fwd);
      if (flat.lengthSq() < 1e-6) continue; // no screen direction to line up with
      const q = screenPlaneOrientation(fwd, axis, rightOf(cam));
      const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      expect(x.dot(flat.normalize())).toBeCloseTo(1, 6);
    }
  });

  it("turns anticlockwise on screen, never mirrored", () => {
    // Not cosmetic: the arc's hit test reads cursor angles with atan2 about a
    // flipped y — the anticlockwise-is-positive convention. A mirrored frame
    // still faces the camera and still lines +X up with the axis, so it looks
    // right standing still; it only shows itself once the user drags, by running
    // the knob the opposite way round the track from the cursor. Local +Y a
    // quarter turn anticlockwise from +X is exactly that convention.
    for (const { cam, axis } of orbits()) {
      const q = screenPlaneOrientation(forwardOf(cam), axis, rightOf(cam));
      const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const toViewer = forwardOf(cam).negate();
      expect(new THREE.Vector3().crossVectors(x, y).dot(toViewer)).toBeCloseTo(1, 6);
    }
  });

  it("borrows the camera's right when the axis points dead at the viewer", () => {
    // Then there is no projected axis to align to, and the control still has to
    // be somewhere rather than collapsing or jittering between frames.
    const cam = orbit(0.9, 0.4);
    const fwd = forwardOf(cam);
    const q = screenPlaneOrientation(fwd, fwd.clone(), rightOf(cam));
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(q).dot(rightOf(cam))).toBeCloseTo(1, 6);
  });
});

describe("leanOutOfView", () => {
  const screenShare = (v: THREE.Vector3, fwd: THREE.Vector3) =>
    v.clone().projectOnPlane(fwd).length();

  it("leaves an axis with screen length of its own untouched", () => {
    // The common case by far, and the handle must not wobble in it: an edge
    // axis is built perpendicular to the view, so leaning it at all would be
    // inventing a tilt nobody asked for.
    const cam = orbit(0.9, 0.4);
    const axis = rightOf(cam);
    expect(leanOutOfView(axis, forwardOf(cam), rightOf(cam)).dot(axis)).toBeCloseTo(1, 9);
  });

  it("tips an axis aimed at the camera back out until the handle has length", () => {
    // The squashed lump: a 52px blob standing along the view direction projects
    // to a 20px disc with no direction in it. Orbiting past an armed handle used
    // to reach exactly that — a sweep of the whole orbit sphere against a fixed
    // axis found positions leaving 0.03px of the 52.
    const cam = orbit(0.9, 0.4);
    const fwd = forwardOf(cam);
    for (const axis of [fwd.clone(), fwd.clone().negate()]) {
      const leaned = leanOutOfView(axis, fwd, rightOf(cam));
      expect(screenShare(leaned, fwd)).toBeCloseTo(MIN_SCREEN_AXIS, 6);
      expect(leaned.length()).toBeCloseTo(1, 9);
    }
  });

  it("keeps the side of the camera the axis was on", () => {
    // A handle leaning towards the viewer must not flip to leaning away from
    // it: that is a 180 degree jump in the middle of a slow orbit, and it says
    // the drag now runs the other way.
    const cam = orbit(2.1, -0.3);
    const fwd = forwardOf(cam);
    const away = fwd.clone().addScaledVector(rightOf(cam), 0.05).normalize();
    const toward = away.clone().negate();
    expect(leanOutOfView(away, fwd, rightOf(cam)).dot(fwd)).toBeGreaterThan(0);
    expect(leanOutOfView(toward, fwd, rightOf(cam)).dot(fwd)).toBeLessThan(0);
  });

  it("keeps whatever screen direction the axis already had", () => {
    // The lean is a rescue, not a re-aim. Whichever way the handle was pointing
    // on screen is the way the drag runs, so that much has to survive.
    const cam = orbit(2.1, -0.3);
    const fwd = forwardOf(cam);
    const flat = upOf(cam).clone().multiplyScalar(0.08);
    const axis = fwd.clone().add(flat).normalize();
    const leaned = leanOutOfView(axis, fwd, rightOf(cam));
    expect(
      leaned.clone().projectOnPlane(fwd).normalize().dot(flat.clone().normalize()),
    ).toBeCloseTo(1, 6);
  });

  it("guarantees the floor from every direction", () => {
    for (const { cam, axis } of orbits()) {
      const fwd = forwardOf(cam);
      const leaned = leanOutOfView(axis, fwd, rightOf(cam));
      expect(screenShare(leaned, fwd)).toBeGreaterThan(MIN_SCREEN_AXIS - 1e-6);
      expect(leaned.length()).toBeCloseTo(1, 9);
    }
  });
});

/** Raycast the handle exactly the way every consumer does. */
function pick(group: THREE.Group, x: number, y: number) {
  group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  // Straight down -Z at (x, y): the handle is modelled along +Y in its own
  // frame, so this is "the cursor is x pixels off the axis, y pixels up it".
  ray.set(new THREE.Vector3(x, y, 500), new THREE.Vector3(0, 0, -1));
  return ray.intersectObjects(group.children, false);
}

describe("arrow handle grab volume", () => {
  it("is pickable well off the axis, where the drawn glyph is not", () => {
    // The complaint this exists to fix: the old handle was hit-tested against a
    // 1.6px shaft and a 5px cone, so grabbing it took careful aim. 12px off the
    // stem has to count as a hit even though nothing is drawn there.
    const h = createDragHandle();
    expect(pick(h.group, 0, 30).length).toBeGreaterThan(0); // dead centre
    expect(pick(h.group, 10, 20).length).toBeGreaterThan(0); // off the stem
    expect(pick(h.group, 15, 38).length).toBeGreaterThan(0); // off the head
    h.dispose();
  });

  it("still misses when the cursor is genuinely nowhere near", () => {
    // A grab volume that swallowed the whole viewport would eat clicks meant
    // for the model — the tools rely on a miss to mean "orbit" or "commit".
    const h = createDragHandle();
    expect(pick(h.group, 40, 30)).toHaveLength(0);
    expect(pick(h.group, 0, 140)).toHaveLength(0);
    h.dispose();
  });

  it("keeps the grab volume invisible", () => {
    // It must widen the target without widening the drawn glyph. Three's
    // raycaster tests layers and never `visible`, which is what lets these two
    // requirements coexist — if that ever changed, the handle would silently go
    // back to needing fine aim.
    const h = createDragHandle();
    const drawn = h.group.children.filter(
      (c) => (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.Material).visible,
    );
    expect(drawn).toHaveLength(2); // the blob and its outline, nothing else
    h.dispose();
  });
});

describe("arrow handle paint", () => {
  const bodyOf = (g: THREE.Group) =>
    g.children.find(
      (c) => (c as THREE.Mesh).material instanceof THREE.MeshLambertMaterial,
    ) as THREE.Mesh;

  it("brightens on hover and returns to its tone", () => {
    const h = createDragHandle();
    const m = bodyOf(h.group).material as THREE.MeshLambertMaterial;
    expect(m.color.getHex()).toBe(HANDLE_IDLE);
    h.paint({ hot: true });
    expect(m.color.getHex()).toBe(HANDLE_HOT);
    h.paint({ hot: false });
    expect(m.color.getHex()).toBe(HANDLE_IDLE);
    h.dispose();
  });

  it("wears the cut tone when a push removes material", () => {
    // press/pull flips this with the drag's sign; the colour is the only thing
    // that says which of the two things the same gesture is about to do.
    const h = createDragHandle();
    const m = bodyOf(h.group).material as THREE.MeshLambertMaterial;
    h.paint({ tone: "cut" });
    expect(m.color.getHex()).toBe(HANDLE_CUT);
    h.paint({ hot: true });
    expect(m.color.getHex()).toBe(HANDLE_HOT); // hover still wins
    h.paint({ hot: false });
    expect(m.color.getHex()).toBe(HANDLE_CUT); // ...and hands the tone back
    h.dispose();
  });

  it("keeps the emissive floor in step with the colour", () => {
    // Unlit-from-behind is the common case for a handle standing off a face; if
    // emissive lagged the colour the blob would read as the wrong tone there.
    const h = createDragHandle();
    const m = bodyOf(h.group).material as THREE.MeshLambertMaterial;
    h.paint({ tone: "cut" });
    expect(m.emissive.getHex()).toBe(m.color.getHex());
    h.dispose();
  });

  it("fades the outline faster than the body", () => {
    // The passive offer sits at 55%. A full-strength near-black outline there
    // would make an unaccepted offer the loudest thing on screen.
    const h = createDragHandle();
    h.paint({ opacity: 0.55 });
    const mats = h.group.children
      .map((c) => (c as THREE.Mesh).material as THREE.Material)
      .filter((m) => m && m.visible);
    const opacities = mats.map((m) => (m as THREE.MeshBasicMaterial).opacity).sort();
    expect(opacities[0]).toBeLessThan(opacities[1]!);
    h.dispose();
  });
});

describe("fluentRelease", () => {
  it("leaves a gesture that began on the tool's own gizmo armed", () => {
    // The classic flow: grab, scrub, let go, adjust, click to commit. Releasing
    // the handle there has never meant "done" and must not start meaning it.
    expect(fluentRelease({ fluent: false, moved: true, meaningful: true })).toBe("stay");
    expect(fluentRelease({ fluent: false, moved: false, meaningful: false })).toBe("stay");
  });

  it("commits a fluent drag that actually went somewhere", () => {
    // One press: press the passive handle, drag, release, done. Leaving the
    // tool armed after that would strand the user in a mode they never entered.
    expect(fluentRelease({ fluent: true, moved: true, meaningful: true })).toBe("commit");
  });

  it("stays armed when a fluent press never travelled", () => {
    // A click on the arrow is not a drag. Committing here would drop a default
    // 2 mm fillet on a stray click — and staying armed is what makes clicking
    // the handle a way IN to the full tool.
    expect(fluentRelease({ fluent: true, moved: false, meaningful: true })).toBe("stay");
  });

  it("cancels a fluent drag that ended back at nothing", () => {
    // Dragging out and back to zero is how you back out of a gesture you did
    // not mean to start. Staying armed would trap exactly that user in the tool
    // they were trying to leave.
    expect(fluentRelease({ fluent: true, moved: true, meaningful: false })).toBe("cancel");
  });

  it("never commits without both a fluent grab and real movement", () => {
    for (const moved of [true, false]) {
      for (const meaningful of [true, false]) {
        expect(fluentRelease({ fluent: false, moved, meaningful })).not.toBe("commit");
      }
    }
    expect(fluentRelease({ fluent: true, moved: false, meaningful: true })).not.toBe("commit");
  });
});

describe("handleScale", () => {
  it("leaves the usual pixel scale alone while the model is the bigger of the two", () => {
    // A 100mm part filling a 900px viewport: the handle is 45px against 900px of
    // model, nowhere near the cap, and must stay exactly its pixel size — this
    // is the ordinary case and the cap must be invisible in it.
    expect(handleScale(100, 100 / 900)).toBe(1);
    expect(handleScale(20, 20 / 600)).toBe(1);
  });

  it("shrinks the handle once it would dwarf the part", () => {
    // The reported case: zoomed out until the body is a thumbnail, where a
    // constant-size handle stops being a control ON an object and becomes a
    // balloon with an object hanging off it.
    const modelPx = 60;
    const s = handleScale(10, 10 / modelPx);
    expect(s).toBeLessThan(1);
    expect(s * HANDLE_LENGTH).toBeLessThanOrEqual(modelPx * HANDLE_MODEL_FRACTION + 1e-9);
  });

  it("never shrinks past the point of being aimable", () => {
    // Below the floor the cure is worse than the disease: a handle too small to
    // hit is a tool that has effectively disappeared, which is worse than one
    // that merely looks too big.
    expect(handleScale(1, 1 / 4)).toBe(MIN_HANDLE_SCALE);
    expect(handleScale(1e-6, 1)).toBe(MIN_HANDLE_SCALE);
  });

  it("never returns zero or a non-finite scale", () => {
    // scale.setScalar(0) collapses the glyph AND its invisible grab volumes, so
    // the handle would be invisible and unclickable at once — indistinguishable
    // from the tool being broken.
    for (const [d, p] of [[0, 1], [-5, 1], [10, 0], [10, -1], [NaN, 1], [10, NaN]] as const) {
      const s = handleScale(d, p);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
  });

  it("falls back to the pixel scale when there is nothing to measure against", () => {
    // An empty document still has to show a usable handle.
    expect(handleScale(null, 0.1)).toBe(1);
    expect(handleScale(100, null)).toBe(1);
  });

  it("is monotone in how much of the screen the model occupies", () => {
    // A handle that grew as you zoomed out, or jumped about mid-orbit, would
    // read as flicker rather than as a rule.
    let prev = 0;
    for (const modelPx of [10, 30, 60, 120, 300, 900]) {
      const s = handleScale(50, 50 / modelPx);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = s;
    }
  });
});

describe("handleReachPx", () => {
  // What anything standing clear of the handle has to know. The selection
  // toolbar used to carry a guessed 64px instead, with a comment saying the two
  // "must not overlap"; measured on a fitted 40mm box the bar's bottom edge and
  // the handle's top landed on the same pixel.

  it("is the drawn glyph's height while the handle is at full size", () => {
    // Far enough out that the model is the bigger of the two, which is every
    // ordinary view: the handle is then a constant screen size and its reach is
    // simply its length.
    expect(handleReachPx(400, 0.1)).toBe(HANDLE_LENGTH);
  });

  it("shrinks with the handle when the model is small on screen", () => {
    // A 60px-wide part cannot carry a 45px handle, so both shrink — and the
    // clearance has to shrink with them or the toolbar floats off on its own.
    const small = handleReachPx(6, 0.1); // 60px of model
    expect(small).toBeLessThan(HANDLE_LENGTH);
    expect(small).toBeCloseTo(HANDLE_LENGTH * handleScale(6, 0.1), 9);
  });

  it("never reports a reach of zero", () => {
    // A zero would put the bar on top of a handle that is still drawn: the
    // shrink is floored (MIN_HANDLE_SCALE) precisely so the thing stays a
    // target, and the clearance has to respect the same floor.
    for (const [diag, k] of [[0, 0.1], [-1, 0.1], [400, 0], [NaN, 0.1], [400, NaN]] as const) {
      expect(handleReachPx(diag, k), `${diag}/${k}`).toBeGreaterThan(0);
    }
    expect(handleReachPx(1e-6, 1)).toBeGreaterThanOrEqual(HANDLE_LENGTH * MIN_HANDLE_SCALE);
  });
});
