// The Export dialog lists each body under the name the Items pane gives it, so bodies the engine named alike differ.
import { describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

const opened = vi.hoisted(() => ({ bodies: [] as { id: string; name: string }[][] }));
vi.mock("../../src/stores/exportDialog", () => ({
  useExportDialogStore: () => ({
    open: async (o: { bodies: { id: string; name: string }[] }) => {
      opened.bodies.push(o.bodies);
      return null;
    },
  }),
}));

const { exportModel } = await import("../../src/io/files");

function storeWith(bodies: { id: string; name: string }[], user: Record<string, string>): DocumentStore {
  return {
    session: { alive: true },
    buildState: { result: { bodies, errors: [] } },
    bodyName: (id: string) => user[id],
    fileName: "bracket.funda",
    document: { parameters: {}, features: [] },
    bodyElements: [],
    bodyElementMap: () => new Map(),
  } as unknown as DocumentStore;
}

describe("the Export dialog's bodies", () => {
  it("are numbered where the engine named them alike, a rename kept, and a second document starts afresh", async () => {
    opened.bodies = [];
    const geometry = {} as GeometryBackend;
    await exportModel(
      storeWith(
        [
          { id: "body6", name: "Box" },
          { id: "body2", name: "Box" },
          { id: "body4", name: "Cylinder" },
          { id: "body9", name: "Box" },
        ],
        { body4: "Lid" },
      ),
      geometry,
    );
    await exportModel(storeWith([{ id: "body3", name: "Box" }], {}), geometry);
    expect(opened.bodies).toEqual([
      [
        { id: "body6", name: "Box" },
        { id: "body2", name: "Box 2" },
        { id: "body4", name: "Lid" },
        { id: "body9", name: "Box 3" },
      ],
      [{ id: "body3", name: "Box" }],
    ]);
  });
});
