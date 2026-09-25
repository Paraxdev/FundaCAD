// Potato mode's draw. For the length of one render every PBR material is swapped
// for a Lambert twin, every fat line (LineSegments2, Line2) for a plain 1px
// LineSegments twin, and the emitter lights are hidden, then everything is put
// back. The real materials and objects are never written to, so turning potato
// mode off restores them exactly, and picking still raycasts the real objects.
//
// The frame is drawn into a target with no multisampling and copied to the
// canvas, because the canvas was created with antialias and that cannot be
// turned off on a live context.

import * as THREE from "three";

/** Drawing buffer pixels per CSS pixel. Picked by measurement under SwiftShader. */
export const POTATO_PIXEL_RATIO = 0.5;

/** Stands in for the light the environment map gave, which Lambert cannot use. */
const AMBIENT = 1.8;

/** A 1px line at half resolution loses the depth test to its own face far more
 *  often than a fat line did, so the faces are pushed further back. */
const FACE_OFFSET_FACTOR = 2;
const FACE_OFFSET_UNITS = 4;

/** A twin nobody has drawn for this many potato frames is disposed. */
const PRUNE_AFTER_FRAMES = 30;

/** Plain Material fields copied onto a twin every frame. None of them changes the
 *  shader program, so copying them never recompiles. */
const MIRRORED = [
  "side", "transparent", "opacity", "alphaTest", "blending", "premultipliedAlpha",
  "depthTest", "depthWrite", "depthFunc", "colorWrite",
  "polygonOffset", "polygonOffsetFactor", "polygonOffsetUnits",
  "stencilWrite", "stencilFunc", "stencilRef", "stencilFuncMask", "stencilWriteMask",
  "stencilFail", "stencilZFail", "stencilZPass",
  "clippingPlanes", "clipIntersection", "visible",
] as const;

function mirror(dst: THREE.Material, src: THREE.Material) {
  const d = dst as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  for (const k of MIRRORED) if (d[k] !== s[k]) d[k] = s[k];
}

/** Anything three draws through the PBR path: Standard, and Physical which extends it. */
function isPbr(m: THREE.Material): m is THREE.MeshStandardMaterial {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
}

interface FatLine extends THREE.Mesh {
  isLineSegments2: true;
  material: THREE.Material & { color: THREE.Color; vertexColors: boolean };
}

function isFatLine(o: THREE.Object3D): o is FatLine {
  return (o as { isLineSegments2?: boolean }).isLineSegments2 === true;
}

function isCostlyLight(o: THREE.Object3D): boolean {
  const l = o as { isRectAreaLight?: boolean; isPointLight?: boolean; isSpotLight?: boolean };
  return l.isRectAreaLight === true || l.isPointLight === true || l.isSpotLight === true;
}

interface MatTwin { cheap: THREE.MeshLambertMaterial; seen: number }
interface LineTwin {
  proxy: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  source: THREE.BufferGeometry;
  posData: THREE.InterleavedBuffer;
  colData: THREE.InterleavedBuffer | null;
  posVersion: number;
  colVersion: number;
  seen: number;
}

export class PotatoDraw {
  private mats = new Map<THREE.Material, MatTwin>();
  private lines = new Map<FatLine, LineTwin>();
  private proxies = new THREE.Group();
  private ambient = new THREE.AmbientLight(0xffffff, AMBIENT);
  private frame = 0;
  private swapped: { mesh: THREE.Mesh; was: THREE.Material | THREE.Material[] }[] = [];
  private hidden: THREE.Object3D[] = [];
  private target: THREE.WebGLRenderTarget | null = null;
  private copy: { scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial } | null = null;
  private size = new THREE.Vector2();

