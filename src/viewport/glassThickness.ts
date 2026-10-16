// Glass that measures itself. A glass material with auto thickness reads, per
// pixel, the nearest back face of its own body from a small pre pass (world
// normal and a body id in colour, depth beside it) and refracts at both
// surfaces: entry with the front normal, exit with the back face normal. Where
// that data is missing (a back facing fragment, a silhouette pixel, another
// glass body in front, the swatch, a frame drawn outside SceneView.render) the
// body's mean thickness 2V/A from the display mesh is used instead.
//
// Choices worth knowing: the background distance behind the exit point is
// unknown (three keeps no depth of the opaque scene), so the exit bend is
// carried for one thickness, as three already does for the entry bend. Total
// internal reflection at the exit keeps the inside ray. Glass inside glass: the
// outer body's front pixels see the inner body's back face, so they use the
// outer body's mean thickness.
import * as THREE from "three";

export const FALLBACK_THICKNESS = 3;

/** Mean thickness of a closed mesh, 2 * volume / area, in its own units. Exact
 *  for a plate, a third of the edge for a cube. Open or flat meshes give the
 *  fallback. Cached on the geometry, a rebuilt body brings a new one. */
export function meanThickness(geo: THREE.BufferGeometry | undefined): number {
  if (!geo) return FALLBACK_THICKNESS;
  const cached = geo.userData["fcMeanThickness"];
  if (typeof cached === "number") return cached;
  const pos = geo.getAttribute("position");
  if (!pos) return FALLBACK_THICKNESS;
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), e = new THREE.Vector3();
  let six = 0;
  let twice = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    a.fromBufferAttribute(pos, index ? index.getX(i) : i);
    b.fromBufferAttribute(pos, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, index ? index.getX(i + 2) : i + 2);
    n.crossVectors(b, c);
    six += a.dot(n);
    n.subVectors(b, a).cross(e.subVectors(c, a));
    twice += n.length();
  }
  // Volume six / 6 and area twice / 2, so 2V/A is (2/3) * six / twice.
  const t = twice > 0 ? (2 / 3) * Math.abs(six) / twice : 0;
  const out = Number.isFinite(t) && t > 1e-6 ? t : FALLBACK_THICKNESS;
  geo.userData["fcMeanThickness"] = out;
  return out;
}

const shared = {
  fcBackMap: { value: null as THREE.Texture | null },
  fcBackDepth: { value: null as THREE.Texture | null },
  fcInvViewProj: { value: new THREE.Matrix4() },
  fcActive: { value: 0 },
};

const PARS = /* glsl */`
#ifdef USE_TRANSMISSION
uniform sampler2D fcBackMap;
uniform sampler2D fcBackDepth;
uniform mat4 fcInvViewProj;
uniform float fcActive;
uniform float fcBodyId;

vec2 fcScreenUv( const in vec3 p, const in mat4 viewMatrix, const in mat4 projMatrix ) {
	vec4 c = projMatrix * viewMatrix * vec4( p, 1.0 );
	return c.xy / c.w * 0.5 + 0.5;
}

vec4 fcVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
	const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
	const in mat4 viewMatrix, const in mat4 projMatrix, const in float dispersion, const in float ior,
	const in float thickness, const in bool hit, const in vec3 backNormal,
	const in vec3 attenuationColor, const in float attenuationDistance ) {
	vec4 transmittedLight = vec4( 0.0 );
	vec3 transmittance = vec3( 0.0 );
	vec3 iors = vec3( ior );
	#ifdef USE_DISPERSION
		float halfSpread = ( ior - 1.0 ) * 0.025 * dispersion;
		iors = vec3( ior - halfSpread, ior, ior + halfSpread );
		const int FC_RAYS = 3;
	#else
		const int FC_RAYS = 1;
	#endif
	for ( int i = 0; i < FC_RAYS; i ++ ) {
		vec3 exitPoint;
		vec3 samplePoint;
		if ( hit ) {
			vec3 r1 = normalize( refract( - v, normalize( n ), 1.0 / iors[ i ] ) );
			exitPoint = position + r1 * ( thickness / max( dot( r1, - v ), 0.2 ) );
			vec4 eb = texture2D( fcBackMap, fcScreenUv( exitPoint, viewMatrix, projMatrix ) );
			vec3 nExit = abs( eb.w - fcBodyId ) < 0.5 ? eb.xyz : backNormal;
			vec3 r2 = refract( r1, - normalize( nExit ), iors[ i ] );
			if ( dot( r2, r2 ) < 1e-6 ) r2 = r1;
			samplePoint = exitPoint + ( normalize( r2 ) + v ) * thickness;
		} else {
			exitPoint = position + getVolumeTransmissionRay( n, v, thickness, iors[ i ], modelMatrix );
			samplePoint = exitPoint;
		}
		vec4 s = getTransmissionSample( fcScreenUv( samplePoint, viewMatrix, projMatrix ), roughness, iors[ i ] );
		vec3 att = diffuseColor * volumeAttenuation( length( exitPoint - position ), attenuationColor, attenuationDistance );
		#ifdef USE_DISPERSION
			transmittedLight[ i ] = s[ i ];
			transmittedLight.a += s.a / 3.0;
			transmittance[ i ] = att[ i ];
		#else
			transmittedLight = s;
			transmittance = att;
		#endif
	}
	vec3 attenuatedColor = transmittance * transmittedLight.rgb;
	vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
	float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
	return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
}
#endif
`;

