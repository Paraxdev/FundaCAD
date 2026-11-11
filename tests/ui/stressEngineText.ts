// The engine's warnings and refusals as its Rust source words them, with a filled example and the line it must reach.
import type { MessageKey } from "../../src/i18n";
import type { MessageArgs } from "../../src/i18n/format";

export interface EngineText {
  name: string;
  file: string;
  literal: string;
  example: string;
  key: MessageKey;
  args: MessageArgs;
}

const STRESS = "crates/fundacad-geom/src/stress.rs";
const SOLVE = "crates/fundacad-geom/src/fem/solve.rs";
const TETMESH = "crates/fundacad-geom/src/fem/tetmesh.rs";

const MESH_TAIL =
  "stress at a sharp inside corner or where a support ends grows as the mesh is refined, look at the colour away from it";
const PEAK = `the peak stress is {spot}, ${MESH_TAIL}`;
const THIN_WALLS =
  "the elements ({:.3} mm) are larger than half the part's typical thickness (2 V / A, {:.3} mm), so its thinnest walls may have fewer than 2 elements through them and read stiffer than they are, use a smaller size or allow more elements";
const SMALL_SPOT =
  "{} (radius {:.3} mm) is smaller than the elements ({:.3} mm), so it takes about one of them and the stress right at it is rough, use a larger radius or a smaller element size";
const THIN_EXAMPLE =
  "the elements (2.375 mm) are larger than half the part's typical thickness (2 V / A, 3.912 mm), so its thinnest walls may have fewer than 2 elements through them and read stiffer than they are, use a smaller size or allow more elements";
const UNSETTLED =
  "the peak stress moved by {:.0}% with the last refinement, so it may not have settled yet, {further} reads it more closely";
const NARROW = "{n} of the {which} faces got no elements, they are narrower than the element size and hold nothing";
const DEFLECTION =
  "the largest deflection, {:.3} mm, is more than a tenth of the part's smallest size ({:.3} mm), a linear analysis is not trustworthy for deflection this large";

export const WARNING_TEXTS: EngineText[] = [
  {
    name: "corner",
    file: STRESS,
    literal: PEAK,
    example: `the peak stress is at a sharp inside corner, ${MESH_TAIL}`,
    key: "stress.warn.corner",
    args: {},
  },
  {
    name: "corner word",
    file: STRESS,
    literal: '"at a sharp inside corner"',
    example: `the peak stress is at a sharp inside corner, ${MESH_TAIL}`,
    key: "stress.warn.corner",
    args: {},
  },
  ...(
    [
      ["fixed spot", "fixedSpot", '"where a fixed spot ends"'],
      ["fixed face", "fixed", "where a {word} face ends"],
      ["pinned face", "pinned", "where a {word} face ends"],
      ["slider face", "slider", "where a {word} face ends"],
    ] as const
  ).map(([words, edge, literal]) => ({
    name: `support end ${words}`,
    file: STRESS,
    literal,
    example: `the peak stress is where a ${words} ends, ${MESH_TAIL}`,
    key: "stress.warn.supportEnd" as const,
    args: { edge },
  })),
  {
    name: "big bend",
    file: STRESS,
    literal: DEFLECTION,
    example:
      "the largest deflection, 3.172 mm, is more than a tenth of the part's smallest size (6.250 mm), a linear analysis is not trustworthy for deflection this large",
    key: "stress.warn.bigBend",
    args: {},
  },
  {
    name: "thin walls",
    file: STRESS,
    literal: THIN_WALLS,
    example: THIN_EXAMPLE,
    key: "stress.warn.thinWalls",
    args: { pick: "fine" },
  },
  {
    name: "element size grew",
    file: STRESS,
    literal:
      "the element size grew from {requested:.3} mm to {:.3} mm to stay within {max_elements} elements, allow more elements for a finer mesh",
    example:
      "the element size grew from 0.800 mm to 1.415 mm to stay within 40000 elements, allow more elements for a finer mesh",
    key: "stress.warn.coarser",
    args: {},
  },
  {
    name: "max elements",
    file: STRESS,
    literal:
      "maxElements is capped at {MAX_ELEMENTS}, and above about 50000 elements a compact part usually needs more memory than the solver may use",
    example:
      "maxElements is capped at 80000, and above about 50000 elements a compact part usually needs more memory than the solver may use",
    key: "stress.warn.coarser",
    args: {},
  },
  ...(["held", "fixed"] as const).map((which) => ({
    name: `narrow faces ${which}`,
    file: STRESS,
    literal: NARROW,
    example: `4 of the ${which} faces got no elements, they are narrower than the element size and hold nothing`,
    key: "stress.warn.narrowFaces" as const,
    args: { n: 4, which, pick: "fine" },
  })),
  {
    name: "small spot of a support",
    file: STRESS,
    literal: SMALL_SPOT,
    example:
      "spot 3 of support 2 (supports[1]) (radius 0.375 mm) is smaller than the elements (1.250 mm), so it takes about one of them and the stress right at it is rough, use a larger radius or a smaller element size",
    key: "stress.warn.smallSpot",
    args: { owner: "support", k: 3, i: 2, pick: "fine" },
  },
  {
    name: "small spot of a load",
    file: STRESS,
    literal: '"spot {} of {}"',
    example:
      "spot 2 of load 4 (loads[3]) (radius 0.375 mm) is smaller than the elements (1.250 mm), so it takes about one of them and the stress right at it is rough, use a larger radius or a smaller element size",
    key: "stress.warn.smallSpot",
    args: { owner: "load", k: 2, i: 4, pick: "fine" },
  },
  {
    name: "unsettled, a fine run reads it closer",
    file: STRESS,
    literal: UNSETTLED,
    example:
      "the peak stress moved by 12% with the last refinement, so it may not have settled yet, a fine refinement reads it more closely",
    key: "stress.warn.unsettled",
    args: { pct: 12, pick: "fine" },
  },
  {
    name: "unsettled, a Fine run",
    file: STRESS,
    literal: '"allowing more elements"',
    example:
      "the peak stress moved by 7% with the last refinement, so it may not have settled yet, allowing more elements reads it more closely",
    key: "stress.warn.unsettled",
    args: { pct: 7, pick: "" },
  },
  {
    name: "printed",
    file: STRESS,
    literal:
      "printed parts are weaker across their layers than these bulk values, often by half, so keep a margin when the load pulls the layers apart",
    example:
      "printed parts are weaker across their layers than these bulk values, often by half, so keep a margin when the load pulls the layers apart",
    key: "stress.warn.printed",
    args: {},
  },
  {
    name: "dead load",
    file: STRESS,
    literal: '"{} is only on fixed faces, so it pushes on the fixture and does nothing to the part"',
    example: "load 3 (loads[2]) is only on fixed faces, so it pushes on the fixture and does nothing to the part",
    key: "stress.warn.deadLoad",
    args: { i: 3 },
  },
];

