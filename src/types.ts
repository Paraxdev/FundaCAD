// Shared API + document types. Source of truth for the TS side; mirrors the
// engine's schema (crates/fundacad-core/src/schema).

export type Params = Record<string, number>;
export type Num = number | string; // literal or parameter name

export type Vec3 = [number, number, number];

/** Per-face colours from an imported file, as a palette plus run-length encoding over
 *  face order (the Python engine's `face_colors.py`, document/faceColors.ts). */
export interface FaceColorRuns {
  palette: string[];
  /** `[count, paletteIndex]`; index -1 means "no colour of its own". */
  runs: [number, number][];
}

/** Where an imported part's colour comes from when its body and its faces
 *  disagree. See document/faceColors.ts. */
export type ImportColorSource = "bodies" | "faces";

// Scalar invariants to re-find one edge or face after a rebuild; the resolver scores
// whichever fields are present (the Python engine's `geom_select.py`).
export interface EdgeFingerprint {
  mid: Vec3; // midpoint (curve parameter 0.5), world mm
  dir: Vec3; // unit tangent at 0.5, sign-normalized (edges are unoriented)
  length?: number; // curve length, mm
  curve?: "line" | "circle" | "ellipse" | "bspline" | "other";
  radius?: number; // circle/arc radius, mm, disambiguates concentric arcs
  center?: Vec3; // arc/circle center, mm
}
export interface FaceFingerprint {
  centroid: Vec3; // area centroid, world mm
  normal: Vec3; // unit outward normal at the centroid (oriented)
  area?: number; // mm^2
  surface?: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bspline" | "other";
  radius?: number; // cylinder/sphere/cone radius, mm
}

/** The body a selector resolves against. Absent means the active body, kept only for
 *  old documents: never omit it on a fresh pick. */
type SelectorBody = { body?: string };

export type Selector = (
  | { kind: "edge"; by: "axis"; axis: "X" | "Y" | "Z" }
  | { kind: "edge"; by: "nearest"; point: [number, number, number] }
  | { kind: "edge"; by: "all" }
  | { kind: "face"; by: "normal"; dir: [number, number, number] }
  | { kind: "face"; by: "nearest"; point: [number, number, number] }
  // --- v2: discriminating, drift-robust selection ---
  // `match` re-finds ONE entity by scored geometric fingerprint; `nth` breaks a
  // genuine tie (symmetric twins) by a rebuild-stable canonical order.
  | { kind: "edge"; by: "match"; fp: EdgeFingerprint; nth?: number }
  | { kind: "face"; by: "match"; fp: FaceFingerprint; nth?: number }
  // structural forms, encode intent instead of N independent point-picks:
  | { kind: "edge"; by: "tangentChain"; seed: EdgeFingerprint } // an edge + its tangent-continuous chain
  | { kind: "edge"; by: "ofFace"; face: FaceFingerprint | Extract<Selector, { kind: "face" }> } // all edges bounding a face
) &
  SelectorBody;

// A projected entity's cached 2D shape, authored by the engine (6 decimals). poly is the
// sampled fallback for tilted circles, splines and silhouettes.
export type ProjectedCurve =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "arc"; x1: number; y1: number; x2: number; y2: number; mx: number; my: number }
  | { kind: "poly"; pts: [number, number][] };

/** A poly's first and last points, one entry when closed (engine coordinates are exact). */
export function projEndSamples(cv: Extract<ProjectedCurve, { kind: "poly" }>): [number, number][] {
  const first = cv.pts[0], last = cv.pts[cv.pts.length - 1];
  if (!first) return [];
  if (!last || (last[0] === first[0] && last[1] === first[1])) return [first];
  return [first, last];
}

// What a projected entity is linked to. Siblings from one pick share `group`.
export type ProjectedSource =
  | { kind: "edge" | "faceBoundary"; body: string; sel: Selector; group?: string }
  // `index`: this sibling's edge index within the source entity's deterministic
  // edge list (multi-edge sources only), the engine's authoritative refresh
  // correspondence, stable across sibling deletions and source moves.
  | { kind: "sketchCurve"; sketch: string; entity: string; group?: string; index?: number }
  | { kind: "silhouette"; body: string; group?: string };

// A refresh entry: a curve that moved beyond tolerance, or a source gone stale (last
// shape kept). None in the steady state, which ends the refresh loop.
export type ProjectionUpdate =
  | { sketch: string; entity: string; curve: ProjectedCurve; stale: false }
  | { sketch: string; entity: string; stale: true };

/** Shared by the store commit and the open sketch, so the two cannot drift. */
export function applyProjectionUpdate<E extends { curve: ProjectedCurve; stale?: true }>(
  e: E,
  u: ProjectionUpdate,
): E {
  const next = { ...e };
  if (u.stale) {
    next.stale = true;
  } else {
    next.curve = u.curve;
    delete next.stale;
  }
  return next;
}

