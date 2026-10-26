// Document and API types, mirroring the engine schema in crates/fundacad-core/src/schema.

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
  // A flat face found again by its outward normal after upstream moves. `extent` is its [umin, umax, vmin, vmax] in the
  // engine face frame, a hole keeps its offset from the nearest min, middle or max; older `center` moves with the centre.
  | {
      kind: "face";
      by: "tracked";
      point: [number, number, number];
      normal: [number, number, number];
      center?: [number, number, number];
      extent?: [number, number, number, number];
    }
  // `match` re-finds one entity by scored fingerprint; `nth` breaks a tie between symmetric twins in rebuild stable order.
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
  const first = cv.pts[0],
    last = cv.pts[cv.pts.length - 1];
  if (!first) return [];
  if (!last || (last[0] === first[0] && last[1] === first[1])) return [first];
  return [first, last];
}

// What a projected entity is linked to. Siblings from one pick share `group`.
export type ProjectedSource =
  | { kind: "edge" | "faceBoundary"; body: string; sel: Selector; group?: string }
  // `index`: this sibling's place in the source's deterministic edge list (multi edge sources), how the engine pairs
  // refreshes, stable across sibling deletions and source moves.
  | { kind: "sketchCurve"; sketch: string; entity: string; group?: string; index?: number }
  | { kind: "silhouette"; body: string; group?: string };

// A refresh entry: a curve that moved beyond tolerance, or a source gone stale (last
// shape kept). None in the steady state, which ends the refresh loop.
export type ProjectionUpdate =
  | { sketch: string; entity: string; curve: ProjectedCurve; stale: false }
  | { sketch: string; entity: string; stale: true };

