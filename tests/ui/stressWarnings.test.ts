import { describe, expect, it } from "vitest";
import { plainError, plainWarning, sentence } from "../../src/ui/stressWarnings";

// The engine's warnings as fundacad-geom's stress.rs words them, numbers formatted the way it formats them.
const MESH_TAIL =
  ", stress at a sharp inside corner or where a support ends grows as the mesh is refined, look at the colour away from it";

describe("plainWarning", () => {
  it("rewords each warning the engine gives into short sentences with capitals", () => {
    expect(
      [
        `the peak stress is at a sharp inside corner${MESH_TAIL}`,
        `the peak stress is where a pinned face ends${MESH_TAIL}`,
        `the peak stress is where a fixed spot ends${MESH_TAIL}`,
        "the largest deflection, 3.172 mm, is more than a tenth of the part's smallest size (6.000 mm), a linear analysis is not trustworthy for deflection this large",
        "the elements (2.375 mm) are larger than half the part's typical thickness (2 V / A, 3.912 mm), so its thinnest walls may have fewer than 2 elements through them and read stiffer than they are, use a smaller size or allow more elements",
        "the element size grew from 0.800 mm to 1.415 mm to stay within 40000 elements, allow more elements for a finer mesh",
        "2 of the held faces got no elements, they are narrower than the element size and hold nothing",
        "spot 1 of load 2 (loads[1]) (radius 0.300 mm) is smaller than the elements (1.250 mm), so it takes about one of them and the stress right at it is rough, use a larger radius or a smaller element size",
        "printed parts are weaker across their layers than these bulk values, often by half, so keep a margin when the load pulls the layers apart",
        "load 3 (loads[2]) is only on fixed faces, so it pushes on the fixture and does nothing to the part",
      ].map(plainWarning),
    ).toEqual([
      "The peak is at a sharp inside corner. Stress there grows as the mesh gets finer, so read the colour a little away from it.",
      "The peak is where a pinned face ends. Stress there grows as the mesh gets finer, so read the colour a little away from it.",
      "The peak is where a fixed spot ends. Stress there grows as the mesh gets finer, so read the colour a little away from it.",
      "The part bends more than a tenth of its smallest size. The numbers are rough for a bend this large.",
      "The mesh is coarse for the thinnest walls, so they read stiffer than they are. Choose Fine under Mesh detail in More options.",
      "The mesh was made coarser to keep the analysis small enough to run.",
      "2 of the held faces are too narrow for the mesh and hold nothing. Choose Fine under Mesh detail in More options.",
      "Spot 1 of Load 2 is tiny next to the mesh, so the stress right at it is rough. Choose Fine under Mesh detail in More options.",
      "A printed part is weaker across its layers, often by half. Keep a margin when the load pulls the layers apart.",
      "Load 3 is only on fixed faces, so it does nothing to the part.",
    ]);
  });

  it("passes a warning it does not know through as a sentence, without the request's paths", () => {
    expect(
      ["the part has a note about 50000 things", "support 2 (supports[1]) has a note.", ""].map(plainWarning),
    ).toEqual(["The part has a note about 50000 things.", "Support 2 has a note.", ""]);
  });

  it("leaves a warning that only looks like a known one as the engine said it", () => {
    expect(plainWarning("a note: the peak stress is at a sharp inside corner")).toBe(
      "A note: the peak stress is at a sharp inside corner.",
    );
  });
});

