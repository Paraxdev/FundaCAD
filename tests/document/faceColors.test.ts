// Reading the per-face colours an imported file carried.
//
// The packing is written by the Python engine's `face_colors.py` and read here, so the risk is
// not that either half is wrong on its own but that they stop agreeing. The
// PACKED fixtures below are copied verbatim from that file's own test output
// (the Python engine's `test_face_colors.py`, `test_fixtures_for_the_other_side`), and
// each is checked to unpack to the list the engine packed. A change on either
// side that breaks the agreement fails here.

import { describe, expect, it } from "vitest";
import {
  decodeFaceColors,
  dominantFaceColor,
  importedBodyColors,
  importedFacePaint,
  pickBodyColor,
} from "../../src/document/faceColors";
import type { FaceColorRuns } from "../../src/types";

const RED = "#ff2b2b";
const WHITE = "#ffffff";
const GREY = "#3b3b3b";

/** [name, what the engine packed, what it packed FROM]. */
const CASES: [string, FaceColorRuns, (string | null)[]][] = [
  ["uniform", { palette: [RED], runs: [[5, 0]] }, Array(5).fill(RED)],
  [
    "two runs",
    { palette: [RED, WHITE], runs: [[2, 0], [3, 1]] },
    [RED, RED, WHITE, WHITE, WHITE],
  ],
  [
    "holes",
    { palette: [RED, WHITE], runs: [[1, 0], [2, -1], [1, 1]] },
    [RED, null, null, WHITE],
  ],
  [
    "alternating",
    { palette: [RED, WHITE], runs: [[1, 0], [1, 1], [1, 0], [1, 1]] },
    [RED, WHITE, RED, WHITE],
  ],
  ["one face", { palette: [GREY], runs: [[1, 0]] }, [GREY]],
  [
    "board-like",
    { palette: [WHITE, RED], runs: [[400, 0], [16, 1], [427, 0]] },
    [...Array(400).fill(WHITE), ...Array(16).fill(RED), ...Array(427).fill(WHITE)],
  ],
];

describe("decodeFaceColors agrees with the engine's packer", () => {
  for (const [name, packed, expected] of CASES) {
    it(name, () => {
      expect(decodeFaceColors(packed, expected.length)).toEqual(expected);
    });
  }

  it("gives every face an answer, whatever the runs say", () => {
    // CONTROL on the loop above: the length is the contract, because the caller
    // indexes it against faceStart and would otherwise write a colour onto the
    // NEXT body's faces.
    for (const enc of [
      undefined,
      { palette: [], runs: [] } as FaceColorRuns,
      { palette: [RED], runs: [[99, 0]] } as FaceColorRuns,
      { palette: [RED], runs: [[2, 0]] } as FaceColorRuns,
      { palette: [], runs: [[2, 7]] } as FaceColorRuns,
    ]) {
      expect(decodeFaceColors(enc, 4)).toHaveLength(4);
    }
  });

  it("reads a run it cannot make sense of as no colour, not as a throw", () => {
    // A saved document may be older than this code, hand-edited or truncated.
    const bad = { palette: [RED], runs: [["x", 0]] } as unknown as FaceColorRuns;
    expect(decodeFaceColors(bad, 4)).toEqual([null, null, null, null]);
    expect(decodeFaceColors({ palette: [], runs: [[2, 7]] }, 4)).toEqual([null, null, null, null]);
    expect(decodeFaceColors({ palette: [RED], runs: [[2, 0]] }, 0)).toEqual([]);
  });
});

describe("dominantFaceColor", () => {
  it("takes the colour the most faces wear", () => {
    expect(dominantFaceColor([RED, RED, WHITE])).toBe(RED);
    expect(dominantFaceColor([null, null, null, RED])).toBe(RED);
  });

  it("has nothing to say about a body the file did not colour", () => {
    expect(dominantFaceColor([])).toBeNull();
    expect(dominantFaceColor([null, null])).toBeNull();
  });

  it("breaks a tie by face order, not by map order", () => {
    expect(dominantFaceColor([WHITE, RED])).toBe(WHITE);
    expect(dominantFaceColor([RED, WHITE])).toBe(RED);
  });
});

