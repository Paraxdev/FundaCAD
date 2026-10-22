import { describe, expect, it } from "vitest";
import { plainWarning, sentence } from "../../src/ui/stressWarnings";

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
      "The mesh is coarse for the thinnest walls, so they read stiffer than they are. Set a smaller Mesh size under More options.",
      "The mesh was made coarser to keep the analysis small enough to run.",
      "2 of the held faces are narrower than the mesh and hold nothing. Set a smaller Mesh size under More options.",
      "Spot 1 of Load 2 is smaller than the mesh, so the stress right at it is rough. Make it larger, or set a smaller Mesh size.",
      "A printed part is weaker across its layers, often by half. Keep a margin when the load pulls the layers apart.",
      "Load 3 is only on fixed faces, so it does nothing to the part.",
    ]);
  });

  it("passes a warning it does not know through as a sentence, without the request's paths", () => {
    expect(
      [
        "maxElements is capped at 200000, and above about 50000 elements a compact part usually needs more memory",
        "support 2 (supports[1]) has a note.",
        "",
      ].map(plainWarning),
    ).toEqual([
      "MaxElements is capped at 200000, and above about 50000 elements a compact part usually needs more memory.",
      "Support 2 has a note.",
      "",
    ]);
  });

  it("leaves a warning that only looks like a known one as the engine said it", () => {
    expect(plainWarning("a note: the peak stress is at a sharp inside corner")).toBe(
      "A note: the peak stress is at a sharp inside corner.",
    );
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