  constructor() {
    this.proxies.name = "potato-lines";
    this.proxies.matrixAutoUpdate = false;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, brightness = 1) {
    this.frame++;
    this.ambient.intensity = AMBIENT * brightness;
    // The line twins copy their source's world matrix, so it has to be current.
    scene.updateMatrixWorld();
    this.proxies.clear();
    scene.traverseVisible((o) => this.visit(o));
    this.proxies.add(this.ambient);
    scene.add(this.proxies);
    const target = this.frameTarget(renderer);
    const before = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(before);
      scene.remove(this.proxies);
      for (const { mesh, was } of this.swapped) mesh.material = was;
      for (const o of this.hidden) o.visible = true;
      this.swapped.length = 0;
      this.hidden.length = 0;
      this.prune();
    }
    const copy = this.copy!;
    copy.material.uniforms.map!.value = target.texture;
    renderer.render(copy.scene, copy.camera);
  }

  private frameTarget(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    renderer.getDrawingBufferSize(this.size);
    if (!this.target) {
      // Stencil kept: the section caps draw through it.
      this.target = new THREE.WebGLRenderTarget(this.size.x, this.size.y, {
        depthBuffer: true, stencilBuffer: true, colorSpace: THREE.SRGBColorSpace,
      });
      // Note: three only tone maps and encodes to sRGB when drawing to the canvas
      // or to an XR target. Flagged as one, and stored as plain RGBA8, this target
      // gets the same encoded values and the same blending the canvas would, so
      // the grid and the see-through planes keep their brightness.
      this.target.texture.internalFormat = "RGBA8";
      (this.target as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
      const material = new THREE.ShaderMaterial({
        uniforms: { map: { value: null } },
        vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
        fragmentShader: "uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }",
        depthTest: false,
        depthWrite: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      quad.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(quad);
      this.copy = { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
    } else if (this.target.width !== this.size.x || this.target.height !== this.size.y) {
      this.target.setSize(this.size.x, this.size.y);
    }
    return this.target;
  }

  /** How many twins are held, for tests and diagnostics. */
  get held(): { materials: number; lines: number } {
    return { materials: this.mats.size, lines: this.lines.size };
  }

  dispose() {
    for (const t of this.mats.values()) t.cheap.dispose();
    for (const t of this.lines.values()) this.disposeLine(t);
    this.mats.clear();
    this.lines.clear();
    this.proxies.clear();
    this.target?.dispose();
    this.target = null;
    if (this.copy) {
      this.copy.material.dispose();
      (this.copy.scene.children[0] as THREE.Mesh).geometry.dispose();
      this.copy = null;
    }
  }

  private visit(o: THREE.Object3D) {
    if (o === this.proxies) return;
    if (isCostlyLight(o)) {
      o.visible = false;
      this.hidden.push(o);
      return;
    }
    if (isFatLine(o)) {
      const proxy = this.lineTwin(o);
      if (proxy) {
        o.visible = false;
        this.hidden.push(o);
        this.proxies.add(proxy);
      }
      return;
    }
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const was = mesh.material;
    if (Array.isArray(was)) {
      if (!was.some(isPbr)) return;
      mesh.material = was.map((m) => (isPbr(m) ? this.matTwin(m) : m));
    } else {
      if (!isPbr(was)) return;
      mesh.material = this.matTwin(was);
    }
    this.swapped.push({ mesh, was });
  }

  private matTwin(src: THREE.MeshStandardMaterial): THREE.MeshLambertMaterial {
    let t = this.mats.get(src);
    if (!t) {
      t = { cheap: new THREE.MeshLambertMaterial(), seen: 0 };
      t.cheap.name = `potato:${src.name}`;
      this.mats.set(src, t);
    }
    t.seen = this.frame;
    const c = t.cheap;
    mirror(c, src);
    c.polygonOffset = true;
    c.polygonOffsetFactor = Math.max(src.polygonOffsetFactor, FACE_OFFSET_FACTOR);
    c.polygonOffsetUnits = Math.max(src.polygonOffsetUnits, FACE_OFFSET_UNITS);
    c.color.copy(src.color);
    c.wireframe = src.wireframe;
    // These three shape the compiled program, which three only rebuilds on a version bump.
    if (c.vertexColors !== src.vertexColors || c.flatShading !== src.flatShading || !!c.map !== !!src.map) {
      c.vertexColors = src.vertexColors;
      c.flatShading = src.flatShading;
      c.needsUpdate = true;
    }
    c.map = src.map;
    return c;
  }

  private lineTwin(line: FatLine): THREE.LineSegments | null {
    const geo = line.geometry;
    const start = geo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute | undefined;
    if (!start?.data) return null;
    const colStart = geo.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute | undefined;
    let t = this.lines.get(line);
    if (t && (t.source !== geo || t.posData !== start.data || t.colData !== (colStart?.data ?? null))) {
      this.disposeLine(t);
      this.lines.delete(line);
      t = undefined;
    }
    if (!t) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(start.data.array as Float32Array, 3));
      if (colStart?.data) g.setAttribute("color", new THREE.BufferAttribute(colStart.data.array as Float32Array, 3));
      const proxy = new THREE.LineSegments(g, new THREE.LineBasicMaterial());
      proxy.matrixAutoUpdate = false;
      t = {
        proxy, source: geo, posData: start.data, colData: colStart?.data ?? null,
        posVersion: start.data.version, colVersion: colStart?.data.version ?? 0, seen: 0,
      };
      this.lines.set(line, t);
    }
    t.seen = this.frame;
    if (t.posData.version !== t.posVersion) {
      t.posVersion = t.posData.version;
      t.proxy.geometry.getAttribute("position").needsUpdate = true;
      t.proxy.geometry.boundingSphere = null;
    }
    if (t.colData && t.colData.version !== t.colVersion) {
      t.colVersion = t.colData.version;
      t.proxy.geometry.getAttribute("color").needsUpdate = true;
    }
    const segments = Math.min(start.count, (geo as THREE.InstancedBufferGeometry).instanceCount ?? Infinity);
    t.proxy.geometry.setDrawRange(0, segments * 2);

    const p = t.proxy;
    p.matrix.copy(line.matrixWorld);
    p.matrixWorld.copy(line.matrixWorld);
    p.renderOrder = line.renderOrder;
    p.layers.mask = line.layers.mask;
    p.frustumCulled = line.frustumCulled;
    const m = p.material;
    mirror(m, line.material);
    m.color.copy(line.material.color);
    const vc = line.material.vertexColors && t.colData !== null;
    if (m.vertexColors !== vc) {
      m.vertexColors = vc;
      m.needsUpdate = true;
    }
    return p;
  }

  private disposeLine(t: LineTwin) {
    t.proxy.geometry.dispose();
    t.proxy.material.dispose();
  }

  private prune() {
    for (const [src, t] of this.mats) {
      if (this.frame - t.seen > PRUNE_AFTER_FRAMES) {
        t.cheap.dispose();
        this.mats.delete(src);
      }
    }
    for (const [line, t] of this.lines) {
      if (this.frame - t.seen > PRUNE_AFTER_FRAMES) {
        this.disposeLine(t);
        this.lines.delete(line);
      }
    }
  }
}
