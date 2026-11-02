// A real DocumentStore and controller over a fake engine and viewport, for what the Geometry list sits on.
import { vi } from "vitest";
import { createGeometryBrowser, type GeometryBrowserHost } from "../../src/app/geometryBrowser";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import { useGeometryBrowserStore } from "../../src/stores/geometryBrowser";
import { useSelectionStore } from "../../src/stores/selection";
import type { CadDocument, Feature, PlaneDef, RebuildResult, TopologyFace, TopologyReply } from "../../src/types";
import type { EdgeRef } from "../../src/viewport/edgeLines";

type Bodies = NonNullable<RebuildResult["bodies"]>;
export type BodySpec = Partial<Bodies[number]> & { id: string };

export function result(specs: BodySpec[]): RebuildResult {
  let start = 0;
  const bodies = specs.map((s) => {
    const body = { name: s.id.toUpperCase(), faceStart: start, faceCount: 3, ...s };
    start = body.faceStart + body.faceCount;
    return body;
  });
  return {
    mesh: { positions: [113.5, -41.25, 37], indices: [0], faceIds: [0] },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    bodies,
  };
}
export const DOC = {
  parameters: {},
  features: [{ id: "f1", type: "box", name: "Base block", length: 40, width: 30, height: 20 }],
} as unknown as CadDocument;

export function plane(i: number, area = 24 + i): TopologyFace {
  return { i, surface: "plane", area, normal: [0, 0, 1], size: [40 + i, 6], centroid: [113.5 + i, -41.25, 37] };
}
export function topology(body: string, faces = 3, edgeFaces?: number[][]): TopologyReply {
  return {
    body,
    faceCount: faces,
    faces: Array.from({ length: faces }, (_, i) => plane(i)),
    ...(edgeFaces ? { edgeFaces } : {}),
  };
}

export interface Ask {
  body: string;
  opts: unknown;
  id: string;
  doc: CadDocument;
  answer(r: TopologyReply | null): void;
  fail(err: unknown): void;
}

export function edge(body: string, slot: number, wires: number): EdgeRef {
  return {
    id: `${body}:${slot}`,
    body,
    slot,
    smooth: false,
    points: [
      [10 + slot, -4, 2],
      [10 + slot, 16, 7],
    ],
    draw: { refs: { length: wires } },
  } as unknown as EdgeRef;
}

export function rig(
  first: RebuildResult = result([
    { id: "body1", etag: "e1" },
    { id: "body2", etag: "e2" },
  ]),
) {
  const asks: Ask[] = [];
  const cancel = vi.fn(async () => true);
  const state = { result: first };
  const geometry = {
    softCancel: true,
    cancel,
    async rebuild() {
      return { ok: true as const, result: state.result };
    },
    topology(doc: CadDocument, body: string, opts: unknown, onStarted?: (id: string) => void) {
      const id = `req${asks.length + 1}`;
      onStarted?.(id);
      return new Promise<TopologyReply | null>((answer, fail) => asks.push({ body, opts, id, doc, answer, fail }));
    },
    async init() {},
    onStatus: () => () => {},
    onProgress: () => () => {},
  } as unknown as GeometryBackend;
  const store = new DocumentStore(geometry, DOC);

  const selection = { faces: [] as number[], edges: [] as EdgeRef[], bodies: [] as string[] };
  const wires = new Map<string, EdgeRef[]>();
  const viewport = {
    applyPicks: vi.fn(),
    hoverPick: vi.fn(),
    hoverPlane: vi.fn(),
    hoverDatum: vi.fn(),
    faceTriangles: () => [],
    bodyEdgeRefs: vi.fn((id: string) => wires.get(id) ?? []),
    faceIdToBodyId: (faceId: number) =>
      store.buildState.result?.bodies?.find((b) => faceId >= b.faceStart && faceId < b.faceStart + b.faceCount)?.id ??
      null,
    getSelectedBodies: () => selection.bodies,
    getSelectedFaceIds: () => selection.faces,
    selectedEdgeLines: () => selection.edges,
    selectionBodyIds(): string[] {
      const owners = selection.faces.map((f) => viewport.faceIdToBodyId(f)!);
      return [...new Set([...selection.bodies, ...owners, ...selection.edges.map((x) => x.body!)])];
    },
    policy: "auto" as "auto" | "faces" | "bodies",
    picksSuspended: false,
    modelUnsettled: false,
  };
  const host = {
    store,
    geometry,
    viewport,
    sketch: { active: false, enter: vi.fn() },
    datumPlaneDef: vi.fn((f: Feature & { plane?: PlaneDef }) => f.plane),
    selectFeatureRows: vi.fn((next: { keys: readonly string[]; anchor: string | null }, primary: string | null) => {
      const sel = useSelectionStore();
      sel.rows = next as typeof sel.rows;
      sel.featureId = primary;
    }),
    setStatus: vi.fn(),
    toolBusy: vi.fn(() => false),
    toolOwnsScreen: vi.fn(() => false),
    dropBodyGizmo: vi.fn(),
    handleAction: vi.fn(),
  };
  const browser = createGeometryBrowser(host as unknown as GeometryBrowserHost);
  store.onBuild((s) => browser.buildChanged(s));
  const list = useGeometryBrowserStore();
  const build = async (next?: RebuildResult) => {
    if (next) state.result = next;
    await store.rebuildNow();
    await settle();
  };
  return { asks, cancel, state, store, selection, wires, viewport, host, browser, list, build };
}
export const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
export const land = async (a: Ask, r: TopologyReply | null) => {
  a.answer(r);
  await settle();
};
export const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key);
