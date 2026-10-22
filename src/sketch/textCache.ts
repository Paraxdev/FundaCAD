// Client cache of engine-tessellated glyph outlines (the `tessellateText` op), keyed by content. A miss fires the
// op once and the overlay re-renders when it lands.

import type { GeometryBackend, TextFace } from "../geometry/client";
import type { ResolvedEntity } from "./snap";
import { LruCache } from "../lib/lruCache";

type TextEntity = Extract<ResolvedEntity, { type: "text" }>;

// A rotate or resize drag asks for a new outline every frame.
const cache = new LruCache<string, TextFace[]>(256);
const pending = new Set<string>();
let backend: { geom: GeometryBackend; rerender: () => void } | null = null;

export function setTextBackend(geom: GeometryBackend, rerender: () => void): void {
  backend = { geom, rerender };
}

function keyOf(e: TextEntity): string {
  return JSON.stringify([
    e.text,
    e.font ?? "",
    e.height,
    e.style ?? "regular",
    e.align ?? "left",
    e.angle,
    e.pathRef ?? "",
    e.positionOnPath ?? "",
    e.boxWidth ?? "",
  ]);
}

/** undefined until the op returns */
export function getCachedText(e: TextEntity): TextFace[] | undefined {
  return cache.get(keyOf(e));
}

export function fetchFonts(): Promise<string[]> {
  return backend ? backend.geom.listFonts() : Promise.resolve([]);
}

/** Safe to call on every paint, cached and in-flight entities are skipped. `entities` is the full resolved list so
 *  a text's `pathRef` sibling can be sent. */
export function warmText(entities: ResolvedEntity[]): void {
  if (!backend) return;
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    if (e.type !== "text") continue;
    const k = keyOf(e);
    if (cache.has(k) || pending.has(k)) continue;
    pending.add(k);
    const pathEntity = e.pathRef ? byId.get(e.pathRef) : undefined;
    backend.geom
      .tessellateText(e, pathEntity)
      .then((faces) => cache.set(k, faces))
      .catch(() => cache.set(k, []))
      .finally(() => {
        pending.delete(k);
        backend?.rerender();
      });
  }
}