// Construction geometry forms no profiles. An arc is start, end and a point it passes
// through. `dimPlace` holds badge label placements (see PlaceOffset).
export type SketchEntity =
  // `angle` is DEGREES about the rectangle's own centre, absent meaning 0,
  // every rectangle saved before v6 is axis-aligned and stays so untouched.
  | { type: "rectangle"; id?: string; width: Num; height: Num; x?: Num; y?: Num; angle?: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "circle"; id?: string; radius: Num; x?: Num; y?: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "line"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "arc"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; mx: Num; my: Num; construction?: boolean }
  // fit-point spline: interpolates a smooth curve through its points (≥2)
  | { type: "spline"; id?: string; points: { x: Num; y: Num }[]; construction?: boolean }
  // control-point B-spline, degree default 3; `knots` see src/sketch/bspline.ts
  | { type: "bspline"; id?: string; poles: { x: Num; y: Num }[]; degree?: number; closed?: boolean; knots?: number[]; construction?: boolean }
  // a sketch point: reference/snap geometry only, never forms a profile
  | { type: "point"; id?: string; x: Num; y: Num; construction?: boolean }
  // Rigid shapes the solver holds fixed. Polygon `angle` is in degrees.
  | { type: "polygon"; id?: string; x: Num; y: Num; radius: Num; sides: Num; angle: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "slot"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; width: Num; construction?: boolean; dimPlace?: DimPlace }
  // Fusion-parity text: filled glyph faces from a system font; extrudes like any profile
  | { type: "text"; id?: string; text: string; x?: Num; y?: Num; height: Num;
      font?: string; style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right"; angle?: Num;
      pathRef?: string; positionOnPath?: Num; boxWidth?: Num; construction?: boolean }
  // Fixed geometry linked to its source; Break Link converts it to native.
  | { type: "projected"; id?: string; source: ProjectedSource; curve: ProjectedCurve; stale?: true; construction?: boolean };

// Sketch constraints, solved by planegcs, referencing entities by stable id.
//
// A line operand (`line`, `l1`, `l2`) may be `"<rectangleId>~<k>"`, edge k of a
// rectangle in rectCorners CCW order. Anything validating a line operand must decode
// it (entityDims.lineOperand, SketchMode.pruneConstraints).
//
// Label placement is an offset in sketch mm from the dim's natural anchor. Constraint
// dims carry it as `place`; badge dims (rectangle W/H, circle diameter, polygon radius,
// slot L/W, line length) have no constraint, so it lives on the entity's `dimPlace`.
export type PlaceOffset = { ox: number; oy: number };

/** the dimension a badge labels on its entity, the single definition;
 *  sketch/entityDims re-exports it as the name the sketcher uses. */
export type DimField = "width" | "height" | "diameter" | "length" | "radius";
/** per-entity badge label placements, keyed by which dimension they place */
export type DimPlace = Partial<Record<DimField, PlaceOffset>>;

/** Use this, not `"dimPlace" in e`: the optional key is absent on a fresh entity. */
export const dimPlaceOf = (e: { type: string }): DimPlace | undefined =>
  (e as { dimPlace?: DimPlace }).dimPlace;

/** The entity types that CARRY `dimPlace`, exactly the ones entityDims() gives
 *  a badge. The write-side guard (reading is safe on anything, see dimPlaceOf). */
export function isBadgeEntity<T extends { type: string }>(e: T): e is T & { dimPlace?: DimPlace } {
  switch (e.type) {
    case "rectangle": case "circle": case "line": case "polygon": case "slot":
      return true;
    default:
      return false;
  }
}