/** Shared by the store commit and the open sketch, so the two cannot drift. */
export function applyProjectionUpdate<E extends { curve: ProjectedCurve; stale?: true }>(e: E, u: ProjectionUpdate): E {
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
  // `angle` is degrees about the rectangle's centre, absent means 0 (every file before v6).
  | {
      type: "rectangle";
      id?: string;
      width: Num;
      height: Num;
      x?: Num;
      y?: Num;
      angle?: Num;
      construction?: boolean;
      dimPlace?: DimPlace;
    }
  | { type: "circle"; id?: string; radius: Num; x?: Num; y?: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "line"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "arc"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; mx: Num; my: Num; construction?: boolean }
  // fit point spline through its points (at least 2)
  | { type: "spline"; id?: string; points: { x: Num; y: Num }[]; construction?: boolean }
  // control-point B-spline, degree default 3; `knots` see src/sketch/bspline.ts
  | {
      type: "bspline";
      id?: string;
      poles: { x: Num; y: Num }[];
      degree?: number;
      closed?: boolean;
      knots?: number[];
      construction?: boolean;
    }
  // a sketch point: reference/snap geometry only, never forms a profile
  | { type: "point"; id?: string; x: Num; y: Num; construction?: boolean }
  // Rigid shapes the solver holds fixed. Polygon `angle` is in degrees.
  | {
      type: "polygon";
      id?: string;
      x: Num;
      y: Num;
      radius: Num;
      sides: Num;
      angle: Num;
      construction?: boolean;
      dimPlace?: DimPlace;
    }
  | {
      type: "slot";
      id?: string;
      x1: Num;
      y1: Num;
      x2: Num;
      y2: Num;
      width: Num;
      construction?: boolean;
      dimPlace?: DimPlace;
    }
  // filled glyph faces from a system font, extrudes like any profile
  | {
      type: "text";
      id?: string;
      text: string;
      x?: Num;
      y?: Num;
      height: Num;
      font?: string;
      style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right";
      angle?: Num;
      pathRef?: string;
      positionOnPath?: Num;
      boxWidth?: Num;
      construction?: boolean;
    }
  // Fixed geometry linked to its source; Break Link converts it to native.
  | {
      type: "projected";
      id?: string;
      source: ProjectedSource;
      curve: ProjectedCurve;
      stale?: true;
      construction?: boolean;
    };

// A line operand (`line`, `l1`, `l2`) may be `"<rectangleId>~<k>"`, edge k in rectCorners CCW order; validators must
// decode it (entityDims.lineOperand). A label offset is sketch mm from the dim's anchor, on `place` or the entity's `dimPlace`.
export type PlaceOffset = { ox: number; oy: number };

export type DimField = "width" | "height" | "diameter" | "length" | "radius";
export type DimPlace = Partial<Record<DimField, PlaceOffset>>;

/** Use this, not `"dimPlace" in e`: the optional key is absent on a fresh entity. */
export const dimPlaceOf = (e: { type: string }): DimPlace | undefined => (e as { dimPlace?: DimPlace }).dimPlace;

/** The write side guard: exactly the entity types entityDims() gives a badge. */
export function isBadgeEntity<T extends { type: string }>(e: T): e is T & { dimPlace?: DimPlace } {
  switch (e.type) {
    case "rectangle":
    case "circle":
    case "line":
    case "polygon":
    case "slot":
      return true;
    default:
      return false;
  }
}

export type AngleRay = 1 | -1;

export type SketchConstraint =
  | { type: "horizontal"; line: string }
  | { type: "vertical"; line: string }
  | { type: "parallel"; l1: string; l2: string }
  | { type: "perpendicular"; l1: string; l2: string }
  | { type: "equal"; l1: string; l2: string }
  // `driven` dims only measure (isDriven). `id` is what a parameter binding references.
  | { type: "distance"; id?: string; line: string; value: number }
  | { type: "diameter"; id?: string; circle: string; value: number; place?: PlaceOffset }
  // `p*`: 0/1 start/end, 0..3 rectangle corner, 2 arc centre; a circle is its centre.
  | {
      type: "p2pDistance";
      id?: string;
      e1: string;
      p1: number;
      e2: string;
      p2: number;
      value: number;
      driven?: boolean;
      place?: PlaceOffset;
    }
  // e2's x (or y) minus e1's equals `value`, signed; the tool orders operands so it is positive, freezing the side.
  | {
      type: "hDistance" | "vDistance";
      id?: string;
      e1: string;
      p1: number;
      e2: string;
      p2: number;
      value: number;
      driven?: boolean;
      place?: PlaceOffset;
    }
  // perpendicular distance from a point (`p` as in p2pDistance) to a line operand
  | {
      type: "p2lDistance";
      id?: string;
      e: string;
      p: number;
      line: string;
      value: number;
      driven?: boolean;
      place?: PlaceOffset;
    }
  // Signed with inner and outer frozen at creation so an annulus cannot solve inside out; paired with `concentric`.
  | {
      type: "radialGap";
      id?: string;
      inner: string;
      outer: string;
      value: number;
      driven?: boolean;
      place?: PlaceOffset;
    }
  // rim to rim clearance of two non concentric rounds; entityDims.rimGap has the two branch measure
  | { type: "c2cDistance"; id?: string; c1: string; c2: string; value: number; driven?: boolean; place?: PlaceOffset }
  | {
      type: "c2lDistance";
      id?: string;
      circle: string;
      line: string;
      value: number;
      driven?: boolean;
      place?: PlaceOffset;
    }
  // distance from a point (`p` as in p2pDistance) to a round's rim
  | {
      type: "p2cDistance";
      id?: string;
      e: string;
      p: number;
      circle: string;
      value: number;
      driven?: boolean;
      place?: PlaceOffset;
    }
  | { type: "tangent"; line: string; circle: string }
  // `p1`/`p2` are endpoint indices (0 start, 1 end); `snap` marks one from a drawing snap, which a modify may pull apart.
  | { type: "coincident"; e1: string; p1: number; e2: string; p2: number; snap?: boolean }
  | { type: "concentric"; c1: string; c2: string }
  | { type: "midpoint"; e: string; p: number; line: string }
  | { type: "pointOnCurve"; e: string; p: number; curve: string }
  | { type: "symmetric"; e1: string; p1: number; e2: string; p2: number; line: string }
  // two points share a y (or an x), `p` as in p2pDistance
  | { type: "horizontalPoints" | "verticalPoints"; e1: string; p1: number; e2: string; p2: number }
  // Degrees. Without `rays`, the signed angle from l1 to l2; with them, l1 and l2 times rays[0] and rays[1] bound the
  // shown wedge and `value` is counterclockwise from the first ray to the second, 0..360.
  | {
      type: "angle";
      id?: string;
      l1: string;
      l2: string;
      value: number;
      rays?: [AngleRay, AngleRay];
      driven?: boolean;
      place?: PlaceOffset;
    }
  | { type: "radius"; id?: string; e: string; value: number; driven?: boolean; place?: PlaceOffset }
  // `p`: 0..3 rect corner, any index on a circle is its centre, 2 arc centre, else an endpoint.
  | { type: "fix"; e: string; p: number }
  | { type: "collinear"; l1: string; l2: string }
  | { type: "equalRadius"; a: string; b: string }
  // any two curves but line and line; old files still carry `tangent`
  | { type: "tangent2"; a: string; b: string }
  // Each pair expands to parallel plus p2l_distance (lines), p2l_distance (rect edges) or concentric plus a radius
  // difference (rounds). `value` is signed by side; p2l_distance is not, so sketchSolve's rimBranch holds the side.
  | { type: "offset"; id?: string; pairs: OffsetPair[]; value: number; driven?: boolean; place?: PlaceOffset };

/** `flip`: this round copy's radius moves by -value. A chain's value carries the picked
 *  curve's sign, which says nothing about whether each arc in the chain grows or shrinks. */
export type OffsetPair = { src: string; cpy: string; flip?: boolean };

/** A driven dimension only measures; the solver skips it. */
export function isDriven(c: SketchConstraint): boolean {
  return (c as { driven?: boolean }).driven === true;
}

/** The one list of dims carrying `driven` and `place`, shared so the Reference toggle, label editor and renderer agree. */
export function isPlacedDim(c: SketchConstraint): c is Extract<SketchConstraint, { driven?: boolean }> {
  switch (c.type) {
    case "p2pDistance":
    case "hDistance":
    case "vDistance":
    case "p2lDistance":
    case "radius":
    case "angle":
    case "radialGap":
    case "c2cDistance":
    case "c2lDistance":
    case "p2cDistance":
    case "offset":
      return true;
    default:
      return false;
  }
}

// A sketch pattern stored as a definition. Derived copies get ids "<pattern.id>#<n>" and
// are never constraint or dimension targets.
export type SketchPattern =
  // grid copies of `sources`, skipping the original; `angle` (degrees, absent 0) turns the grid axes
  | {
      id: string;
      type: "patternRect";
      sources: string[];
      countX: Num;
      countY: Num;
      spacingX: Num;
      spacingY: Num;
      angle?: Num;
    }
  | { id: string; type: "patternCircular"; sources: string[]; cx: Num; cy: Num; count: Num; angle: Num }
  // self contained hole generators, emit circles at computed positions
  | { id: string; type: "hexHoles"; cx: Num; cy: Num; diameter: Num; spacing: Num; rings: Num }
  // hexagon outlines (six lines each) tiled in a hex grid
  | { id: string; type: "honeycomb"; cx: Num; cy: Num; diameter: Num; spacing: Num; rings: Num }
  | { id: string; type: "boltCircle"; cx: Num; cy: Num; bcd: Num; count: Num; diameter: Num }
  | {
      id: string;
      type: "gridHoles";
      cx: Num;
      cy: Num;
      diameter: Num;
      countX: Num;
      countY: Num;
      spacingX: Num;
      spacingY: Num;
    };

export type Plane3 = "XY" | "XZ" | "YZ";
export type Axis3 = "X" | "Y" | "Z";

// A world axis or a line in world mm; a picked edge resolves to the line form (see revolve's `axisEdge`).
export type AxisLine = { origin: [number, number, number]; dir: [number, number, number] };
export type AxisSpec = Axis3 | AxisLine;

// World mm. The in plane Y axis is normal × xdir.
export type PlaneDef = {
  origin: [number, number, number];
  normal: [number, number, number];
  xdir: [number, number, number];
};
export type PlaneSpec = Plane3 | PlaneDef;

/** The handle the UI offers; the engine applies offset and angle whatever the mode. */
export type JointMode = "rigid" | "revolute" | "slider";

/** A frame on body geometry, a datum, or given outright. `axis` reads a face or edge as a line: a round face's axis,
 *  a flat face's normal through its centre, a circle's axis or a straight edge. */
export interface MateConnector {
  body?: string;
  face?: Selector;
  edge?: Selector;
  axis?: Selector;
  datum?: string;
  origin?: Vec3;
  zdir?: Vec3;
  xdir?: Vec3;
}

/** `a` moves against `b`, the reference for offset and angle. Any field but the id may be missing in an agent's
 *  document; the engine names the gap. */
export interface MechanismJoint {
  id: string;
  mode?: JointMode;
  a?: MateConnector;
  b?: MateConnector;
}

export type ExtrudeStart = "sketch" | "offset" | "face" | "plane" | "point";
export type ExtrudeEnd = "distance" | "upToFace" | "upToPlane" | "upToPoint" | "throughAll";
export type ThinSide = "center" | "inside" | "outside" | "twoSides";
/** A datum point's id, or the vertex of `body` nearest `point`. */
export type PointRef = string | { point: [number, number, number]; body?: string };
export type PressPullMode = "auto" | "join" | "cut" | "new" | "intersect";
export type PressPullDirection = "normal" | "axis";

export type HoleType = "simple" | "counterbore" | "countersink" | "insert";
export type HoleStandard = "clearance" | "tap" | "custom";
export type HoleFit = "close" | "normal" | "loose";

export type CoreFeature =
  // `planeId` (a datum) or `face` (a body face, touched at `at`) make the sketch follow;
  // `plane` stays as the resolved cache. An id in `plane` itself would render as XY.
  | {
      id: string;
      type: "sketch";
      plane: PlaneSpec;
      planeId?: string;
      face?: Selector;
      at?: Vec3;
      entities: SketchEntity[];
      constraints?: SketchConstraint[];
      patterns?: SketchPattern[];
      name?: string;
      fillRule?: "evenodd";
    }
  | {
      id: string;
      type: "extrude";
      sketch: string;
      distance: Num;
      operation: "new" | "join" | "cut" | "intersect";
      // Interior points of the chosen profile areas, unioned by the engine; `region` is the old single area form.
      regions?: [number, number, number][];
      region?: [number, number, number];
      // Bodies hidden at creation, excluded from its boolean unless `targets` names them.
      hiddenBodies?: string[];
      // The bodies the boolean may touch; absent means every visible overlapping body.
      targets?: string[];
      // `distance` each way off the plane, whatever its sign.
      symmetric?: boolean;
      // Degrees; positive narrows the far face.
      taper?: Num;
      // Where the profile starts; absent is the sketch plane. `startOffset` adds along its normal.
      startType?: ExtrudeStart;
      startOffset?: Num;
      startFace?: Selector;
      startPlane?: string;
      startPoint?: PointRef;
      // Where side one stops; absent is `distance`. `endOffset` runs past an up to target, negative stops short.
      endType?: ExtrudeEnd;
      upToFace?: Selector;
      upToPlane?: string;
      upToPoint?: PointRef;
      endOffset?: Num;
      // A second side the other way, exclusive with `symmetric`.
      twoSided?: boolean;
      distance2?: Num;
      taper2?: Num;
      endType2?: ExtrudeEnd;
      upToFace2?: Selector;
      upToPlane2?: string;
      upToPoint2?: PointRef;
      endOffset2?: Num;
      // A wall along `curves` (all when absent) instead of closed areas. `inside` is the enclosed side, the side an open
      // chain bends toward, or the left of a straight one; `twoSides` puts `thickness` inside and `thickness2` outside.
      thin?: boolean;
      curves?: string[];
      thickness?: Num;
      side?: ThinSide;
      thickness2?: Num;
    }
  // `profile`: -1 chamfer, 0 circular, +1 sharp corner.
  // `sizeType` "chord" reads `radius` as the width across the round. `tangentEdges`
  // false stops at the picked edges instead of running on along tangent ones.
  | {
      id: string;
      type: "fillet";
      edges: Selector | Selector[];
      radius: Num;
      profile?: Num;
      sizeType?: "radius" | "chord";
      continuity?: "G1" | "G2";
      tangentEdges?: boolean;
      draft?: boolean;
    }
  | {
      id: string;
      type: "chamfer";
      edges: Selector | Selector[];
      distance: Num;
      chamferType?: "equal" | "twoDistance";
      distance2?: Num;
      tangentEdges?: boolean;
      draft?: boolean;
    }
  // Signed `distance` along each face normal, or `upTo` a face; `taper` applies to planar pushes by distance only.
  // `mode` other than auto extrudes and combines like an extrude. `direction: "axis"` follows the walls (a hole's end).
  // `followTangent` (default true) moves the smooth run into a resized round face with it; false refuses instead.
  | {
      id: string;
      type: "press-pull";
      face: Selector | Selector[];
      distance: Num;
      operation: "join" | "cut";
      body?: string;
      upTo?: Selector;
      upToPlane?: string;
      upToPoint?: PointRef;
      upToOffset?: Num;
      taper?: Num;
      mode?: PressPullMode;
      direction?: PressPullDirection;
      targets?: string[];
      followTangent?: boolean;
    }
  | { id: string; type: "deleteFace"; face: Selector | Selector[]; body?: string }
  // `plane` is XY, XZ, YZ or a datum plane id, written { name } once `bodies` is set (document/mirrorPlane.ts).
  | { id: string; type: "mirror"; plane: string | { name: string }; bodies?: string[] }
  // `operation` defaults to "new". `regions` are the areas to spin, as for extrude.
  // `axisEdge` makes the axis follow a model edge, with `axis` as the cache. `pitch`
  // (mm per turn) climbs the axis for a thread; without it the angle clamps to 360.
  | {
      id: string;
      type: "revolve";
      sketch: string;
      axis: AxisSpec;
      axisEdge?: Selector;
      angle: Num;
      pitch?: Num;
      operation?: "new" | "join" | "cut" | "intersect";
      targets?: string[];
      regions?: [number, number, number][];
    }
  // `profiles` are selected regions in order; `sketches` is the legacy whole-sketch form.
  | {
      id: string;
      type: "loft";
      profiles?: { sketch: string; region: [number, number, number] }[];
      sketches?: string[];
      operation?: "new" | "join" | "cut" | "intersect";
      targets?: string[];
    }
  // Sweep a closed profile sketch along an open path sketch (a line/arc/spline).
  | { id: string; type: "sweep"; profile: string; path: string; operation: "new" | "join" | "cut"; targets?: string[] }
  // The reference shifted along its own axes, then turned by tiltX, tiltY, spin in degrees, in that order
  // (document/datumPose.ts). `planeId` or `face` make it follow, `plane` the cache; `at` is where a round face was touched.
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
      // Model references the engine rebuilds the plane from, `plane` the cache.
      through?: PlaneThrough;
      t?: Num;
      angle?: Num;
    }
  // `at` makes the point follow the model, `point` being the cache.
  | { id: string; type: "datumPoint"; point: Vec3; name?: string; at?: PointAt }
  // An infinite line (`dir` need not be unit). `axisEdge` or `through` makes it follow the model.
  | {
      id: string;
      type: "datumAxis";
      origin: Vec3;
      dir: Vec3;
      name?: string;
      axisEdge?: Selector;
      through?: AxisThrough;
    }
  // An imported body, embedded so the file rebuilds without the original. `solid` is
  // false for a non-watertight mesh.
  | {
      id: string;
      type: "import";
      format:
        | "stl"
        | "3mf"
        | "step"
        | "obj"
        | "brep"
        | "glb"
        | "gltf"
        | "iges"
        | "fcstd"
        | "ply"
        | "off"
        | "amf"
        | "vrml"
        | "x3d"
        | "xbf"
        | "3dm"
        | "ifc"
        | "dxf"
        | "fbx"
        | "3ds"
        | "svg";
      name: string;
      // Content hash in the container's blob store; inline base64 was 541.8 MiB on one assembly.
      geom?: string;
      // The pre v5 inline payload, read so old documents open, never written; one of `geom` or `brep` is present.
      brep?: string;
      source?: string;
      solid?: boolean;
      // The file's dominant colour (glTF), kept to redo the palette slot match.
      color?: string;
      // false keeps a multi solid payload as one body, for large assemblies; absent or true is one body per solid.
      explode?: boolean;
      // A STEP assembly tree, `nodes` in pre order (an instanced subassembly appears twice). `parts` row i binds to
      // child i of `brep`; `faces` checks it, and a mismatch drops the tree rather than mislabel parts.
      nodes?: { name: string; parent: number | null; color?: string }[];
      // `color` is the colour styled on the part's solid, beside the product's.
      parts?: { node: number; faces: number; faceColors?: FaceColorRuns; color?: string }[];
      // Import warnings, such as a body that did not close; every build repeats them on this feature.
      notes?: string[];
      // The unit a glTF, VRML or X3D file declared, informational: stored geometry is already millimetres.
      unit?: string;
      // Kept in step with another FundaCAD document; `stamp` fingerprints what it held when last read.
      link?: { path: string; stamp: string };
      // Set by GeometryBackend.generateShape and read back by that plugin; the build ignores it.
      generatedBy?: { plugin: string; spec: Record<string, unknown> };
      // A read only reference scan: one mesh, never in a boolean, snapped to and measured but not edited.
      scan?: boolean;
    }
  | { id: string; type: "separate"; body?: string; bodies?: string[] }
  // keep=both splits into bodies. `bodies` cuts several; `planeId` names a datum plane.
  | {
      id: string;
      type: "split";
      plane?: PlaneSpec;
      planeId?: string;
      keep: "top" | "bottom" | "both";
      body?: string;
      bodies?: string[];
      groupSides?: boolean;
    }
  // Divide the face `sketch` sits on by imprinting its curves; no material changes.
  | { id: string; type: "imprint"; sketch: string; body?: string }
  // The target keeps its id and is modified in place; tools are consumed unless keepOriginals.
  | {
      id: string;
      type: "boolean";
      operation: "union" | "subtract" | "intersect";
      target?: string;
      tools?: string[];
      keepOriginals?: boolean;
    }
  // Primitives are centred on the origin.
  | {
      id: string;
      type: "box";
      length: Num;
      width: Num;
      height: Num;
      operation?: "new" | "join" | "cut" | "intersect";
      targets?: string[];
    }
  | {
      id: string;
      type: "cylinder";
      radius: Num;
      height: Num;
      operation?: "new" | "join" | "cut" | "intersect";
      targets?: string[];
    }
  | {
      id: string;
      type: "cone";
      bottomRadius: Num;
      topRadius: Num;
      height: Num;
      operation?: "new" | "join" | "cut" | "intersect";
      targets?: string[];
    }
  | { id: string; type: "sphere"; radius: Num; operation?: "new" | "join" | "cut" | "intersect"; targets?: string[] }
  | {
      id: string;
      type: "torus";
      majorRadius: Num;
      minorRadius: Num;
      operation?: "new" | "join" | "cut" | "intersect";
      targets?: string[];
    }
  // Hollows the active body, removing `faces` (none gives a closed hollow).
  | { id: string; type: "shell"; thickness: Num; faces?: Selector | Selector[] }
  // A true surface offset, flat and cylindrical faces only: BRepOffset is unsafe elsewhere.
  | {
      id: string;
      type: "offsetFace";
      faces: Selector | Selector[];
      distance: Num;
      body?: string;
      followTangent?: boolean;
    }
  // `faces` absent is the whole body, which turns a non watertight mesh import into material.
  | {
      id: string;
      type: "thicken";
      faces?: Selector | Selector[];
      thickness: Num;
      symmetric?: boolean;
      operation?: "join" | "new";
      targets?: string[];
      body?: string;
    }
  // Taper the selected faces by an angle about a neutral plane (pull axis).
  | { id: string; type: "draft"; faces: Selector | Selector[]; angle: Num; axis: Axis3 }
  // Holes along `face`'s inward normal at `points` (projected) and `sketch`'s points. A missing dimension comes from
  // `size` (features/holeStandards.ts).
  | {
      id: string;
      type: "hole";
      face?: Selector;
      points: Vec3[];
      sketch?: string;
      body?: string;
      holeType?: HoleType;
      standard?: HoleStandard;
      size?: string;
      fit?: HoleFit;
      diameter?: Num;
      extent?: "blind" | "through";
      depth?: Num;
      cbDiameter?: Num;
      cbDepth?: Num;
      csDiameter?: Num;
      csAngle?: Num;
      leadIn?: Num;
      drillPoint?: boolean;
      flip?: boolean;
      tapped?: boolean;
    }
  // A helical groove (cut) or ridge (join). `profile` points are [into the material, along the axis] mm;
  // `spec` is the Thread tool's record of the standard size it picked.
  | {
      id: string;
      type: "thread";
      face: Selector;
      profile: [number, number][];
      pitch: Num;
      starts?: Num;
      hand?: "right" | "left";
      axis?: Vec3;
      offset?: Num;
      length?: Num;
      clearance?: Num;
      operation?: "cut" | "join";
      body?: string;
      spec?: Record<string, unknown>;
      name?: string;
    }
  // Wraps onto a round face at true size. `at` is the anchor as fractions of the face's (u, v) range, preferred over
  // `point`.
  | {
      id: string;
      type: "textOnFace";
      face: Selector;
      text: string;
      height: Num;
      depth: Num;
      operation?: "join" | "cut";
      body?: string;
      font?: string;
      style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right";
      angle?: Num;
      point?: Vec3;
      at?: [Num, Num];
      name?: string;
    }
  // Patterns union their copies; `bodies` absent is the active body. `features` (exclusive with `bodies`) repeats
  // those features' tools on the body they cut or joined, skipping a copy that misses it.
  | {
      id: string;
      type: "patternRect";
      countX: Num;
      countY: Num;
      spacingX: Num;
      spacingY: Num;
      bodies?: string[];
      features?: string[];
    }
  | { id: string; type: "patternLinear"; count: Num; spacing: Num; axis: Axis3; bodies?: string[]; features?: string[] }
  // `axis` is a world axis through the origin, a line, or `{datum}`; `axisRef` makes it follow an edge or face.
  | {
      id: string;
      type: "patternCircular";
      count: Num;
      angle: Num;
      axis: AxisSpec | { datum: string };
      axisRef?: Selector;
      bodies?: string[];
      features?: string[];
    }
  // Merges near coplanar mesh facets within `tolerance` degrees, which also coarsens curved regions.
  | { id: string; type: "simplifyMesh"; tolerance: Num }
  // sx/sy/sz override `factor` per axis; `about` is the point held still.
  | { id: string; type: "scale"; factor: Num; sx?: Num; sy?: Num; sz?: Num; about?: Vec3; bodies?: string[] }
  // dx, dy, dz in mm, then rx, ry, rz in degrees about the origin; `bodies` absent is the active body.
  | { id: string; type: "move"; dx: Num; dy: Num; dz: Num; rx: Num; ry: Num; rz: Num; bodies?: string[] }
  | { id: string; type: "duplicate"; dx: Num; dy: Num; dz: Num; rx: Num; ry: Num; rz: Num; bodies?: string[] }
  // Aligns the mate connectors (axes opposed unless `flush`), then slides by `offset` and spins by `angle` about them.
  | {
      id: string;
      type: "joint";
      moving: string;
      mate: MateConnector;
      to: MateConnector;
      mode?: JointMode;
      flush?: boolean;
      offset?: Num;
      angle?: Num;
      name?: string;
    }
  // A closed loop linkage solved with `ground` fixed and the `drive` joint at `offset` (mm, slider) or `angle`
  // (degrees, revolute); the value not matching the drive's mode is ignored.
  | {
      id: string;
      type: "mechanism";
      ground: string;
      joints: MechanismJoint[];
      drive?: string;
      offset?: Num;
      angle?: Num;
      name?: string;
    }
  // Repair boolean debris; parametric because later booleans make more of it.
  | { id: string; type: "cleanUp"; body?: string; tolerance?: Num }
  // Deleting a body from the browser appends one of these after every feature that made it.
  | { id: string; type: "removeBody"; bodies: string[] };

