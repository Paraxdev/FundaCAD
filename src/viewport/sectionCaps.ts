// Solid caps over a cross-section, hatched, so a cut reads as material rather
// than as a hollow shell.
//
// Stencil parity per body: its back faces add one, its front faces take one away,
// both clipped by the section and drawn without depth, so a pixel is left non-zero
// exactly where the cut plane passes through the inside of that body. A quad on the
// plane then paints only those pixels, and clears the stencil for the next body.
// Needs a closed mesh; an open shell gives a partial cap.

import * as THREE from "three";
import type { BodyMesh } from "./render";

/** Past this many bodies the caps are left off: each body costs three draws. */
export const CAP_BODY_LIMIT = 400;

const CAP_ORDER = -1000;

const HATCH_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Screen-space stripes at 45 degrees, a fixed pixel pitch at every zoom the way a
// drawing's hatch is.
const HATCH_FRAG = /* glsl */ `
uniform vec3 base;
uniform vec3 stripe;
uniform float pitch;
uniform float width;
void main() {
  float d = mod(gl_FragCoord.x + gl_FragCoord.y, pitch);
  float t = abs(d - pitch * 0.5);
  float s = 1.0 - smoothstep(width * 0.5 - 0.8, width * 0.5 + 0.8, t);
  gl_FragColor = vec4(mix(base, stripe, s), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function stencilPass(plane: THREE.Plane, side: THREE.Side, op: THREE.StencilOp): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    side,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
    clippingPlanes: [plane],
  });
}

function hatchMaterial(color: THREE.Color): THREE.ShaderMaterial {
  const base = color.clone().multiplyScalar(0.42);
  const stripe = color.clone().lerp(new THREE.Color(0xffffff), 0.25);
  return new THREE.ShaderMaterial({
    vertexShader: HATCH_VERT,
    fragmentShader: HATCH_FRAG,
    uniforms: {
      base: { value: base },
      stripe: { value: stripe },
      pitch: { value: 9 },
      width: { value: 2 },
    },
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
}

const noRaycast = () => {};
const UP = new THREE.Vector3(0, 0, 1);

export class SectionCaps {
  readonly group = new THREE.Group();
  private back: THREE.MeshBasicMaterial | null = null;
  private front: THREE.MeshBasicMaterial | null = null;
  private passes: THREE.Mesh[] = [];
  private caps: { quad: THREE.Mesh; body: BodyMesh }[] = [];
  private geometry = new THREE.PlaneGeometry(1, 1);
  private box = new THREE.Box3();
  private centre = new THREE.Vector3();
  private size = new THREE.Vector3();

  constructor() {
    this.group.name = "section-caps";
  }

  /** Rebuild the caps for these bodies, cut by `plane` (the kept side's). */
  mount(bodies: BodyMesh[], plane: THREE.Plane, colorOf: (id: string) => THREE.Color) {
    this.clear();
    if (!bodies.length || bodies.length > CAP_BODY_LIMIT) return;
    this.back = stencilPass(plane, THREE.BackSide, THREE.IncrementWrapStencilOp);
    this.front = stencilPass(plane, THREE.FrontSide, THREE.DecrementWrapStencilOp);
    bodies.forEach((b, i) => {
      const order = CAP_ORDER + i * 3;
      for (const [mat, k] of [[this.back!, 0], [this.front!, 1]] as const) {
        const m = new THREE.Mesh(b.mesh.geometry, mat);
        m.renderOrder = order + k;
        m.raycast = noRaycast;
        b.mesh.add(m);
        this.passes.push(m);
      }
      const quad = new THREE.Mesh(this.geometry, hatchMaterial(colorOf(b.id)));
      quad.renderOrder = order + 2;
      quad.raycast = noRaycast;
      quad.onBeforeRender = (renderer) => {
        const u = (quad.material as THREE.ShaderMaterial).uniforms;
        const dpr = renderer.getPixelRatio();
        u["pitch"]!.value = 9 * dpr;
        u["width"]!.value = 2 * dpr;
      };
      this.group.add(quad);
      this.caps.push({ quad, body: b });
    });
    this.place(plane);
  }

  /** Lay each cap on the plane over its body. Cheap, so it runs on every drag step. */
  place(plane: THREE.Plane) {
    for (const { quad, body } of this.caps) {
      this.box.setFromObject(body.mesh, false);
      if (this.box.isEmpty()) continue;
      this.box.getCenter(this.centre);
      const span = this.box.getSize(this.size).length() * 1.05 + 1;
      plane.projectPoint(this.centre, quad.position);
      quad.quaternion.setFromUnitVectors(UP, plane.normal);
      quad.scale.set(span, span, 1);
      quad.visible = body.mesh.visible;
    }
  }

  clear() {
    for (const m of this.passes) m.removeFromParent();
    for (const { quad } of this.caps) {
      quad.removeFromParent();
      (quad.material as THREE.Material).dispose();
    }
    this.back?.dispose();
    this.front?.dispose();
    this.back = this.front = null;
    this.passes = [];
    this.caps = [];
  }
}