export type SketchConstraint =
  | { type: "horizontal"; line: string }
  | { type: "vertical"; line: string }
  | { type: "parallel"; l1: string; l2: string }
  | { type: "perpendicular"; l1: string; l2: string }
  | { type: "equal"; l1: string; l2: string }
  // `driven` dims only measure (isDriven). `id` is what a parameter binding references.
  | { type: "distance"; id?: string; line: string; value: number }
  | { type: "diameter"; id?: string; circle: string; value: number }
  // `p*`: 0/1 start/end, 0..3 rectangle corner, 2 arc centre; a circle is its centre.
  | { type: "p2pDistance"; id?: string; e1: string; p1: number; e2: string; p2: number; value: number; driven?: boolean; place?: PlaceOffset }
  // p2lDistance: driving perpendicular distance from a picked point to a line
  // operand (same `p` semantics as p2pDistance; `line` may be a rect edge)
  | { type: "p2lDistance"; id?: string; e: string; p: number; line: string; value: number; driven?: boolean; place?: PlaceOffset }
  // --- rim dims: distances to a circle or arc's rim, one planegcs constraint each ---
  // radialGap is signed with inner/outer frozen at creation, so an annulus cannot solve
  // inside-out, and comes with a `concentric` constraint.
  | { type: "radialGap"; id?: string; inner: string; outer: string; value: number; driven?: boolean; place?: PlaceOffset }
  // c2cDistance: minimum edge-to-edge clearance between two non-concentric
  // rounds (planegcs `c2cdistance`). See entityDims.rimGap for the exact
  // (two-branch) measure and sketchSolve's solve guard for the branch invariant.
  | { type: "c2cDistance"; id?: string; c1: string; c2: string; value: number; driven?: boolean; place?: PlaceOffset }
  // c2lDistance: distance from a round's rim to a line operand (`line` may be a
  // rect edge), planegcs `c2ldistance`.
  | { type: "c2lDistance"; id?: string; circle: string; line: string; value: number; driven?: boolean; place?: PlaceOffset }
  // p2cDistance: distance from a picked point (same `p` semantics as
  // p2pDistance) to a round's rim, planegcs `p2cdistance`.
  | { type: "p2cDistance"; id?: string; e: string; p: number; circle: string; value: number; driven?: boolean; place?: PlaceOffset }
  // tangent: a line and a circle/arc touch (line tangent to the circle)
  | { type: "tangent"; line: string; circle: string }
  // coincident: two entity endpoints share a position. `e1`/`e2` are entity ids;
  // `p1`/`p2` are the endpoint index (0 = start, 1 = end) on each.
  | { type: "coincident"; e1: string; p1: number; e2: string; p2: number }
  // concentric: two circles/arcs share a center
  | { type: "concentric"; c1: string; c2: string }
  // midpoint: a point (endpoint of `e`/`p`) sits at the midpoint of a line
  | { type: "midpoint"; e: string; p: number; line: string }
  // symmetric: two endpoints mirror across a line (the symmetry axis)
  | { type: "symmetric"; e1: string; p1: number; e2: string; p2: number; line: string }
  // angle: driving included angle (DEGREES) between two lines (solver works in radians)
  | { type: "angle"; id?: string; l1: string; l2: string; value: number; driven?: boolean; place?: PlaceOffset }
  // radius: driving radius (mm) of a circle OR arc entity `e`
  | { type: "radius"; id?: string; e: string; value: number; driven?: boolean; place?: PlaceOffset }
  // fix/lock: pin an entity point in place. `p` uses the dimPoint semantics
  // (0..3 = rect corner, circle center regardless of index, 2 = arc center,
  // else line/arc/spline endpoint). Fully removes that point's 2 DOF.
  | { type: "fix"; e: string; p: number }
  // collinear: two lines share one infinite axis (parallel + endpoint-on-line)
  | { type: "collinear"; l1: string; l2: string }
  // equalRadius: two circles/arcs (in any mix) share a radius
  | { type: "equalRadius"; a: string; b: string }
  // tangent2: general tangency between two curves (line/circle/arc, not line+line).
  // The older { type:"tangent"; line; circle } form is still accepted (old files).
  | { type: "tangent2"; a: string; b: string }
  // --- offset: one constraint and one distance for every source/copy pair of an operation ---
  // Pairs expand to parallel plus one p2l_distance (lines), one p2l_distance (rect edges),
  // or coincident centres plus a radius difference (rounds). `value` is signed by side;
  // p2l_distance is not, so sketchSolve's rimBranch holds the side.
  | { type: "offset"; id?: string; pairs: { src: string; cpy: string }[]; value: number; driven?: boolean; place?: PlaceOffset };

/** A driven dimension only measures; the solver skips it. */
export function isDriven(c: SketchConstraint): boolean {
  return (c as { driven?: boolean }).driven === true;
}

/** THE list of dimension types that carry `driven` + `place` (the ones the
 *  dimension tool places and constraintDims renders). One predicate so the
 *  Reference toggle, the label editor and the renderer can't drift apart. */
export function isPlacedDim(
  c: SketchConstraint,
): c is Extract<SketchConstraint, { driven?: boolean }> {
  switch (c.type) {
    case "p2pDistance": case "p2lDistance": case "radius": case "angle":
    case "radialGap": case "c2cDistance": case "c2lDistance": case "p2cDistance":
    case "offset":
      return true;
    default:
      return false;
  }
}

// A sketch pattern stored as a definition. Derived copies get ids "<pattern.id>#<n>" and
// are never constraint or dimension targets.
export type SketchPattern =
  // replicate the `sources` entities on a grid (skips the original instance).
  // `angle` (degrees, absent = 0) turns the grid's own axes, so the copies march
  // along a direction the user chose instead of along X and Y.
  | { id: string; type: "patternRect"; sources: string[]; countX: Num; countY: Num; spacingX: Num; spacingY: Num; angle?: Num }
  // replicate the `sources` entities around a center (cx,cy) over `angle` degrees
  | { id: string; type: "patternCircular"; sources: string[]; cx: Num; cy: Num; count: Num; angle: Num }
  // prebuilt hole generators, self-contained, emit circles at computed positions
  | { id: string; type: "hexHoles"; cx: Num; cy: Num; diameter: Num; spacing: Num; rings: Num }
  // honeycomb: hexagon OUTLINES tiled in a hex grid (each cell is a 6-line hexagon)
  | { id: string; type: "honeycomb"; cx: Num; cy: Num; diameter: Num; spacing: Num; rings: Num }
  | { id: string; type: "boltCircle"; cx: Num; cy: Num; bcd: Num; count: Num; diameter: Num }
  | { id: string; type: "gridHoles"; cx: Num; cy: Num; diameter: Num; countX: Num; countY: Num; spacingX: Num; spacingY: Num };

export type Plane3 = "XY" | "XZ" | "YZ";
export type Axis3 = "X" | "Y" | "Z";

// An axis of revolution: one of the three world axes, or an arbitrary line in
// world mm. The line form is what a picked EDGE resolves to, see revolve's
// `axisEdge` for why the resolved value is written down beside the reference.
export type AxisLine = { origin: [number, number, number]; dir: [number, number, number] };
export type AxisSpec = Axis3 | AxisLine;

// an arbitrary plane (e.g. derived from a face or an offset): origin + x axis +
// normal, all in world mm. The in-plane Y axis is normal × xdir.
export type PlaneDef = {
  origin: [number, number, number];
  normal: [number, number, number];
  xdir: [number, number, number];
};
export type PlaneSpec = Plane3 | PlaneDef;