/** A feature a plugin owns. The app carries and saves it losslessly without the plugin,
 *  and reports it unbuildable (document/missingPlugins.ts). */
export interface PluginFeature {
  id: string;
  type: string;
  [field: string]: unknown;
}

export type PlaneOf = { face: Selector } | { plane: string };
export type PointAt =
  { edge: Selector; end?: "start" | "end" | "mid"; t?: Num; point?: Vec3 } | { face: Selector } | { datum: string };
export type PlaneThrough =
  | { kind: "mid"; a: PlaneOf; b: PlaneOf }
  | { kind: "points"; points: PointAt[] }
  | { kind: "normalToEdge"; edge: Selector; vertex?: PointAt }
  | { kind: "twoEdges"; a: Selector; b: Selector }
  | { kind: "angle"; edge: Selector; from: PlaneOf };
export type AxisThrough =
  | { kind: "points"; a: PointAt; b: PointAt }
  | { kind: "cylinder"; face: Selector }
  | { kind: "planes"; a: PlaneOf; b: PlaneOf };

export type Feature = CoreFeature | PluginFeature;

/** The `type` of a feature the APPLICATION defines. A plugin's is just a string. */
export type FeatureType = CoreFeature["type"];

/** `satisfies` makes a type added to CoreFeature and missed here a compile error. */
const CORE_FEATURE_TYPES = {
  boolean: true,
  box: true,
  chamfer: true,
  cleanUp: true,
  cone: true,
  cylinder: true,
  datumAxis: true,
  datumPlane: true,
  datumPoint: true,
  deleteFace: true,
  draft: true,
  duplicate: true,
  extrude: true,
  fillet: true,
  hole: true,
  import: true,
  imprint: true,
  joint: true,
  loft: true,
  mechanism: true,
  mirror: true,
  move: true,
  offsetFace: true,
  patternCircular: true,
  patternLinear: true,
  patternRect: true,
  "press-pull": true,
  removeBody: true,
  revolve: true,
  scale: true,
  separate: true,
  shell: true,
  simplifyMesh: true,
  sketch: true,
  sphere: true,
  split: true,
  sweep: true,
  textOnFace: true,
  thicken: true,
  thread: true,
  torus: true,
} as const satisfies Record<FeatureType, true>;

