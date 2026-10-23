// three-gpu-pathtracer's setScene recompiles three WGSL kernels (1.6 to 2.6 s). three r186 rebinds a swapped
// proxy node, so new buffers go into the kernels' own nodes as upstream's updateMaterials does (0.0.27 internals).

interface Disposable {
  dispose(): void;
}

/** A storage or struct node as the tracer holds it. */
interface RawNode {
  value: Disposable | null;
}

/** Every member of BVHComputeData's storage and structs reads back as a proxy
 *  that resolves to the node currently assigned, through `proxyNode`; an
 *  assignment stores the node itself. */
type Members = Record<string, unknown>;

export interface SwappableBvhData {
  storage: Members;
  structs: Members;
  attributes: Record<string, string>;
  update(): void;
  dispose(): void;
}

const layout = (d: SwappableBvhData) => Object.keys(d.attributes).sort().join(",");
const raw = (p: unknown) => (p as { proxyNode?: RawNode | null } | null)?.proxyNode ?? null;

/** False when the attribute layout changed, so the compiled kernels no longer
 *  match and the caller has to set the scene in full. */
export function repackInPlace(d: SwappableBvhData): boolean {
  const before = layout(d);
  const nodes = new Map(Object.keys(d.storage).map((k) => [k, raw(d.storage[k])] as const));
  const old = [...nodes.values()].map((n) => n?.value ?? null);
  const struct = raw(d.structs.attributes);
  const dispose = d.dispose;
  d.dispose = () => {};
  try {
    d.update();
  } finally {
    d.dispose = dispose;
  }
  const kept = layout(d) === before;
  if (kept) {
    for (const [k, n] of nodes) {
      const fresh = raw(d.storage[k]);
      if (!n || !fresh || fresh === n) continue;
      n.value = fresh.value;
      d.storage[k] = n;
    }
    if (struct) d.structs.attributes = struct;
  }
  const live = new Set(Object.keys(d.storage).map((k) => raw(d.storage[k])?.value ?? null));
  for (const v of old) if (v && !live.has(v)) v.dispose();
  return kept;
}