/** The handle the UI offers; the engine applies offset and angle whatever the mode. */
export type JointMode = "rigid" | "revolute" | "slider";

/** One side of a joint: a frame on body geometry (re-resolved), on a datum, or given outright. */
export interface MateConnector {
  body?: string;
  face?: Selector;
  edge?: Selector;
  datum?: string;
  origin?: Vec3;
  zdir?: Vec3;
  xdir?: Vec3;
}

export type PressPullMode = "auto" | "join" | "cut" | "new" | "intersect";
export type PressPullDirection = "normal" | "axis";

export type HoleType = "simple" | "counterbore" | "countersink" | "insert";
export type HoleStandard = "clearance" | "tap" | "custom";
export type HoleFit = "close" | "normal" | "loose";

export type CoreFeature =
  // `planeId` (a datum) or `face` (a body face, touched at `at`) make the sketch follow;
  // `plane` stays as the resolved cache. An id in `plane` itself would render as XY.
  | { id: string; type: "sketch"; plane: PlaneSpec; planeId?: string; face?: Selector; at?: Vec3; entities: SketchEntity[]; constraints?: SketchConstraint[]; patterns?: SketchPattern[]; name?: string }
  | {
      id: string;
      type: "extrude";
      sketch: string;
      distance: Num;
      operation: "new" | "join" | "cut" | "intersect";
      // interior points of the chosen profile areas (engine resolves each to a
      // face, with holes, and unions them). `region` is the legacy single-area form.
      regions?: [number, number, number][];
      region?: [number, number, number];
      // Bodies hidden at creation, excluded from its boolean; eye toggles later are display only.
      hiddenBodies?: string[];
      // The bodies the boolean may touch; absent means every visible overlapping body.
      targets?: string[];
      // `distance` each way off the plane; the sign no longer matters.
      symmetric?: boolean;
      // Degrees; positive narrows the far face.
      taper?: Num;
    }
  // `profile`: -1 chamfer, 0 circular, +1 sharp corner.
  // `sizeType` "chord" reads `radius` as the width across the round. `tangentEdges`
  // false stops at the picked edges instead of running on along tangent ones.
  | { id: string; type: "fillet"; edges: Selector | Selector[]; radius: Num; profile?: Num; sizeType?: "radius" | "chord"; continuity?: "G1" | "G2"; tangentEdges?: boolean; draft?: boolean }
  | { id: string; type: "chamfer"; edges: Selector | Selector[]; distance: Num; chamferType?: "equal" | "twoDistance"; distance2?: Num; tangentEdges?: boolean; draft?: boolean }
  // Signed `distance` along each face's normal, or `upTo` a face. Curved faces offset
  // the surface. `taper` applies to planar pushes by distance only.
  // `mode` other than auto extrudes the face straight out and combines it like an
  // extrude; auto leaves `operation` to the sign of `distance`. `direction: "axis"`
  // moves the face along the axis its walls run along (a hole's end), absent is "normal".
  | { id: string; type: "press-pull"; face: Selector | Selector[]; distance: Num; operation: "join" | "cut"; body?: string; upTo?: Selector; taper?: Num; mode?: PressPullMode; direction?: PressPullDirection }
  | { id: string; type: "deleteFace"; face: Selector | Selector[]; body?: string }
  | { id: string; type: "mirror"; plane: Plane3; bodies?: string[] }
  // `operation` defaults to "new". `regions` are the areas to spin, as for extrude.
  // `axisEdge` makes the axis follow a model edge, with `axis` as the cache. `pitch`
  // (mm per turn) climbs the axis for a thread; without it the angle clamps to 360.
  | { id: string; type: "revolve"; sketch: string; axis: AxisSpec; axisEdge?: Selector; angle: Num; pitch?: Num; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[]; regions?: [number, number, number][] }
  // `profiles` are selected regions in order; `sketches` is the legacy whole-sketch form.
  | { id: string; type: "loft"; profiles?: { sketch: string; region: [number, number, number] }[]; sketches?: string[]; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[] }
  // Sweep a closed profile sketch along an open path sketch (a line/arc/spline).
  | { id: string; type: "sweep"; profile: string; path: string; operation: "new" | "join" | "cut"; targets?: string[] }
  // A datum plane: its reference moved by shiftX/shiftY/offset along the reference's own
  // axes, then turned about that point by tiltX, tiltY, spin (degrees, in that order,
  // see document/datumPose.ts). `planeId` (a parent datum) or `face` make the reference
  // follow, with `plane` as the cache; `at` is where a round face was touched.
  | {
      id: string;
      type: "datumPlane";
      plane: PlaneSpec;
      planeId?: string;
      offset?: number;
      shiftX?: number;
      shiftY?: number;
      tiltX?: number;
      tiltY?: number;
      spin?: number;
      name?: string;
      face?: Selector;
      at?: Vec3;
    }
  // A baked point, not re-resolved on rebuild; drawn client-side.
  | { id: string; type: "datumPoint"; point: Vec3; name?: string }
  // An infinite line (`dir` need not be unit). `axisEdge` makes it follow an edge.
  | { id: string; type: "datumAxis"; origin: Vec3; dir: Vec3; name?: string; axisEdge?: Selector }
  // An imported body, embedded so the file rebuilds without the original. `solid` is
  // false for a non-watertight mesh.
  | {
      id: string;
      type: "import";
      format: "stl" | "3mf" | "step" | "obj" | "brep" | "glb";
      name: string;
      // Content hash in the container's blob store; inline base64 was 541.8 MiB on one assembly.
      geom?: string;
      // The pre-v5 inline payload. Still READ so every document saved before the
      // container format keeps opening; never written any more. Exactly one of
      // `geom` / `brep` is present in practice.
      brep?: string;
      source?: string;
      solid?: boolean;
      // The file's dominant colour (glTF), kept to redo the palette slot match.
      color?: string;
      // explode:false keeps a multi-solid payload as ONE body (large imported
      // assemblies: divides body count by solids-per-import). Absent/true =
      // historical one-body-per-solid behavior.
      explode?: boolean;
      // A STEP assembly tree. `nodes` in pre-order (an instanced subassembly appears
      // twice). `parts` row i binds to child i of `brep`; `faces` checks that binding,
      // and a mismatch drops the tree rather than mislabel parts.
      nodes?: { name: string; parent: number | null; color?: string }[];
      // `color` is the colour styled on the part's solid, beside the product's.
      parts?: { node: number; faces: number; faceColors?: FaceColorRuns; color?: string }[];
      // A body read in from another FundaCAD document that is kept in step with
      // it: the file, and a fingerprint of what it held when it was last read.
      link?: { path: string; stamp: string };
      // Geometry a plugin generated and stored here (GeometryBackend.generateShape), and what it
      // was generated from. Read by that plugin to say what the body is; the build ignores it.
      generatedBy?: { plugin: string; spec: Record<string, unknown> };
    }
  // keep=both splits into bodies. `bodies` cuts several; `planeId` names a datum plane.
  | { id: string; type: "split"; plane?: PlaneSpec; planeId?: string; keep: "top" | "bottom" | "both"; body?: string; bodies?: string[]; groupSides?: boolean }
  // Divide the face `sketch` sits on by imprinting its curves; no material changes.
  | { id: string; type: "imprint"; sketch: string; body?: string }
  // The target keeps its id and is modified in place; tools are consumed unless keepOriginals.
  | { id: string; type: "boolean"; operation: "union" | "subtract" | "intersect"; target?: string; tools?: string[]; keepOriginals?: boolean }
  // Primitive bodies (centered at the origin). Each creates a new body; edit the
  // dimensions in the inspector. Handy as boolean tool bodies.
  | { id: string; type: "box"; length: Num; width: Num; height: Num; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[] }
  | { id: string; type: "cylinder"; radius: Num; height: Num; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[] }
  | { id: string; type: "cone"; bottomRadius: Num; topRadius: Num; height: Num; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[] }
  | { id: string; type: "sphere"; radius: Num; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[] }
  | { id: string; type: "torus"; majorRadius: Num; minorRadius: Num; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[] }
  // Hollow the active body to a wall thickness, removing the selected faces
  // (none = a fully closed hollow).
  | { id: string; type: "shell"; thickness: Num; faces?: Selector | Selector[] }
  // A true surface offset, flat and cylindrical faces only: BRepOffset is unsafe elsewhere.
  | { id: string; type: "offsetFace"; faces: Selector | Selector[]; distance: Num; body?: string }
  // Thicken: give surface geometry a wall. `faces` absent = the whole body,
  // which is how a non-watertight mesh import (a surface body, `solid: false`)
  // becomes real material. `symmetric` grows it both ways about the surface.
  | { id: string; type: "thicken"; faces?: Selector | Selector[]; thickness: Num; symmetric?: boolean; operation?: "join" | "new"; targets?: string[]; body?: string }
  // Taper the selected faces by an angle about a neutral plane (pull axis).
  | { id: string; type: "draft"; faces: Selector | Selector[]; angle: Num; axis: Axis3 }
  // Holes into the flat `face` along its inward normal, at `points` (projected onto
  // the face) and at `sketch`'s points. A dimension left out comes from `size`
  // (features/holeStandards.ts); the tool writes them all so the rows show them.
  | {
      id: string; type: "hole"; face?: Selector; points: Vec3[]; sketch?: string; body?: string;
      holeType?: HoleType; standard?: HoleStandard; size?: string; fit?: HoleFit;
      diameter?: Num; extent?: "blind" | "through"; depth?: Num;
      cbDiameter?: Num; cbDepth?: Num; csDiameter?: Num; csAngle?: Num; leadIn?: Num;
      drillPoint?: boolean; flip?: boolean; tapped?: boolean;
    }
  // Patterns union their copies. `bodies` absent means the active body.
  // `features` repeats those features' cuts and joins instead of a body
  // (mutually exclusive with `bodies`): each copy of the feature's tool is
  // applied to the body it cut or joined, and a copy that misses it is skipped.
  | { id: string; type: "patternRect"; countX: Num; countY: Num; spacingX: Num; spacingY: Num; bodies?: string[]; features?: string[] }
  | { id: string; type: "patternLinear"; count: Num; spacing: Num; axis: Axis3; bodies?: string[]; features?: string[] }
  // `axis` is X, Y or Z through the origin, a line, or `{datum}` naming a
  // datumAxis; `axisRef` makes it follow an edge or face, with the line in
  // `axis` as the cache.
  | { id: string; type: "patternCircular"; count: Num; angle: Num; axis: AxisSpec | { datum: string }; axisRef?: Selector; bodies?: string[]; features?: string[] }
  // Merge near-coplanar facets of an imported mesh (angular tolerance, degrees):
  // recovers planar faces / reduces facet count. Coarsens curved regions.
  | { id: string; type: "simplifyMesh"; tolerance: Num }
  // sx/sy/sz override `factor` per axis; `about` is the point held still.
  | { id: string; type: "scale"; factor: Num; sx?: Num; sy?: Num; sz?: Num; about?: Vec3; bodies?: string[] }
  // Move the active body, or the bodies listed in `bodies` (multi-select), :
  // translate (dx,dy,dz mm) + rotate (rx,ry,rz degrees, about origin).
  | { id: string; type: "move"; dx: Num; dy: Num; dz: Num; rx: Num; ry: Num; rz: Num; bodies?: string[] }
  // Copies placed with a move's transform; each copy is a new body.
  | { id: string; type: "duplicate"; dx: Num; dy: Num; dz: Num; rx: Num; ry: Num; rz: Num; bodies?: string[] }
  // Place `moving` by aligning mate connectors (axes opposed unless `flush`), then slide
  // by `offset` and spin by `angle` about the mate axis (the Python engine's `joints.py`).
  | { id: string; type: "joint"; moving: string; mate: MateConnector; to: MateConnector;
      mode?: JointMode; flush?: boolean; offset?: Num; angle?: Num; name?: string }
  // Repair boolean debris; parametric because later booleans make more of it.
  | { id: string; type: "cleanUp"; body?: string; tolerance?: Num }
  // Remove bodies by id (mainstream MCAD "Remove"). Runs at its point in the timeline and
  // drops the listed bodies from the model, the way to delete a body from the
  // browser. Appended at the end, after every feature that made the bodies.
  | { id: string; type: "removeBody"; bodies: string[] }
  ;