export const WALL_LITERAL =
  ", the thinnest wall is about {thickness:.digits$} mm thick, near ({x:.1}, {y:.1}, {z:.1}) mm";
export const WALL_EXAMPLE = ", the thinnest wall is about 0.45 mm thick, near (12.0, -3.5, 7.0) mm";
export const MESHED = '"the body could not be meshed, {other}"';

const NOT_FIXED = " probably narrower than the element size, use a smaller element size or fix a larger face";

export const REFUSAL_TEXTS: EngineText[] = [
  {
    name: "thin walls",
    file: TETMESH,
    literal:
      "parts of the body are thinner than about one element of {size:.3} mm, so the mesh would come apart or lose material there, {}",
    example:
      "the body could not be meshed, parts of the body are thinner than about one element of 1.427 mm, so the mesh would come apart or lose material there, allow more elements",
    key: "stress.refuse.thinWalls",
    args: { wall: "no", fix: "yes" },
  },
  {
    name: "too thin",
    file: TETMESH,
    literal: "the part is thinner than one element of {size:.3} mm, so no element fits inside it, {}",
    example:
      "the body could not be meshed, the part is thinner than one element of 2.250 mm, so no element fits inside it, use a smaller element size",
    key: "stress.refuse.tooThin",
    args: { wall: "no", fix: "yes" },
  },
  {
    name: "too big",
    file: TETMESH,
    literal: "the part needs more than {max_tets} elements even after coarsening the mesh, allow more elements",
    example:
      "the body could not be meshed, the part needs more than 83000 elements even after coarsening the mesh, allow more elements",
    key: "stress.refuse.tooBig",
    args: { wall: "no", fix: "yes" },
  },
  {
    name: "fixed face",
    file: SOLVE,
    literal: '"the fixed face got no elements, it is"',
    example: `the fixed face got no elements, it is${NOT_FIXED}`,
    key: "stress.refuse.fixedFace",
    args: { wall: "no", fix: "yes" },
  },
  {
    name: "fixed faces",
    file: SOLVE,
    literal: '"none of the fixed faces got any elements, they are"',
    example: `none of the fixed faces got any elements, they are${NOT_FIXED}`,
    key: "stress.refuse.fixedFaces",
    args: { wall: "no", fix: "yes" },
  },
  {
    name: "load face",
    file: SOLVE,
    literal:
      "a face of load {} (loads[{load}]) got no elements, it is probably narrower than the element size, use a smaller element size",
    example:
      "a face of load 3 (loads[2]) got no elements, it is probably narrower than the element size, use a smaller element size",
    key: "stress.refuse.loadFace",
    args: { i: 3, wall: "no", fix: "yes" },
  },
  {
    name: "memory with elements",
    file: STRESS,
    literal:
      "solving this mesh of {elements} elements needs about {:.1} GB of memory, more than the {:.1} GB it may use, set maxElements to about {fits} or use a larger size",
    example:
      "solving this mesh of 67644 elements needs about 5.4 GB of memory, more than the 3.2 GB it may use, set maxElements to about 40000 or use a larger size",
    key: "stress.refuse.memory",
    args: { need: "5.4", may: "3.2", wall: "no", fix: "yes" },
  },
  {
    name: "memory",
    file: SOLVE,
    literal:
      "solving this mesh needs about {:.1} GB of memory, more than the {:.1} GB it may use, use a larger element size or fewer elements",
    example:
      "solving this mesh needs about 5.4 GB of memory, more than the 3.2 GB it may use, use a larger element size or fewer elements",
    key: "stress.refuse.memory",
    args: { need: "5.4", may: "3.2", wall: "no", fix: "yes" },
  },
  {
    name: "no memory",
    file: SOLVE,
    literal: '"there is not enough memory to solve this mesh, use a larger element size"',
    example: "there is not enough memory to solve this mesh, use a larger element size",
    key: "stress.refuse.noMemory",
    args: { wall: "no", fix: "no" },
  },
  {
    name: "not held",
    file: SOLVE,
    literal:
      "the body is not held and can still move, its stiffness matrix is singular, fix more faces or check the mesh for flat elements",
    example:
      "the body is not held and can still move, its stiffness matrix is singular, fix more faces or check the mesh for flat elements",
    key: "stress.refuse.notHeld",
    args: { wall: "no", fix: "no" },
  },
];