export function isCoreFeatureType(type: string): type is FeatureType {
  return Object.prototype.hasOwnProperty.call(CORE_FEATURE_TYPES, type);
}

/** `f.type === "sketch"` cannot narrow away PluginFeature's string type, this can. */
export function isFeature<T extends FeatureType>(f: Feature, type: T): f is Extract<CoreFeature, { type: T }> {
  return f.type === type;
}

export function asFeature<T extends FeatureType>(
  f: Feature | null | undefined,
  type: T,
): Extract<CoreFeature, { type: T }> | null {
  return f && f.type === type ? (f as Extract<CoreFeature, { type: T }>) : null;
}

export function featuresOf<T extends FeatureType>(
  features: readonly Feature[],
  type: T,
): Extract<CoreFeature, { type: T }>[] {
  return features.filter((f): f is Extract<CoreFeature, { type: T }> => f.type === type);
}

// A model face the user mapped to a ViewCube side. `normal` points out of the surface, `up` is screen +Y.
export type ViewCubeSide = "front" | "back" | "left" | "right" | "top" | "bottom";
export type ViewOverride = { normal: [number, number, number]; up: [number, number, number] };

// Parameters are evaluated in the frontend only; the engine sees numbers.
/** Lengths are mm, angles degrees, counts raw. */
export type ParamUnit = "mm" | "deg" | "count";