/** A feature a plugin owns. The app carries and saves it losslessly without the plugin,
 *  and reports it unbuildable (document/missingPlugins.ts). */
export interface PluginFeature {
  id: string;
  type: string;
  [field: string]: unknown;
}

/** `f.type === "sketch"` cannot narrow away PluginFeature's string type; use isFeature. */
export type Feature = CoreFeature | PluginFeature;

/** The `type` of a feature the APPLICATION defines. A plugin's is just a string. */
export type FeatureType = CoreFeature["type"];

/** Every feature type the application builds itself, at runtime. `satisfies`
 *  makes a type added to CoreFeature and missed here a compile error. */
const CORE_FEATURE_TYPES = {
  boolean: true, box: true, chamfer: true, cleanUp: true, cone: true, cylinder: true,
  datumAxis: true, datumPlane: true, datumPoint: true, deleteFace: true, draft: true,
  duplicate: true, extrude: true, fillet: true, hole: true, import: true, imprint: true, joint: true,
  loft: true, mirror: true, move: true, offsetFace: true, patternCircular: true,
  patternLinear: true, patternRect: true, "press-pull": true, removeBody: true, revolve: true, scale: true,
  shell: true, simplifyMesh: true, sketch: true, sphere: true, split: true, sweep: true,
  thicken: true, torus: true,
} as const satisfies Record<FeatureType, true>;

