// Builds a big body's pick tree off the main thread, see raycastIndex.ts.
import { buildPickTree, type PickTreeJob } from "./pickTree";

self.onmessage = (e: MessageEvent<{ id: number; job: PickTreeJob }>) => {
  const { id, job } = e.data;
  try {
    const tree = buildPickTree(job);
    const transfer = [...tree.roots, ...(tree.indirectBuffer ? [tree.indirectBuffer.buffer] : [])];
    (self as unknown as Worker).postMessage({ id, tree }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
