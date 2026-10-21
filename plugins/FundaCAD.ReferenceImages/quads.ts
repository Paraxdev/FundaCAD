// The images in the view: one textured quad each, on the "references" overlay
// layer, so the Display popover switches them and a picture leaves them out
// unless it asks.

import * as THREE from "three";
import { SketchPlane } from "fundacad";
import type { Engine, PlaneSpec } from "fundacad";
import { heightOf } from "./calibrate";
import { readRefImage, type RefImage } from "./refImage";

/** A 12 MP photo is a 48 MB texture; the file keeps every pixel, the view does not need them. */
const MAX_TEXTURE = 4096;

interface Quad {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  image: string;
}

export class ImageLayer {
  private quads = new Map<string, Quad>();
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  private missingIds = new Set<string>();
  private offs: (() => void)[] = [];
  /** Told when an image turns out to be missing from the blob store. */
  onMissing: (() => void) | null = null;

  constructor(private readonly e: Engine) {}

  start() {
    this.offs.push(this.e.store.onReferenceImagesChange(() => this.sync()));
    this.offs.push(this.e.store.onBuild(() => this.sync()));
  }

  stop() {
    for (const off of this.offs.splice(0)) off();
    for (const id of [...this.quads.keys()]) this.drop(id);
    void Promise.all(this.textures.values()).then((ts) => { for (const t of ts) t?.dispose(); });
    this.textures.clear();
  }

  missing(id: string): boolean {
    return this.missingIds.has(id);
  }

  /** Hand over bytes just put in the blob store, so the first draw does not fetch them back. */
  prime(hash: string, bytes: Uint8Array, mime: string) {
    if (!this.textures.has(hash)) this.textures.set(hash, textureFrom(bytes, mime));
  }

  /** The plane an image sits on now, following its datum. */
  planeOf(r: RefImage): SketchPlane {
    const datum = r.planeId ? this.e.store.buildState.result?.datumPlanes?.[r.planeId] : undefined;
    return new SketchPlane((datum ?? r.plane) as PlaneSpec);
  }

  sync() {
    const list = this.e.store.referenceImages().map(readRefImage).filter((r): r is RefImage => r !== null);
    const live = new Set(list.map((r) => r.id));
    for (const id of [...this.quads.keys()]) if (!live.has(id)) this.drop(id);
    for (const r of list) this.place(r);
    this.e.viewport.requestRender();
  }

  private place(r: RefImage) {
    let q = this.quads.get(r.id);
    if (!q) {
      const material = new THREE.MeshBasicMaterial({
        color: 0x9a9a9a, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      // Drawn first so the sketch on the same plane draws over it, and never
      // picked, so a click goes through to the face or curve behind it.
      mesh.renderOrder = -1;
      mesh.raycast = () => {};
      mesh.matrixAutoUpdate = false;
      mesh.userData.referenceImage = r.id;
      this.e.viewport.addToScene(mesh, "references");
      q = { mesh, material, image: "" };
      this.quads.set(r.id, q);
    }
    if (q.image !== r.image) {
      q.image = r.image;
      const id = r.id;
      const hash = r.image;
      void this.texture(hash).then((t) => {
        const now = this.quads.get(id);
        if (!now || now.image !== hash) return;
        if (t) {
          this.missingIds.delete(id);
          now.material.map = t;
          now.material.color.set(0xffffff);
        } else {
          this.missingIds.add(id);
          this.onMissing?.();
        }
        now.material.needsUpdate = true;
        this.e.viewport.requestRender();
      });
    }
    q.material.opacity = r.opacity;
    q.mesh.visible = !r.hidden;
    const frame = this.planeOf(r).basisMatrix();
    const local = new THREE.Matrix4()
      .makeTranslation(r.at[0], r.at[1], 0)
      .multiply(new THREE.Matrix4().makeRotationZ((r.angle * Math.PI) / 180))
      .multiply(new THREE.Matrix4().makeScale(r.width * (r.flipX ? -1 : 1), heightOf(r) * (r.flipY ? -1 : 1), 1));
    q.mesh.matrix.copy(frame.multiply(local));
    q.mesh.matrixWorldNeedsUpdate = true;
  }

  private texture(hash: string): Promise<THREE.Texture | null> {
    let t = this.textures.get(hash);
    if (!t) {
      const get = this.e.geometry.blobGet?.bind(this.e.geometry);
      t = get ? get(hash).then((b) => (b ? textureFrom(b, "") : null), () => null) : Promise.resolve(null);
      this.textures.set(hash, t);
      // A failed fetch is asked again next time, the engine may have come back.
      void t.then((x) => { if (!x && this.textures.get(hash) === t) this.textures.delete(hash); });
    }
    return t;
  }

  private drop(id: string) {
    const q = this.quads.get(id);
    if (!q) return;
    this.e.viewport.removeFromScene(q.mesh);
    q.mesh.geometry.dispose();
    q.material.dispose();
    this.quads.delete(id);
    this.missingIds.delete(id);
  }
}

/** Decoded from the bytes, which carry their own format, and cut to MAX_TEXTURE. */
export async function textureFrom(bytes: Uint8Array, mime: string): Promise<THREE.Texture | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], mime ? { type: mime } : {}));
    const k = Math.min(1, MAX_TEXTURE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  } catch {
    return null;
  }
}

export async function pixelSize(bytes: Uint8Array, mime: string): Promise<[number, number] | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const out: [number, number] = [bitmap.width, bitmap.height];
    bitmap.close();
    return out;
  } catch {
    return null;
  }
}