export function isCoreFeatureType(type: string): type is FeatureType {
  return Object.prototype.hasOwnProperty.call(CORE_FEATURE_TYPES, type);
}

/** Narrow to one of the app's own feature types (a plugin may not claim one). */
export function isFeature<T extends FeatureType>(
  f: Feature,
  type: T,
): f is Extract<CoreFeature, { type: T }> {
  return f.type === type;
}

/** The same narrowing as a value: the feature if it has this type, else null.
 *  For the `find`/`?.` shapes where a guard reads worse than a cast would. */
export function asFeature<T extends FeatureType>(
  f: Feature | null | undefined,
  type: T,
): Extract<CoreFeature, { type: T }> | null {
  return f && f.type === type ? (f as Extract<CoreFeature, { type: T }>) : null;
}

/** Every feature of one of the app's own types, narrowed. */
export function featuresOf<T extends FeatureType>(
  features: readonly Feature[],
  type: T,
): Extract<CoreFeature, { type: T }>[] {
  return features.filter((f): f is Extract<CoreFeature, { type: T }> => f.type === type);
}

// A redefined ViewCube side: the model face the user mapped to a cube side. The
// stored face is oriented toward the camera when that side is clicked. `normal`
// faces out of the model surface; `up` is the in-view up direction (screen +Y).
export type ViewCubeSide =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom";
export type ViewOverride = { normal: [number, number, number]; up: [number, number, number] };

// --- parameters/equations engine (frontend-only; the engine sees numbers) ---

/** Canonical unit kind of a parameter: lengths are mm, angles degrees, counts raw. */
export type ParamUnit = "mm" | "deg" | "count";

/** Where a model parameter's value is written, by stable id. Entity targets are for rigid
 *  shapes only; solved geometry is driven through a dimension. */