// The engine's refusals and warnings that talk about the mesh, as stress.rs, tetmesh.rs and solve.rs word them.
const WALL = ", the thinnest wall is about 1.3 mm thick, near (12.0, 8.5, 8.0) mm";
const REFUSALS = [
  "the body could not be meshed, parts of the body are thinner than about one element of 1.579 mm, so the mesh would come apart or lose material there, use a smaller element size",
  `the body could not be meshed, parts of the body are thinner than about one element of 1.427 mm, so the mesh would come apart or lose material there, the limit of 30000 elements forces elements this large, allow more elements${WALL}`,
  "the body could not be meshed, parts of the body are thinner than about one element of 0.900 mm, so the mesh would come apart or lose material there, this is the smallest element size the mesher allows for a part this large",
  "the body could not be meshed, the part is thinner than one element of 2.000 mm, so no element fits inside it, use a smaller element size",
  "the body could not be meshed, the part needs more than 80000 elements even after coarsening the mesh, allow more elements",
  "the fixed face got no elements, it is probably narrower than the element size, use a smaller element size or fix a larger face",
  "none of the fixed faces got any elements, they are probably narrower than the element size, use a smaller element size or fix a larger face",
  `a face of load 2 (loads[1]) got no elements, it is probably narrower than the element size, use a smaller element size${WALL}`,
  "solving this mesh of 67644 elements needs about 4.9 GB of memory, more than the 3.2 GB it may use, set maxElements to about 40000 or use a larger size",
  "solving this mesh needs about 4.9 GB of memory, more than the 3.2 GB it may use, use a larger element size or fewer elements",
  "there is not enough memory to solve this mesh, use a larger element size",
  "the body is not held and can still move, its stiffness matrix is singular, fix more faces or check the mesh for flat elements",
];
const WARNINGS = [
  "the elements (2.375 mm) are larger than half the part's typical thickness (2 V / A, 3.912 mm), so its thinnest walls may have fewer than 2 elements through them and read stiffer than they are, use a smaller size or allow more elements",
  "the element size grew from 0.800 mm to 1.415 mm to stay within 40000 elements, allow more elements for a finer mesh",
  "2 of the held faces got no elements, they are narrower than the element size and hold nothing",
  "spot 1 of load 2 (loads[1]) (radius 0.300 mm) is smaller than the elements (1.250 mm), so it takes about one of them and the stress right at it is rough, use a larger radius or a smaller element size",
  "maxElements is capped at 80000, and above about 50000 elements a compact part usually needs more memory than the solver may use",
  "the peak stress moved by 12% with the last refinement, so it may not have settled yet, a fine refinement reads it more closely",
  "the peak stress moved by 12% with the last refinement, so it may not have settled yet, allowing more elements reads it more closely",
];

describe("plainError", () => {
  it("says what was thin and where when the engine knows, and the fix only when no button offers one", () => {
    expect(plainError(REFUSALS[1]!, true)).toBe(
      "The mesh comes apart in the thin walls of this body. The thinnest wall is about 1.3 mm thick, near (12.0, 8.5, 8.0) mm.",
    );
    expect(plainError(REFUSALS[1]!)).toBe(
      "The mesh comes apart in the thin walls of this body. The thinnest wall is about 1.3 mm thick, near (12.0, 8.5, 8.0) mm. Thicker walls would let it run.",
    );
    expect(plainError(REFUSALS[0]!)).toBe(
      "The mesh comes apart in the thin walls of this body. Thicker walls would let it run.",
    );
  });

  it("names the face a run could not reach, and keeps the memory numbers", () => {
    expect(plainError(REFUSALS[7]!)).toBe(
      "A face of Load 2 is too narrow for the mesh to reach. The thinnest wall is about 1.3 mm thick, near (12.0, 8.5, 8.0) mm. Pick a wider face.",
    );
    expect(plainError(REFUSALS[5]!, true)).toBe("The fixed face is too narrow for the mesh to reach.");
    expect(plainError(REFUSALS[6]!)).toBe("The fixed faces are too narrow for the mesh to reach. Pick a wider face.");
    expect(plainError(REFUSALS[8]!, true)).toBe(
      "This study needs about 4.9 GB of memory, more than the 3.2 GB it may use.",
    );
    expect(plainError(REFUSALS[9]!)).toBe(
      "This study needs about 4.9 GB of memory, more than the 3.2 GB it may use. Close other programs, or study a simpler part.",
    );
  });

  it("passes any other refusal through as a sentence in the panel's words", () => {
    expect(plainError("support 2 (supports[1].faces[0]) matches no face of body1")).toBe(
      "Support 2 matches no face of body1.",
    );
    expect(plainError("the body could not be meshed, the surface is open, 3 of its edges are not shared")).toBe(
      "The body could not be meshed, the surface is open, 3 of its edges are not shared.",
    );
  });

  it("never names an element size or asks for a number larger or smaller", () => {
    const said = [...REFUSALS.flatMap((r) => [plainError(r), plainError(r, true)]), ...WARNINGS.map(plainWarning)];
    for (const text of said) expect(text).not.toMatch(/element|mesh size|smaller|larger|maxElements/i);
  });
});

describe("sentence", () => {
  it("starts with a capital and ends with one stop, keeping a question or an exclamation", () => {
    expect(["add a support", "Pick the body.", "is it there?", "x", ""].map(sentence)).toEqual([
      "Add a support.",
      "Pick the body.",
      "Is it there?",
      "X.",
      "",
    ]);
  });
});