/** Where a model parameter's value is written, by stable id. Entity targets are for rigid
 *  shapes only; solved geometry is driven through a dimension. */
export type ParamTarget =
  | { kind: "feature"; feature: string; field: string }
  | { kind: "constraint"; sketch: string; constraint: string }
  | { kind: "entity"; sketch: string; entity: string; field: string }
  | { kind: "pattern"; sketch: string; pattern: string; field: string };

/** `expr` is the source of truth; `value` is its cached result in canonical units, always present so a build need not
 *  evaluate anything. */
export interface ParamDef {
  expr: string;
  value: number;
  unit: ParamUnit;
  comment?: string;
  /** present = model parameter (dN, drives one field); absent = user parameter. */
  target?: ParamTarget;
  /** RESERVED (unimplemented): driven-dim params are geometry→value sources. */
  driven?: boolean;
  /** Drawn by FundaCAD.ExtraParameters; the build and evaluator never read it, so a document builds without the plugin. */
  control?: ParamControl;
  /** id of a `paramExtras.groups` row; absent = ungrouped. */
  group?: string;
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

/** The plugin shows `message` when `expr` is 0 or does not evaluate. */
export interface ParamCheck {
  id: string;
  expr: string;
  message: string;
  level: "warning" | "error";
}

/** The params engine renames and deletes names in here, so it stays right without the plugin that edits it. */
export interface ParamExtras {
  groups?: { id: string; name: string }[];
  configurations?: ParamConfiguration[];
  activeConfiguration?: string;
  checks?: ParamCheck[];
}

export interface CadDocument {
  parameters: Params;
  /** The source of truth; `parameters` is its name→value cache, rebuilt on save and send for the engine and
   *  pre v2 readers. */
  paramDefs?: Record<string, ParamDef>;
  paramExtras?: ParamExtras;
  features: Feature[];
  viewOverrides?: Partial<Record<ViewCubeSide, ViewOverride>>;
  // Project state below is saved so reopening restores the session; only parameters and features build.
  /** file format version, for future migrations (current 1). */
  version?: number;
  suppressed?: string[];
  versions?: import("./document/versions").VersionRepo;
  /** count of active features; absent or null builds all. */
  rollback?: number | null;
  sketchVisibility?: Record<string, boolean>;
  bodyVisibility?: Record<string, boolean>;
  /** datum feature id → visible */
  planeVisibility?: Record<string, boolean>;
  /** "<featureId>:<n>" → "bodyN", so ids survive changes around them; older files get positional ids once, then
   *  keep them. */
  bodyIds?: Record<string, string>;
  bodyNames?: Record<string, string>;
  /** The user's display only folders over the bodies (document/elements.ts). */
  elements?: { id: string; name: string; parent?: string }[];
  /** body id → element id; a body with no entry shows at the top level or under its import's assembly node. */
  bodyElement?: Record<string, string>;
  /** Read by plugins/FundaCAD.ReferenceImages; entries are kept whole, so unknown fields survive. */
  referenceImages?: Record<string, unknown>[];
  /** Display only, absent is the starter set. Not the filament `palette`, which is what a part is made from. */
  materials?: {
    id: string;
    name: string;
    color: string;
    metalness?: number;
    roughness?: number;
    opacity?: number;
    emissive?: number;
  }[];
  /** body id → material id. */
  bodyMaterial?: Record<string, string>;
  /** `bodyId#localFaceIndex` → material id, at the face list of the build the file was saved with. */
  faceMaterials?: Record<string, string>;
  /** The same keys → that face's print, to find it again after a rebuild reorders faces (document/faceRefs.ts). */
  facePrints?: Record<string, import("./document/faceRefs").FacePrint>;
  /** import feature id → "faces" where parts wear face colours over body colours; absent means "bodies". */
  importColorSource?: Record<string, ImportColorSource>;
  /** filament slots, `material` such as "PLA" */
  palette?: { name: string; color: string; material?: string }[];
  /** body id → slot index into `palette` */
  bodyColors?: Record<string, number>;
  /** Selectors only, the Stress panel finds the faces again on the build it opens on (document/stressStudy.ts). */
  stress?: StressStudy;
  /** only for a custom environment */
  environment?: import("./document/docEnvironment").DocEnvironment;
  sectionView?: SectionView;
}

/** How the removed half of a section is drawn. */
export type SectionGhost = "hidden" | "faint" | "soft" | "strong";

/** A section cut as the document saves it: `offset` mm along `normal` from `origin`, keeping the half `normal`
 *  points into when `side` is 1 (features/sectionMath.ts clipPlaneAt). */
export interface SectionView {
  origin: Vec3;
  normal: Vec3;
  offset: number;
  side: 1 | -1;
  ghost: SectionGhost;
}

export type AxisDirection = "-Z" | "+Z" | "+X" | "-X" | "+Y" | "-Y";

/** fixed holds all directions, pinned holds a cylinder radially and axially but lets it turn, slider holds the normal. */
export type StressSupportType = "fixed" | "pinned" | "slider";

/** The body surface within `radius` mm of `at`, for a support or load with no face. `normal` is the outward normal
 *  "into the face" reads; a spot written by hand or over MCP may lack it. */
export interface StressSpot {
  at: [number, number, number];
  radius: number;
  normal?: [number, number, number];
}

/** Units are mm, N, MPa and g/cm3; gravity is 9.81 m/s2 along its direction. */
export interface StressStudy {
  body: string | null;
  supports: { id: number; type: StressSupportType; faces: Selector[]; spots?: StressSpot[] }[];
  loads: {
    id: number;
    kind: "force" | "pressure";
    faces: Selector[];
    spots?: StressSpot[];
    /** N, the total over the faces. */
    force: number;
    direction: "into" | AxisDirection | "custom";
    custom: [number, number, number];
    /** MPa, pushing into the faces. */
    pressure: number;
  }[];
  gravity: { on: boolean; direction: AxisDirection };
  /** A preset's name, or "Custom" for the numbers in `custom`. */
  material: string;
  custom: { E: number; nu: number; yield: number; density: number };
  /** mm, null for the engine's automatic size. */
  size: number | null;
  /** Absent for Standard, so a default study saves as before. */
  refine?: "fine" | "off";
}

// A non-fatal note from a rebuild: a low-confidence match, a skipped boolean, a sealed void.
export interface ResolveDiag {
  feature_id?: string;
  // edgeOpFailed: `failed` names the edges to paint red. sealedVoid: a cut closed a
  // cavity inside the body (legal, so not an error; the other fields are neutral).
  kind: "edge" | "face" | "boolean" | "edgeOpFailed" | "sealedVoid" | "separateFaces";
  resolved: number; // how many entities matched (0 for a skipped boolean)
  confidence: number; // 0..1, margin to the runner-up candidate (1 = lone clear pick)
  lossy: boolean; // a marginal / drift-path match was taken (or a feature was skipped)
  reason?: string;
  failed?: { mid: [number, number, number] }[]; // edgeOpFailed only: failed edges' midpoints
  // For "ambiguous nearest pick": the selector's own point, naming which one to re-pick.
  at?: [number, number, number];
  candidates?: string[];
  // separateFaces: the body a Separate took apart and, per piece, its run in that body's face list as last built.
  source?: string;
  pieces?: { body: string; from: number; count: number }[];
}

// Plain arrays from text replies and the in process Rust backend, typed views over a binary WS frame;
// consumers only index and read .length.
export type F32Wire = number[] | Float32Array;
export type U32Wire = number[] | Uint32Array;

export interface TrackedFaceRecord {
  extent?: [number, number, number, number];
  point: Vec3;
  points: Vec3[];
}

export interface RebuildResult {
  mesh: { positions: F32Wire; indices: U32Wire; faceIds: U32Wire; normals?: F32Wire };
  // `smooth`: the two faces meet tangentially here (a fillet's boundary), drawn per the tangent edges setting.
  edges: { id: string; points: [number, number, number][]; body?: string; smooth?: boolean }[];
  bbox: { min: Vec3; max: Vec3 };
  // Each body's faceId range. No `etag` means always rebuild the body's mesh.
  bodies?: {
    id: string;
    name: string;
    faceStart: number;
    faceCount: number;
    faceOwners?: (string | null)[];
    faceBands?: number[][];
    faceColorSlots?: (number | null)[];
    fault?: string;
    etag?: string;
    nodeRef?: string;
    faceColors?: FaceColorRuns;
    partColor?: string;
    scan?: true;
  }[];
  // when any selector resolved with low confidence
  diagnostics?: ResolveDiag[];
  // Failed features beside what did build; featureError is the most downstream, `code` a category the UI acts on.
  featureError?: { feature_id?: string; message: string; code?: string };
  featureErrors?: { feature_id?: string; message: string; code?: string; detail?: FeatureErrorDetail }[];
  /** Types the engine does not know (a newer file), left out of the build and kept in the document; not errors. */
  skippedFeatures?: { feature_id: string; type: string; message: string }[];
  // absent at steady state; the store lands them in a no undo commit (DocumentStore.commitProjectionRefresh)
  projectionUpdates?: ProjectionUpdate[];
  // Where every datum plane resolved, offset applied; not written back into the document.
  datumPlanes?: Record<string, PlaneDef>;
  // Only face-following sketches that moved; readers fall back to the cached `plane`.
  sketchPlanes?: Record<string, PlaneDef>;
  datumMarks?: Record<string, DatumMark>;
  /** By feature id, its `tracked` face's outline now and where its pick point and positions went. */
  trackedFaces?: Record<string, TrackedFaceRecord>;
  /** sent only when it changed */
  bodyIds?: Record<string, string>;
}

/** A geometry following datum as resolved this rebuild. A mechanism's drive axis carries `value`, the solved drive
 *  coordinate (mm slider, degrees revolute), so its handle starts where the parts are rather than at 0. */
export type DatumMark = { kind: "axis"; origin: Vec3; dir: Vec3; value?: number } | { kind: "point"; position: Vec3 };

export type RebuildReply =
  | { ok: true; result: RebuildResult }
  | { ok: false; error: { feature_id?: string; message: string }; cancelled?: boolean };

export type ExportFormat = "step" | "stl" | "3mf" | "glb" | "dxf" | "svg";

export interface MeshExportOptions {
  unit: "mm" | "cm" | "m" | "in" | "ft";
  binary: boolean;
  surfaceDeviation: number;
  normalDeviation: number;
  maxEdgeLength: number;
}

export type ImportFormat =
  | "stl"
  | "3mf"
  | "step"
  | "obj"
  | "brep"
  | "glb"
  | "gltf"
  | "iges"
  | "fcstd"
  | "ply"
  | "off"
  | "amf"
  | "vrml"
  | "x3d"
  | "xbf"
  | "3dm"
  | "ifc"
  | "dxf"
  | "fbx"
  | "3ds"
  | "svg";
export type ImportReply =
  // A DXF answers one sketch per layer, with `geom` only when it also held 3D faces.
  | {
      ok: true;
      geom?: string;
      name: string;
      solid?: boolean;
      faces?: number;
      color?: string;
      sketches?: { name: string; entities: SketchEntity[]; fillRule?: "evenodd" }[];
      // only for a STEP with a real assembly tree, as on the `import` feature
      nodes?: { name: string; parent: number | null; color?: string }[];
      parts?: { node: number; faces: number; faceColors?: FaceColorRuns; color?: string }[];
      notes?: string[];
      unit?: string;
      // a mesh past the editable limit, kept as a read only reference scan
      scan?: boolean;
      triangles?: number;
    }
  // `cancelled` lets the UI dismiss quietly instead of showing an error for a stop the user asked for.
  | { ok: false; cancelled?: boolean; message: string };

/** fundacad-geom builder `failure_detail`, for the error report. */
export interface FeatureErrorDetail {
  index: number;
  type: string | null;
  ms: number;
  /** OpenCASCADE calls, oldest first. */
  kernel: { op: string; ms?: number; args?: string; error?: string }[];
  bodies: { id: string; name: string; shape: string }[];
  bodyCount: number;
  params: Record<string, number>;
  occt: string;
}