describe("importedFacePaint", () => {
  // Three white faces and one red: the shape of a real part, mostly one colour
  // with a detail somewhere else.
  const board: FaceColorRuns = { palette: [WHITE, RED], runs: [[3, 0], [1, 1]] };

  it("only names the faces that disagree with their body's own dominant", () => {
    // The three white faces are what the body's material already says it is, so
    // they are not in the map at all and only the red one costs anything.
    const paint = importedFacePaint(
      [{ id: "body1", faceStart: 10, faceCount: 4, faceColors: board }],
      { body1: WHITE },
    );
    expect(paint).toEqual({ 13: RED });
  });

  it("is sparse even when the body wears a near-match rather than the exact shade", () => {
    // THE POINT. materialsForColors matches an imported colour to the nearest
    // material in the library, so the body's paint is often close to but not
    // equal to the file's colour. Measured on the reference assembly, comparing
    // against the material named all 1,803 faces; against the dominant, 50.
    const paint = importedFacePaint(
      [{ id: "body1", faceStart: 0, faceCount: 4, faceColors: board }],
      { body1: "#e8e8e8" }, // "Plastic, white", which is not #ffffff
    );
    expect(paint).toEqual({ 3: RED });
  });

  it("names every coloured face when the body has no colour at all", () => {
    // A body with no material is drawn in the neutral shade, so leaving its
    // dominant faces to that would throw the file's colour away entirely.
    const paint = importedFacePaint(
      [{ id: "body1", faceStart: 0, faceCount: 4, faceColors: board }],
      {},
    );
    expect(paint).toEqual({ 0: WHITE, 1: WHITE, 2: WHITE, 3: RED });
  });

  it("offsets by faceStart, so one body's colours cannot land on another's faces", () => {
    const paint = importedFacePaint(
      [
        { id: "body1", faceStart: 0, faceCount: 4, faceColors: board },
        { id: "body2", faceStart: 4, faceCount: 4, faceColors: board },
      ],
      { body1: WHITE, body2: WHITE },
    );
    expect(paint).toEqual({ 3: RED, 7: RED });
  });

  it("costs nothing for a body from anywhere but a coloured import", () => {
    // CONTROL. Every modelled body, every mesh import and every STEP with no
    // styles goes down this path, and this map is rebuilt and compared on every
    // rebuild of a document that may hold six figures of faces.
    expect(importedFacePaint([{ id: "body1", faceStart: 0, faceCount: 900 }], {})).toEqual({});
    expect(importedFacePaint(undefined, {})).toEqual({});
  });

  it("paints no faces of a body whose own colour was preferred", () => {
    const paint = importedFacePaint(
      [{ id: "body1", faceStart: 0, faceCount: 4, faceColors: board }],
      { body1: GREY },
      new Map([["body1", { color: GREY, bodyWins: true }]]),
    );
    expect(paint).toEqual({});
  });

  it("costs nothing for a body the file painted one colour", () => {
    // The ordinary imported part, and the other half of the control above: 42
    // of the reference assembly's 45 solids are a single colour throughout.
    const plain: FaceColorRuns = { palette: [GREY], runs: [[900, 0]] };
    expect(importedFacePaint(
      [{ id: "body1", faceStart: 0, faceCount: 900, faceColors: plain }],
      { body1: "#232323" },
    )).toEqual({});
  });
});

describe("pickBodyColor", () => {
  // The SV08 printer's shape: a black solid whose faces still wear a SolidWorks
  // Cut-Extrude red.
  const stale = [RED, RED, RED, null];

  it("lets the body's own colour be preferred with bodies", () => {
    expect(pickBodyColor({ partColor: GREY, faceColors: stale }, "bodies")).toEqual({ color: GREY, bodyWins: true });
    expect(pickBodyColor({ ownColor: GREY, faceColors: stale }, "bodies")).toEqual({ color: GREY, bodyWins: true });
  });

  it("lets the faces be preferred with faces", () => {
    expect(pickBodyColor({ partColor: GREY, faceColors: stale }, "faces")).toEqual({ color: RED, bodyWins: false });
  });

  it("does not let a default nobody picked beat painted faces", () => {
    // The PN532 board: products in SolidWorks' default lavender, faces painted.
    expect(pickBodyColor({ ownColor: "#cad1ee", faceColors: stale }, "bodies")).toEqual({ color: RED, bodyWins: false });
  });

  it("falls back through the part, then the tree, when no face is coloured", () => {
    expect(pickBodyColor({ partColor: "#cad1ee", inheritedColor: WHITE }, "faces").color).toBe("#cad1ee");
    expect(pickBodyColor({ inheritedColor: WHITE }, "bodies")).toEqual({ color: WHITE, bodyWins: false });
    expect(pickBodyColor({}, "bodies")).toEqual({ color: null, bodyWins: false });
  });
});

describe("importedBodyColors", () => {
  const features = [{
    id: "im", type: "import",
    nodes: [{ parent: null, color: WHITE }, { parent: 0 }],
  }];
  const bodies = [
    { id: "body1", faceCount: 4, nodeRef: "im/1", partColor: GREY, faceColors: { palette: [RED], runs: [[4, 0]] } as FaceColorRuns },
    { id: "body2", faceCount: 4 },
  ];

  it("reads the source per import and skips bodies from anything else", () => {
    const bodiesWin = importedBodyColors(bodies, features, () => "bodies");
    expect(bodiesWin.get("body1")).toEqual({ color: GREY, bodyWins: true });
    expect(bodiesWin.has("body2")).toBe(false);
    expect(importedBodyColors(bodies, features, () => "faces").get("body1")).toEqual({ color: RED, bodyWins: false });
  });
});
