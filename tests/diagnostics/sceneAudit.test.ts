// The scene audit is a detector, so the thing it must never do is report a
// healthy scene. Every test that proves it catches a fault is paired with one
// proving it stays quiet when there is none: an audit that cried wolf on every
// commit would be switched off within a day, and then the fault it exists to
// catch goes back to being a screenshot nobody can act on.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { auditIsClean, auditLine, auditScene } from "../../src/diagnostics/sceneAudit";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

/** A body reduced to what the audit reads: an id, an etag, a mesh and an edge
 *  object. Deliberately not built through buildBodyMesh, that would make this a
 *  test of the mesh builder, and the audit's contract is about object identity,
 *  not about geometry. */
function body(id: string, etag = `etag-${id}`): BodyMesh {
  const mesh = new THREE.Mesh();
  const edges = new THREE.LineSegments();
  mesh.userData.owner = { id, etag };
  return { id, etag, mesh, edges: { object: edges } } as unknown as BodyMesh;
}

function model(bodies: BodyMesh[]): ModelView {
  return { bodies, edges: [], orphanEdges: null, box: new THREE.Box3() } as ModelView;
}

/** The scene a correct commit leaves behind: mesh + edges for every body. */
function sceneOf(bodies: BodyMesh[]): THREE.Object3D[] {
  return bodies.flatMap((b) => [b.mesh, b.edges.object]);
}

describe("auditScene", () => {
  it("is clean when the scene holds exactly the model", () => {
    const bs = [body("b0"), body("b1"), body("b2")];
    const a = auditScene(sceneOf(bs), model(bs));
    expect(auditIsClean(a)).toBe(true);
    expect(a).toMatchObject({ extra: [], missing: [], duplicateIds: [], bodies: 3, children: 6 });
    expect(auditLine(a)).toBe("scene clean: 3 bodies, 6 objects");
  });

  it("catches a body's old mesh left in the scene, and names the body", () => {
    // The fault this whole file exists for: a stream held a body's previous
    // mesh, the commit built a replacement without knowing, and both are now in
    // the group a hair apart. On screen that is a shredded, doubled surface.
    const bs = [body("b0"), body("b1")];
    const leaked = body("b1", "etag-STALE").mesh;
    const a = auditScene([...sceneOf(bs), leaked], model(bs));

    expect(auditIsClean(a)).toBe(false);
    expect(a.extra).toEqual(["body b1 etag=etag-STALE"]);
    expect(a.missing).toEqual([]);
    // The line has to carry the body id: "one extra object" sends a triager
    // looking at the whole model, "body b1" sends them at one body and one
    // rebuild.
    expect(auditLine(a)).toContain("body b1 etag=etag-STALE");
    expect(auditLine(a)).toContain("1 EXTRA");
  });

  it("catches a body the model claims but the scene does not have", () => {
    // The opposite failure and a different bug: the body is pickable and
    // measurable and simply cannot be seen. It has happened here before, when a
    // stream released buffers it was about to hand to the next one.
    const bs = [body("b0"), body("b1")];
    const a = auditScene(sceneOf([bs[0]!]), model(bs));
    expect(a.missing).toEqual(["body b1 mesh", "body b1 edges"]);
    expect(a.extra).toEqual([]);
    expect(auditLine(a)).toContain("2 MISSING");
  });

  it("catches the same body id listed twice", () => {
    const b0 = body("b0");
    const dup = body("b0");
    const a = auditScene([...sceneOf([b0]), ...sceneOf([dup])], model([b0, dup]));
    // The scene matches the model object-for-object here, so extra/missing are
    // both empty and the id count is the only thing that can see this.
    expect(a.extra).toEqual([]);
    expect(a.missing).toEqual([]);
    expect(a.duplicateIds).toEqual(["b0"]);
    expect(auditIsClean(a)).toBe(false);
  });

  it("accepts the overlays the viewport is allowed to park there", () => {
    const bs = [body("b0")];
    const combs = new THREE.LineSegments();
    const orphans = new THREE.LineSegments();
    const a = auditScene([...sceneOf(bs), combs, orphans], model(bs),
      { combs, orphanEdges: orphans });
    expect(auditIsClean(a)).toBe(true);
  });

  it("control: an overlay it was NOT told about is still a fault", () => {
    // The pair to the case above. Extras are declared by the caller precisely
    // so that tolerating an unknown object is impossible: a leak is an unknown
    // object, so an audit that shrugged at those would find nothing, ever.
    const bs = [body("b0")];
    const combs = new THREE.LineSegments();
    const a = auditScene([...sceneOf(bs), combs], model(bs));
    expect(auditIsClean(a)).toBe(false);
    expect(a.extra).toEqual(["LineSegments"]);
  });

  it("says the scene is empty rather than throwing when there is no model", () => {
    const a = auditScene([], null);
    expect(auditIsClean(a)).toBe(true);
    expect(a.bodies).toBe(0);
  });

  it("caps how many extras it names, so a total leak stays readable", () => {
    // A leak usually fires for every body at once. The report has to survive it.
    const bs = Array.from({ length: 20 }, (_, i) => body(`b${i}`));
    const leaks = bs.map((b) => body(b.id, "etag-STALE").mesh);
    const a = auditScene([...sceneOf(bs), ...leaks], model(bs));
    expect(a.extra).toHaveLength(20); // the result keeps them all
    expect(auditLine(a)).toContain("20 EXTRA"); // the LINE summarises
    expect(auditLine(a)).toContain("...");
    expect(auditLine(a).length).toBeLessThan(300); // the breadcrumb cap
  });
});