export type ParamTarget =
  | { kind: "feature"; feature: string; field: string }
  | { kind: "constraint"; sketch: string; constraint: string }
  | { kind: "entity"; sketch: string; entity: string; field: string }
  | { kind: "pattern"; sketch: string; pattern: string; field: string };

/** One row of the parameter table. `expr` is the source of truth; `value` is the
 *  cached evaluation result in canonical units and is ALWAYS present, so a build
 *  (and any pre-expression reader) can run without evaluating anything. */
export interface ParamDef {
  expr: string;
  value: number;
  unit: ParamUnit;
  comment?: string;
  /** present = model parameter (dN, drives one field); absent = user parameter. */
  target?: ParamTarget;
  /** RESERVED (unimplemented): driven-dim params are geometry→value sources. */
  driven?: boolean;
  /** How the parameter is edited and what range it is kept in. The app carries
   *  and saves these; FundaCAD.ExtraParameters draws them. The build and the
   *  evaluator never read them, so a document builds the same without the plugin. */
  control?: ParamControl;
  /** id of a `paramExtras.groups` row; absent = ungrouped. */
  group?: string;
  /** a helper the person tuning the model should not have to scroll past. */
  hidden?: boolean;
}

export type ParamControl =
  | { kind: "number"; min?: number; max?: number; step?: number }
  | { kind: "slider"; min: number; max: number; step?: number }
  | { kind: "toggle" }
  | { kind: "choice"; choices: { label: string; value: number }[] };

/** One named set of parameter values, applied together ("Classic", "Solid core"). */
export interface ParamConfiguration {
  id: string;
  name: string;
  /** parameter name → expression, written into that parameter when applied. */
  values: Record<string, string>;
}

/** A rule the parameters must satisfy. `expr` is expected to be non-zero; when
 *  it is 0 (or does not evaluate) the plugin shows `message`. */
export interface ParamCheck {
  id: string;
  expr: string;
  message: string;
  level: "warning" | "error";
}

/** Document-level parameter organisation. Every name in here is a parameter
 *  name, and the params engine renames and deletes through it, so it stays
 *  right whether or not the plugin that edits it is installed. */
export interface ParamExtras {
  groups?: { id: string; name: string }[];
  configurations?: ParamConfiguration[];
  /** id of the configuration last applied, for the picker to show. */
  activeConfiguration?: string;
  checks?: ParamCheck[];
}

export interface CadDocument {
  parameters: Params;
  /** Parameter table (source of truth for expressions). `parameters` is the
   *  derived name→value cache regenerated from this on save/send, so the engine
   *  and pre-v2 readers keep working off plain numbers. Absent = legacy doc. */
  paramDefs?: Record<string, ParamDef>;
  /** Groups, configurations and checks over the parameter table. Absent until used. */
  paramExtras?: ParamExtras;
  features: Feature[];
  // optional per-side ViewCube redefinitions; persisted with the document.
  viewOverrides?: Partial<Record<ViewCubeSide, ViewOverride>>;
  // --- non-geometry project state, persisted so reopening fully restores the
  // session (the geometry rebuild ignores these; only parameters+features build).
  /** file-format version, for future migrations (current = 1). */
  version?: number;
  /** feature ids currently suppressed (skipped on rebuild). */
  suppressed?: string[];
  /** Saved versions and branches of this document, see document/versions.ts.
   *  Absent until the first version is saved. */
  versions?: import("./document/versions").VersionRepo;
  /** timeline rollback marker: count of active features; absent/null = all built. */
  rollback?: number | null;
  /** explicit per-sketch show/hide overrides (id → visible). */
  sketchVisibility?: Record<string, boolean>;
  /** explicit per-body show/hide overrides (body id → visible). */
  bodyVisibility?: Record<string, boolean>;
  /** explicit per-construction-plane show/hide overrides (datum feature id → visible). */
  planeVisibility?: Record<string, boolean>;
  /** Where each body id came from ("<featureId>:<n>" → "bodyN"), so ids survive
   *  features around them changing. Absent on files from before it existed,
   *  which the build numbers by position once and then remembers. */
  bodyIds?: Record<string, string>;
  /** explicit per-body display-name overrides (body id → name). */
  bodyNames?: Record<string, string>;
  /** The user's folders over the bodies, display only (document/elements.ts). */
  elements?: { id: string; name: string; parent?: string }[];
  /** body id → element id. A body with no entry is an ORPHAN: it shows where it
   *  always did, at the top level or under its import's own assembly node. */
  bodyElement?: Record<string, string>;
  /** The material library, display only. Absent is the untouched starter set. Not the
   *  filament `palette`, which is what a part is made from. */
  materials?: {
    id: string; name: string; color: string;
    metalness?: number; roughness?: number; opacity?: number; emissive?: number;
  }[];
  /** body id → material id. */
  bodyMaterial?: Record<string, string>;
  /** `bodyId#localFaceIndex` → material id: a material on ONE FACE, for the
   *  chrome ring on a printed knob. Display-only like everything above it, and
   *  see document/faceMaterials.ts for what that key promises across an edit. */
  faceMaterials?: Record<string, string>;
  /** import feature id → "faces" where an import's parts wear their face
   *  colours over their body colours. Absent means "bodies". */
  importColorSource?: Record<string, ImportColorSource>;
  /** filament palette; slot index → name+hex, plus an optional material type
   *  (e.g. "PLA"). */
  palette?: { name: string; color: string; material?: string }[];
  /** per-body palette-slot assignment (body id → slot index into `palette`). */
  bodyColors?: Record<string, number>;
}