const FRAGMENT = /* glsl */`
#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = inverseTransformDirection( normal, viewMatrix );
	float fcThick = material.thickness;
	bool fcHit = false;
	vec3 fcBackN = - n;
	if ( fcActive > 0.5 && gl_FrontFacing ) {
		vec2 suv = gl_FragCoord.xy / vec2( textureSize( fcBackDepth, 0 ) );
		float bd = texture2D( fcBackDepth, suv ).r;
		vec4 bk = texture2D( fcBackMap, suv );
		if ( bd < 1.0 && bd > gl_FragCoord.z && abs( bk.w - fcBodyId ) < 0.5 ) {
			vec4 wp = fcInvViewProj * vec4( vec3( suv, bd ) * 2.0 - 1.0, 1.0 );
			fcThick = distance( wp.xyz / wp.w, pos );
			fcHit = true;
			fcBackN = bk.xyz;
		}
	}
	vec4 transmitted = fcVolumeRefraction(
		n, v, material.roughness, material.diffuseColor, material.specularColor, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, fcThick, fcHit, fcBackN,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif
`;

type Compile = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;
type KeyFn = () => string;
interface Patched {
  mesh: THREE.Mesh;
  id: { value: number };
  inner: Compile | undefined;
  innerKey: KeyFn | undefined;
  wrapper: Compile;
}
const patched = new WeakMap<THREE.Material, Patched>();
const ids = new WeakMap<THREE.Mesh, number>();
let nextId = 0;

function idOf(mesh: THREE.Mesh): number {
  let id = ids.get(mesh);
  if (id === undefined) {
    // Kept below 2048, the largest run of integers a half float holds exactly.
    id = (nextId++ % 2047) + 1;
    ids.set(mesh, id);
  }
  return id;
}

/** The transmission chunk, with the auto thickness copy swapped in. Exported for
 *  the tripwire test, which checks three still has the include this replaces. */
export function patchGlassShader(shader: { fragmentShader: string; uniforms: Record<string, THREE.IUniform> }, id: { value: number }): void {
  Object.assign(shader.uniforms, shared, { fcBodyId: id });
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <transmission_pars_fragment>", "#include <transmission_pars_fragment>\n" + PARS)
    .replace("#include <transmission_fragment>", FRAGMENT);
}

function own<K extends "onBeforeCompile" | "customProgramCacheKey">(m: THREE.Material, k: K): THREE.Material[K] | undefined {
  return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
}

/** Turn the per pixel thickness on for `mat`, drawn on `mesh`, or off with null.
 *  Composes with a surface patch already on the material: proceduralSurface
 *  sets or deletes its own onBeforeCompile first, this wraps whatever is there. */
export function setGlassAuto(mat: THREE.Material, mesh: THREE.Mesh | null): void {
  const was = patched.get(mat);
  const cur = own(mat, "onBeforeCompile") as Compile | undefined;
  const stillOurs = !!was && cur === was.wrapper;
  const inner = stillOurs ? was!.inner : cur;
  const innerKey = stillOurs ? was!.innerKey : (own(mat, "customProgramCacheKey") as KeyFn | undefined);
  if (!mesh) {
    if (!was) return;
    patched.delete(mat);
    if (!stillOurs) return;
    const m = mat as { onBeforeCompile?: unknown; customProgramCacheKey?: unknown };
    if (inner) m.onBeforeCompile = inner; else delete m.onBeforeCompile;
    if (innerKey) m.customProgramCacheKey = innerKey; else delete m.customProgramCacheKey;
    mat.needsUpdate = true;
    return;
  }
  if (stillOurs && was!.mesh === mesh) return;
  const id = was?.id ?? { value: 0 };
  id.value = idOf(mesh);
  const wrapper: Compile = (shader, renderer) => {
    inner?.(shader, renderer);
    patchGlassShader(shader, id);
  };
  mat.onBeforeCompile = wrapper;
  mat.customProgramCacheKey = () => (innerKey ? innerKey() : "") + "|glass-auto";
  patched.set(mat, { mesh, id, inner, innerKey, wrapper });
  if (!stillOurs) mat.needsUpdate = true;
}

