// A material on one face: what the key promises, and what happens when the
// model under it changes.
//
// The whole point of the module is that an assignment can outlive the thing it
// names, so most of these are about the DROPPING: a body that is gone, a face
// index past the end, a material deleted from the library. Each has to fall back
// to "the body decides", silently, because the alternative is a renderer that
// throws on a document somebody edited yesterday.
import { describe, it, expect } from "vitest";
import {
  faceKey, parseFaceKey, resolveFaceMaterials, faceMaterialPaint, faceMaterialFinishes,
  staleFaceKeys, type BodyFaceSpan,
} from "../../src/document/faceMaterials";
import { FINISH, type MaterialDef } from "../../src/document/materials";

const BODIES: BodyFaceSpan[] = [
  { id: "body1", faceStart: 0, faceCount: 6 },
  { id: "body2", faceStart: 6, faceCount: 4 },
];

const LIBRARY: MaterialDef[] = [
  { id: "m-chrome", name: "Chrome", color: "#c8ccd0", metalness: 0.95, roughness: 0.08 },
  { id: "m-red", name: "Red", color: "#c02020" },
  { id: "m-glass", name: "Glass", color: "#cfe4ee", opacity: 0.25 },
];

describe("faceKey", () => {
  it("round-trips", () => {
    expect(parseFaceKey(faceKey("body3", 17))).toEqual({ body: "body3", face: 17 });
  });

  it("splits at the LAST separator, so a body id containing one still parses", () => {
    // Nothing generates such an id today, but a hand-edited document is a file
    // somebody else wrote and this is the reader.
    expect(parseFaceKey("odd#name#4")).toEqual({ body: "odd#name", face: 4 });
  });

  it("refuses what is not one of ours rather than inventing a face", () => {
    expect(parseFaceKey("body1")).toBeNull();
    expect(parseFaceKey("#3")).toBeNull();
    expect(parseFaceKey("body1#")).toBeNull();
    expect(parseFaceKey("body1#two")).toBeNull();
    expect(parseFaceKey("body1#-1")).toBeNull();
    expect(parseFaceKey("body1#1.5")).toBeNull();
  });
});

describe("resolveFaceMaterials", () => {
  it("turns a body-local face into the GLOBAL id the renderer paints by", () => {
    const got = resolveFaceMaterials([["body2#1", "m-red"]], BODIES, LIBRARY);
    // body2 starts at 6, so its face 1 is global face 7.
    expect([...got.keys()]).toEqual([7]);
    expect(got.get(7)!.id).toBe("m-red");
  });

  it("drops an assignment whose body is gone", () => {
    const got = resolveFaceMaterials([["ghost#0", "m-red"]], BODIES, LIBRARY);
    expect(got.size).toBe(0);
  });

  it("drops a face index past the end of a body that got simpler", () => {
    const got = resolveFaceMaterials([["body2#9", "m-red"]], BODIES, LIBRARY);
    expect(got.size).toBe(0);
  });

  it("drops an assignment naming a deleted material", () => {
    const got = resolveFaceMaterials([["body1#0", "m-gone"]], BODIES, LIBRARY);
    expect(got.size).toBe(0);
  });

  it("keeps the good ones when a neighbour is bad (control)", () => {
    const got = resolveFaceMaterials(
      [["ghost#0", "m-red"], ["body1#2", "m-chrome"], ["body1#99", "m-red"]],
      BODIES,
      LIBRARY,
    );
    expect([...got.keys()]).toEqual([2]);
  });

  it("answers nothing at all with no model, rather than throwing", () => {
    expect(resolveFaceMaterials([["body1#0", "m-red"]], undefined, LIBRARY).size).toBe(0);
    expect(resolveFaceMaterials([["body1#0", "m-red"]], [], LIBRARY).size).toBe(0);
  });
});

describe("the two maps the renderer wants", () => {
  const resolved = resolveFaceMaterials(
    [["body1#0", "m-chrome"], ["body2#3", "m-glass"]],
    BODIES,
    LIBRARY,
  );

  it("paints by global face id", () => {
    expect(faceMaterialPaint(resolved)).toEqual({ 0: "#c8ccd0", 9: "#cfe4ee" });
  });

  it("fills every finish field, so the render path has no branches in it", () => {
    const f = faceMaterialFinishes(resolved);
    expect(f[0]).toEqual({ metalness: 0.95, roughness: 0.08, opacity: 1, emissive: 0 });
    // Glass says nothing about metalness, so it wears the app's default.
    expect(f[9]!.metalness).toBe(FINISH.metalness);
    expect(f[9]!.opacity).toBe(0.25);
  });
});

describe("staleFaceKeys", () => {
  it("names assignments to bodies that no longer exist", () => {
    expect(staleFaceKeys(
      [["body1#0", "m-red"], ["gone#2", "m-red"], ["also-gone#0", "m-red"]],
      BODIES,
    )).toEqual(["gone#2", "also-gone#0"]);
  });

  it("names nothing when every body is still there (control)", () => {
    expect(staleFaceKeys([["body1#0", "m-red"], ["body2#3", "m-red"]], BODIES)).toEqual([]);
  });

  it("names nothing rather than everything when there is no model to compare to", () => {
    // A build that has not happened yet is not evidence that a body is gone,
    // and treating it as such would wipe a freshly opened document's assignments
    // before its first rebuild landed.
    expect(staleFaceKeys([["body1#0", "m-red"]], undefined)).toEqual([]);
  });
});
