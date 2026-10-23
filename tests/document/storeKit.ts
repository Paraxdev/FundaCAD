import { DocumentStore } from "../../src/document/store";
import type { Feature, StressStudy } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

export const box = (id: string, length: number, width = 7.5, height = 3.25) =>
  ({ id, type: "box", length, width, height }) as unknown as Feature;

// Every rebuild fails at once, so a test sees only what the store itself does.
export const stubBackend = {
  async rebuild() {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() {
    return () => {};
  },
  onProgress() {
    return () => {};
  },
  async cancel() {
    return true;
  },
  connected: true,
} as unknown as GeometryBackend;

export const freshStore = () => new DocumentStore(stubBackend, { parameters: {}, features: [] });

export function opened(doc: object): DocumentStore {
  const s = freshStore();
  s.load(JSON.stringify({ parameters: {}, features: [], ...doc }));
  return s;
}

export const saved = (s: DocumentStore) => JSON.parse(s.toJSON()) as Record<string, unknown>;

export const reopened = (s: DocumentStore) => opened(JSON.parse(s.toJSON()) as object);

export const study: StressStudy = {
  body: "body1",
  supports: [{ id: 1, type: "fixed", faces: [{ kind: "face", by: "nearest", point: [3.5, -2, 0.75], body: "body1" }] }],
  loads: [
    {
      id: 1,
      kind: "force",
      faces: [{ kind: "face", by: "nearest", point: [12.5, 4, 3.25], body: "body1" }],
      force: 20,
      direction: "-Z",
      custom: [0.2, -0.1, -1],
      pressure: 0.1,
    },
  ],
  gravity: { on: false, direction: "-Z" },
  material: "PETG",
  custom: { E: 2000, nu: 0.35, yield: 40, density: 1.2 },
  size: null,
};

export const env = (exposure: number) => ({ settings: { exposure } }) as never;
