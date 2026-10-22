// What the client and the engine share about one document session's model: the delta baseline and the mesh caches.
// A new session starts with an empty one, so its first rebuild is a whole document and no old mesh is kept alive.
import type { Feature, RebuildResult } from "../types";
import type { WireBodyFull } from "./assembly";

export class SessionWire {
  // Last full payload per body: the engine answers unchanged bodies with an etag stub instead of the multi-MB mesh,
  // and assemble() rebuilds the merged result from this cache.
  readonly bodyMesh = new Map<string, WireBodyFull>();
  /** The last assembled result and its reply signature, for assemble()'s no-op fast path. */
  lastAssembled: RebuildResult | null = null;
  lastAssembledSig: string | null = null;
  // Delta protocol: the engine worker holds the last document, so only features changed by reference are sent
  // (effectiveDoc() reuses unchanged objects). Any doubt (respawn, missed reply, many changes) sends it whole.
  lastSent: { features: Feature[]; parameters: string; bodyVisibility: string; bodyIds: string } | null = null;
}
