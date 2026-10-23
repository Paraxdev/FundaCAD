import { describe, expect, it } from "vitest";
import { bodyLabels, labelledBodies } from "../../src/ui/bodyLabels";
import type { DocumentStore } from "../../src/document/store";

const labels = (bodies: { id: string; name?: string }[], user: Record<string, string> = {}) =>
  Object.fromEntries(bodyLabels(bodies, (id) => user[id]));

describe("bodyLabels", () => {
  it("is empty for no bodies", () => {
    expect(labels([])).toEqual({});
  });

  it("leaves a single body's name as it is", () => {
    expect(labels([{ id: "body4", name: "Box" }])).toEqual({ body4: "Box" });
  });

  it("numbers repeats from the second in the order given", () => {
    expect(
      labels([
        { id: "body3", name: "Box" },
        { id: "body1", name: "Cylinder" },
        { id: "body8", name: "Box" },
        { id: "body2", name: "Box" },
        { id: "body5", name: "Cylinder" },
      ]),
    ).toEqual({ body3: "Box", body1: "Cylinder", body8: "Box 2", body2: "Box 3", body5: "Cylinder 2" });
  });

  it("prefers the user's name and numbers a repeat of it too", () => {
    expect(
      labels(
        [
          { id: "body1", name: "Box" },
          { id: "body2", name: "Box" },
          { id: "body3", name: "Sphere" },
        ],
        { body2: "Lid", body3: "Lid" },
      ),
    ).toEqual({ body1: "Box", body2: "Lid", body3: "Lid 2" });
  });

  it("skips a number another body is already called", () => {
    expect(
      labels(
        [
          { id: "body1", name: "Box" },
          { id: "body2", name: "Box" },
          { id: "body3", name: "Box" },
        ],
        { body3: "Box 2" },
      ),
    ).toEqual({ body1: "Box", body2: "Box 3", body3: "Box 2" });
  });

  it("falls back to the id when a body has no name", () => {
    expect(labels([{ id: "body6", name: "" }, { id: "body7" }])).toEqual({ body6: "body6", body7: "body7" });
  });
});

describe("labelledBodies", () => {
  it("lists the built bodies in build order under their labels, and nothing before a build", () => {
    const user = new Map([["body5", "Clip"]]);
    const store = {
      buildState: {
        result: {
          bodies: [
            { id: "body2", name: "Box" },
            { id: "body5", name: "Box" },
            { id: "body9", name: "Box" },
          ],
        },
      },
      bodyName: (id: string) => user.get(id),
    } as unknown as DocumentStore;
    expect(labelledBodies(store)).toEqual([
      { id: "body2", name: "Box" },
      { id: "body5", name: "Clip" },
      { id: "body9", name: "Box 2" },
    ]);
    expect(
      labelledBodies({ buildState: { result: null }, bodyName: () => undefined } as unknown as DocumentStore),
    ).toEqual([]);
  });
});