// A non-fatal note from a rebuild: a low-confidence match, a skipped boolean, a sealed void.
export interface ResolveDiag {
  feature_id?: string;
  // edgeOpFailed: `failed` names the edges to paint red. sealedVoid: a cut closed a
  // cavity inside the body (legal, so not an error; the other fields are neutral).
  kind: "edge" | "face" | "boolean" | "edgeOpFailed" | "sealedVoid";
  resolved: number; // how many entities matched (0 for a skipped boolean)
  confidence: number; // 0..1, margin to the runner-up candidate (1 = lone clear pick)
  lossy: boolean; // a marginal / drift-path match was taken (or a feature was skipped)
  reason?: string;
  failed?: { mid: [number, number, number] }[]; // edgeOpFailed only: failed edges' midpoints
  // For "ambiguous nearest pick": the selector's own point, naming which one to re-pick.
  at?: [number, number, number];
  candidates?: string[];
}

// Mesh wire arrays arrive either as plain JSON number arrays (text replies,
// the Rust in-process backend) or as typed-array views over a binary WS frame,
// every consumer only indexes / reads .length, valid on both members.
export type F32Wire = number[] | Float32Array;
export type U32Wire = number[] | Uint32Array;

export interface RebuildResult {
  mesh: { positions: F32Wire; indices: U32Wire; faceIds: U32Wire; normals?: F32Wire };
  // `smooth`: the two faces meet tangentially here (a fillet's boundary), drawn per the tangent edges setting.
  edges: { id: string; points: [number, number, number][]; body?: string; smooth?: boolean }[];
  bbox: { min: Vec3; max: Vec3 };
  // Each body's faceId range. No `etag` means always rebuild the body's mesh.
  bodies?: { id: string; name: string; faceStart: number; faceCount: number; faceOwners?: (string | null)[]; faceBands?: number[][]; faceColorSlots?: (number | null)[]; etag?: string; nodeRef?: string; faceColors?: FaceColorRuns; partColor?: string }[];
  // selector-resolution diagnostics, when any selector resolved with low confidence.
  diagnostics?: ResolveDiag[];
  // Failed features alongside what did build. featureError is the most downstream one.
  // `code` is a machine category the UI can act on.
  featureError?: { feature_id?: string; message: string; code?: string };
  featureErrors?: { feature_id?: string; message: string; code?: string; detail?: FeatureErrorDetail }[];
  // projected-curve refresh entries from this rebuild (absent at steady state);
  // the store lands them via a derived, no-undo commit, see
  // DocumentStore.commitProjectionRefresh.
  projectionUpdates?: ProjectionUpdate[];
  // Where every datum plane resolved, offset applied. Not written back into the document.
  datumPlanes?: Record<string, PlaneDef>;
  // Only face-following sketches that moved; readers fall back to the cached `plane`.
  sketchPlanes?: Record<string, PlaneDef>;
  // Only datums that follow geometry.
  datumMarks?: Record<string, DatumMark>;
  /** The document's body id map after this build, sent only when it changed. */
  bodyIds?: Record<string, string>;
}

/** The resolved placement of a datum that follows geometry, as it stands this
 *  rebuild. An axis is a line (origin + direction); a point is one position. */
export type DatumMark =
  | { kind: "axis"; origin: Vec3; dir: Vec3 }
  | { kind: "point"; position: Vec3 };

export type RebuildReply =
  | { ok: true; result: RebuildResult }
  | { ok: false; error: { feature_id?: string; message: string }; cancelled?: boolean };

export type ExportFormat = "step" | "stl" | "3mf" | "glb";

/** Faceting and output options for a mesh export (STL, 3MF, GLB). */
export interface MeshExportOptions {
  unit: "mm" | "cm" | "m" | "in" | "ft";
  binary: boolean;
  surfaceDeviation: number;
  normalDeviation: number;
  maxEdgeLength: number;
}

// Import: the format the user picks, and the engine's reply for an `import` op,
// the content hash of the stored geometry plus a little metadata for the new
// `import` feature.
export type ImportFormat = "stl" | "3mf" | "step" | "obj" | "brep" | "glb";
export type ImportReply =
  | { ok: true; geom: string; name: string; solid: boolean; faces: number; color?: string;
      // present only for a STEP that carried a real assembly tree; see the
      // `import` feature above for what they mean
      nodes?: { name: string; parent: number | null; color?: string }[];
      parts?: { node: number; faces: number; faceColors?: FaceColorRuns; color?: string }[] }
  // `cancelled` = the user stopped it. Distinct from a failure so the UI can
  // dismiss quietly instead of showing an error the user already knows about.
  | { ok: false; cancelled?: boolean; message: string };

/** The engine's account of a failed feature, for the error report
 *  (fundacad-geom builder `failure_detail`). */
export interface FeatureErrorDetail {
  index: number;
  type: string | null;
  ms: number;
  /** The OpenCASCADE calls the feature made, oldest first. */
  kernel: { op: string; ms?: number; args?: string; error?: string }[];
  bodies: { id: string; name: string; shape: string }[];
  bodyCount: number;
  params: Record<string, number>;
  occt: string;
}
