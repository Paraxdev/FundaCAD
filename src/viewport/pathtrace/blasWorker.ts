import { buildBlas, type BlasJob } from "./blasCache";

self.onmessage = (e: MessageEvent<{ id: number; job: BlasJob }>) => {
  const { id, job } = e.data;
  try {
    const t = buildBlas(job);
    (self as unknown as Worker).postMessage({ id, tree: t }, [...t.roots, t.index.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