export function isGlassAuto(mat: THREE.Material): boolean {
  return patched.has(mat);
}

// Glass bodies with auto thickness, and which of their material slots are glass
// (null when the mesh has one material).
const bodies = new Map<THREE.Mesh, boolean[] | null>();

export function registerGlass(mesh: THREE.Mesh, slots: boolean[]): void {
  if (!slots.some(Boolean)) bodies.delete(mesh);
  else bodies.set(mesh, slots.length === 1 ? null : slots);
}

export function glassBodyCount(): number {
  return bodies.size;
}

const BACK_VERTEX = /* glsl */`
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vFcNormal;
void main() {
	#include <begin_vertex>
	#include <project_vertex>
	#include <clipping_planes_vertex>
	vFcNormal = normalize( mat3( modelMatrix ) * normal );
}
`;
const BACK_FRAGMENT = /* glsl */`
#include <clipping_planes_pars_fragment>
uniform float uId;
varying vec3 vFcNormal;
void main() {
	#include <clipping_planes_fragment>
	gl_FragColor = vec4( normalize( vFcNormal ), uId );
}
`;

function visibleChain(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Renders the back faces of every auto glass body before the frame. Allocates
 *  nothing and draws nothing while no such body exists. */
export class GlassBackPass {
  private target: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private proxies = new Map<THREE.Mesh, { proxy: THREE.Mesh; mat: THREE.ShaderMaterial }>();
  private hidden = new THREE.MeshBasicMaterial({ visible: false });
  private size = new THREE.Vector2();
  private clear = new THREE.Color();

  constructor() {
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** True when the glass shaders may read the pass this frame; call end() after
   *  the frame so a render elsewhere (a swatch, a still) falls back cleanly. */
  begin(renderer: THREE.WebGLRenderer, camera: THREE.Camera): boolean {
    shared.fcActive.value = 0;
    let any = false;
    for (const [mesh, slots] of bodies) {
      if (!mesh.parent) {
        bodies.delete(mesh);
        continue;
      }
      let entry = this.proxies.get(mesh);
      if (!entry) {
        const mat = new THREE.ShaderMaterial({
          vertexShader: BACK_VERTEX, fragmentShader: BACK_FRAGMENT,
          uniforms: { uId: { value: 0 } }, side: THREE.BackSide, clipping: true,
        });
        const proxy = new THREE.Mesh(mesh.geometry, mat);
        proxy.matrixAutoUpdate = false;
        entry = { proxy, mat };
        this.proxies.set(mesh, entry);
        this.scene.add(proxy);
      }
      const { proxy, mat } = entry;
      proxy.visible = visibleChain(mesh);
      if (!proxy.visible) continue;
      any = true;
      mesh.updateWorldMatrix(true, false);
      proxy.matrixWorld.copy(mesh.matrixWorld);
      proxy.geometry = mesh.geometry;
      mat.uniforms["uId"]!.value = idOf(mesh);
      const real = mesh.material;
      const list = Array.isArray(real) ? real : [real];
      const glassAt = list.findIndex((m) => isGlassAuto(m));
      mat.clippingPlanes = (glassAt >= 0 ? list[glassAt] : list[0])?.clippingPlanes ?? null;
      proxy.material = slots && Array.isArray(real) && real.length === slots.length
        ? slots.map((g) => (g ? mat : this.hidden))
        : mat;
    }
    for (const [mesh, { proxy, mat }] of this.proxies) {
      if (bodies.has(mesh)) continue;
      this.scene.remove(proxy);
      mat.dispose();
      this.proxies.delete(mesh);
    }
    if (!any) {
      if (bodies.size === 0) this.release();
      return false;
    }
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x)), h = Math.max(1, Math.floor(this.size.y));
    if (!this.target) {
      const depth = new THREE.DepthTexture(w, h, THREE.FloatType);
      this.target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        generateMipmaps: false, depthBuffer: true, depthTexture: depth,
      });
    } else if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this.clear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.autoClear = false;
    try {
      renderer.render(this.scene, camera);
    } finally {
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this.clear, prevAlpha);
    }
    const cam = camera as THREE.PerspectiveCamera;
    shared.fcInvViewProj.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
    shared.fcBackMap.value = this.target.texture;
    shared.fcBackDepth.value = this.target.depthTexture;
    shared.fcActive.value = 1;
    return true;
  }

  end(): void {
    shared.fcActive.value = 0;
  }

  private release(): void {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.target = null;
    shared.fcBackMap.value = null;
    shared.fcBackDepth.value = null;
  }

  dispose(): void {
    for (const { proxy, mat } of this.proxies.values()) {
      this.scene.remove(proxy);
      mat.dispose();
    }
    this.proxies.clear();
    this.hidden.dispose();
    this.release();
  }
}
