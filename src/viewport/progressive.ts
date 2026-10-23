// Without this a large assembly shows the previous document for minutes while a reply streams in. Bodies are keyed
// by id and etag as setModel keys them, so the commit reuses them and stays authoritative over anything shown here.

import * as THREE from "three";
import { pushAll } from "../lib/pushAll";
import { buildBodyMesh, partitionMesh, resetBodyAppearance, reuseUnchanged } from "./render";
import type { BodyMesh, MeshPartition, ModelView } from "./render";
import type { EdgeRef } from "./edgeLines";
import type { RebuildResult } from "../types";

type BodyMeta = NonNullable<RebuildResult["bodies"]>[number];

/** Mirrors the disposal viewport.setModel does for a body that has gone away. */
type DisposeFn = (b: BodyMesh) => void;

/** Shared empty keep-set, so abort() allocates nothing. */
const EMPTY: ReadonlySet<BodyMesh> = new Set<BodyMesh>();

export class ProgressiveModel {
  private slots: (BodyMesh | null)[] = [];
  private byId = new Map<string, number>();
  /** Bodies from the PREVIOUS model whose etag changed: kept on screen, and
   *  swapped only when their replacement lands, so an edit-stream never shows a
   *  hole where a body used to be. */
  private stale = new Map<string, BodyMesh>();
  private edges: EdgeRef[] = [];
  private box = new THREE.Box3();
  private remap: Int32Array | null = null;
  private view: ModelView | null = null;
  private epoch = -1;

  constructor(
    private readonly group: THREE.Group,
    private readonly dispose: DisposeFn,
  ) {}

  get current(): ModelView | null {
    return this.view;
  }
  get streaming(): boolean {
    return this.epoch >= 0;
  }
  get filled(): number {
    return this.slots.reduce((n, b) => n + (b ? 1 : 0), 0);
  }
  get total(): number {
    return this.slots.length;
  }

  /** `manifest` is authoritative: a previous body it does not name is gone. A stream started over a running
   *  one reuses the bodies that one holds, so nothing is disposed until this method knows what it wants. */
  begin(
    epoch: number,
    manifest: BodyMeta[],
    result: RebuildResult,
    box: THREE.Box3,
    prev: ModelView | null,
    hidden: Set<string>,
  ): ModelView {
    // The bodies the last installment published, plus any the old stream still held in place of a body
    // whose chunk never came: all candidates to reuse, replace or drop.
    const keptById = new Map<string, BodyMesh>();
    for (const b of prev?.bodies ?? []) keptById.set(b.id, b);
    for (const [id, b] of this.stale) if (!keptById.has(id)) keptById.set(id, b);

    this.release(new Set(keptById.values()));
    this.epoch = epoch;
    this.box = box;
    this.slots = new Array(manifest.length).fill(null);
    this.byId = new Map(manifest.map((m, i) => [m.id, i]));
    this.edges = [];
    // One scratch buffer for the whole stream, which buildBodyMesh hands back clean, instead of a model
    // sized Int32Array per chunk.
    this.remap = new Int32Array(result.mesh.positions.length / 3).fill(-1);

    for (const m of manifest) {
      const p = keptById.get(m.id);
      if (!p) continue;
      keptById.delete(m.id);
      if (reuseUnchanged(p, m)) {
        // unchanged: keep its GPU objects untouched. It never blinks.
        resetBodyAppearance(p);
        p.mesh.visible = !hidden.has(m.id);
        p.edges.setBodyVisible(p.mesh.visible);
        this.slots[this.byId.get(m.id)!] = p;
        pushAll(this.edges, p.edges.refs);
      } else {
        this.stale.set(m.id, p); // hold it on screen until its chunk lands
      }
    }
    // whatever the manifest never named is gone from this document
    for (const gone of keptById.values()) this.remove(gone);
    return this.snapshot();
  }

  /** Add the bodies one chunk delivered. Returns null if the chunk belongs to a
   *  stream we are no longer running. */
  append(
    epoch: number,
    result: RebuildResult,
    metas: BodyMeta[],
    edgesByBody: Map<string, RebuildResult["edges"]>,
    triRange: { triStart: number; triEnd: number },
    hidden: Set<string>,
    resolution: THREE.Vector2,
  ): ModelView | null {
    if (epoch !== this.epoch) return null;
    const wanted = metas.filter((m) => {
      const i = this.byId.get(m.id);
      return i !== undefined && this.slots[i] === null;
    });
    if (!wanted.length) return this.view;

    // Ranged, because unwritten triangles are still zeros and zero is a legitimate faceId, so an unranged
    // pass would hand them all to whoever owns face 0.
    const partition: MeshPartition = partitionMesh(
      result,
      wanted.map((m) => m.id),
      { range: triRange, ...(this.remap ? { remap: this.remap } : {}) },
    );
    for (const m of wanted) {
      const body = buildBodyMesh(result, m, edgesByBody.get(m.id) ?? [], resolution, m.etag, partition);
      this.group.add(body.mesh);
      this.group.add(body.edges.object);
      const old = this.stale.get(m.id);
      if (old) {
        this.remove(old);
        this.stale.delete(m.id);
      } // atomic swap
      body.mesh.visible = !hidden.has(m.id);
      body.edges.setBodyVisible(body.mesh.visible);
      body.edges.flush();
      this.slots[this.byId.get(m.id)!] = body;
      pushAll(this.edges, body.edges.refs);
    }
    return this.snapshot();
  }

  /** Tear down everything this stream put on screen, including bodies it was
   *  holding from the previous model. Used when a stream cannot finish. */
  abort() {
    this.release(EMPTY);
  }

  /** A body still in `stale` never reached the ModelView the viewport adopted, so the commit would build it
   *  fresh beside the old mesh, z-fighting with doubled edges. Disposing here keeps that rebuild correct. */
  finish() {
    for (const b of this.stale.values()) this.remove(b);
    this.reset();
  }

  /** `keep` hands bodies to the next stream without a disposed state on the way. Membership is by object,
   *  not id: the swap makes two meshes for one body id, and the old one still has to go. */
  private release(keep: ReadonlySet<BodyMesh>) {
    for (const b of this.slots) if (b && !keep.has(b)) this.remove(b);
    for (const b of this.stale.values()) if (!keep.has(b)) this.remove(b);
    this.reset();
  }

  private reset() {
    this.slots = [];
    this.byId.clear();
    this.stale.clear();
    this.edges = [];
    this.remap = null;
    this.view = null;
    this.epoch = -1;
  }

  private remove(b: BodyMesh) {
    this.group.remove(b.mesh);
    this.group.remove(b.edges.object);
    this.dispose(b);
  }

  /** A fresh object every time: render.ts's faceIndexCache and Highlighter.byId are keyed on ModelView
   *  identity, so mutating one in place would paint hover on the wrong body. Nothing is copied. */
  private snapshot(): ModelView {
    const bodies: BodyMesh[] = [];
    for (const b of this.slots) if (b) bodies.push(b);
    this.view = { bodies, edges: this.edges, orphanEdges: null, box: this.box };
    return this.view;
  }
}
