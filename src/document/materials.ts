// Materials: what a body is made of, as far as the picture is concerned.
//
// WHAT THIS IS AND IS NOT. A material here is APPEARANCE, a colour and a
// finish: how matt it is, how metallic, how much light goes through it. It is
// not a physical property (no density, no modulus, nothing computes a mass from
// it), and it is not geometry: assigning one changes what the viewport draws and
// nothing else, so a document with every material deleted rebuilds
// byte-identically to one that never had any.
//
// WHY IT IS NOT THE FILAMENT PALETTE. The document already carries a `palette`
// of up to four slots, and those mean "print this part from the filament in
// toolhead N". That is a manufacturing instruction with a physical machine
// behind it, which is why it is capped at four and why the multi-colour
// capability owns it. A material library has neither cap nor machine, is about
// what a part LOOKS like, and is the thing an imported assembly's own colours
// land in. They coexist: a body can carry both, and where it does the palette
// slot wins on screen, because a slot is a deliberate choice about a real
// print and a material is usually whatever the file said.
//
// This module is the pure half: no store, no Vue, no DOM, no file system. What
// a material is, what its defaults are, how one is read back from a library file
// somebody else wrote, and how an arbitrary colour finds the closest one.

/** One material. Everything but id/name/color is optional and absent means the
 *  app's own default finish (see FINISH below), so the common case, a colour
 *  with nothing else said about it, is three fields on disk. */
/** A procedural surface pattern on a material: noise, scratches, brushed streaks
 *  or cellular wear, computed in the shader (viewport/proceduralSurface.ts) and
 *  driving roughness, a bump and a colour tint. Triplanar, so it needs no UVs.
 *  The eventual node editor produces a richer form of this. */
export interface SurfaceSpec {
  kind: "noise" | "scratches" | "brushed" | "voronoi";
  scale: number;      // feature size in mm
  amount: number;     // 0..1, roughness push
  angle?: number;     // radians, scratch/brushed direction
  bump?: number;      // 0..1, relief
  color?: string;     // "#rrggbb" tint
  colorAmount?: number; // 0..1
}

/** One node of a material's surface graph, the general form the node editor
 *  produces. A generator (noise/scratches/brushed/voronoi) reads world space and
 *  gives a float; `ramp` turns a float into a colour; `mix` blends two floats;
 *  `output` is the sink with roughness / bump / colour ports. Params are baked
 *  into the compiled shader (numbers, or "#rrggbb"); `in` wires an input port to
 *  another node's id. See viewport/proceduralSurface.ts for the compiler. */
export interface SurfaceNode {
  id: string;
  type: "noise" | "scratches" | "brushed" | "voronoi" | "ramp" | "mix" | "output";
  params?: Record<string, number | string>;
  in?: Record<string, string>;
}

export interface SurfaceGraph {
  nodes: SurfaceNode[];
  output: string; // id of the output node
}

export interface MaterialDef {
  id: string;
  name: string;
  /** "#rrggbb", lower case. The one field the viewport always uses. */
  color: string;
  /** 0..1. How metallic: 0 is a dielectric (plastic, paint), 1 is bare metal. */
  metalness?: number;
  /** 0..1. How rough: 0 is a mirror, 1 is chalk. */
  roughness?: number;
  /** 0..1. 1 is opaque, which is the default and is omitted when it holds. */
  opacity?: number;
  /** 0..1. How much light the surface gives off ITSELF, on top of the light
   *  falling on it. A screen, an indicator, a light guide: the parts of an
   *  assembly that are not lit but lighting.
   *
   *  A number and not a second colour, deliberately. A material already has a
   *  colour and a part that glows glows in its own colour; a separate emissive
   *  colour is a second thing to keep in step with the first, and the case it
   *  buys (a red part that glows green) is not one anybody has asked for. What
   *  it costs is one slider instead of a slider and a picker. */
  emissive?: number;
  /** 0..1. A clear lacquer over the surface: a second, glossy, dielectric layer
   *  the way car paint, glazed ceramic or a coated plastic has one. It keeps the
   *  base colour and roughness (a matte base stays matte UNDER a wet-looking
   *  sheen) and adds the hard bright highlight of the coat on top. A physical-PBR
   *  feature, so it is dropped on the lightweight render like glass is. */
  clearcoat?: number;
  /** Procedural surface detail (noise / scratches / brushed / wear). Absent for
   *  a plain material. The single-generator form the picker writes. */
  surface?: SurfaceSpec;
  /** The full node graph, what the node editor produces. Takes precedence over
   *  `surface` when present. Absent for a plain or single-generator material. */
  surfaceGraph?: SurfaceGraph;
}

/** The finish an unspecified material has, which is exactly the one every body
 *  in this app has always been drawn with (see viewport/render.ts). Sharing the
 *  numbers is what makes "no material" and "a material that says nothing about
 *  its finish" the same picture instead of two nearly identical ones. */
export const FINISH = { metalness: 0.1, roughness: 0.55, opacity: 1, emissive: 0, clearcoat: 0 } as const;

/** The four numbers the renderer wants, never undefined, so the render path has
 *  no branches in it. Named because it now travels: the store hands a map of
 *  them to the viewport on every build. */
export interface BodyFinish {
  metalness: number;
  roughness: number;
  opacity: number;
  emissive: number;
  clearcoat: number;
  /** Carried straight through when a material has one, so the viewport can build
   *  the procedural shader. Undefined is the common case. */
  surface?: SurfaceSpec;
  surfaceGraph?: SurfaceGraph;
}

export function finishOf(m: MaterialDef | undefined): BodyFinish {
  return {
    metalness: m?.metalness ?? FINISH.metalness,
    roughness: m?.roughness ?? FINISH.roughness,
    opacity: m?.opacity ?? FINISH.opacity,
    emissive: m?.emissive ?? FINISH.emissive,
    clearcoat: m?.clearcoat ?? FINISH.clearcoat,
    ...(m?.surface ? { surface: m.surface } : {}),
    ...(m?.surfaceGraph ? { surfaceGraph: m.surfaceGraph } : {}),
  };
}

/** What a finish reads as, in words. "Glossy, metallic", "Matte", "Satin, lit".
 *
 *  For the list beside the rendered swatch, and it is not decoration: the sphere
 *  says what the material looks like and this says what it IS, which is what a
 *  search box can match on and what a screen reader gets instead of a picture.
 *  Two parts, because they answer different questions, how polished the surface
 *  is, and what kind of stuff it is.
 *
 *  The kinds are ordered rather than combined. A material can be shiny AND
 *  see-through AND metallic on paper, but a phrase listing three qualities is
 *  read by nobody; the one that is picked is the one that changes the picture
 *  most. Something that gives off light is a light whatever else it is, and
 *  something you can see through is see-through before it is anything else. */
export function finishLabel(m: MaterialDef | undefined): string {
  const f = finishOf(m);
  const gloss = f.roughness <= 0.18 ? "Glossy" : f.roughness <= 0.45 ? "Satin" : "Matte";
  const kind = f.emissive > 0 ? "lit"
    : f.opacity < 1 ? "transparent"
      : f.metalness >= 0.5 ? "metallic"
        : "";
  return kind ? `${gloss}, ${kind}` : gloss;
}

/** The library a new document starts with.
 *
 *  Generic engineering and print materials, named for the stuff and not for any
 *  supplier's product. Deliberately short: a starter library is a set of
 *  examples showing what the fields do, and a hundred rows nobody chose is a
 *  list to scroll past rather than a library to work from. Adding to it is one
 *  button.
 *
 *  EVERY ENTRY IS ALREADY IN NORMAL FORM, i.e. normalizeMaterial leaves it
 *  alone, and materials.test.ts holds that. It is not cosmetic: a field holding
 *  the same value as the default is dropped on read, so an entry carrying one
 *  would fail to round-trip through an export, and the store's "is this still
 *  the untouched library" check, which is what keeps an unstyled document from
 *  writing a materials block at all, would answer no the moment the file was
 *  reopened. */
export const STARTER_LIBRARY: readonly MaterialDef[] = Object.freeze([
  { id: "m-aluminium", name: "Aluminium", color: "#b8bcc0", metalness: 0.9, roughness: 0.35 },
  { id: "m-steel", name: "Steel", color: "#8f959b", metalness: 0.95, roughness: 0.28 },
  { id: "m-brass", name: "Brass", color: "#c9a227", metalness: 0.9, roughness: 0.3 },
  { id: "m-copper", name: "Copper", color: "#b06a3b", metalness: 0.95, roughness: 0.25 },
  { id: "m-gold", name: "Gold", color: "#d4af37", metalness: 1, roughness: 0.22 },
  { id: "m-chrome", name: "Chrome", color: "#e8ecf0", metalness: 1, roughness: 0.03 },
  { id: "m-titanium", name: "Titanium", color: "#9a9ea3", metalness: 0.9, roughness: 0.42 },
  // Clearcoat pair: a metallic-flake base under a hard clear lacquer, and a matte
  // dielectric under a glaze. Both keep their base roughness and gain the coat's
  // bright sheen, which is the whole point of the field.
  { id: "m-carpaint", name: "Car paint, red", color: "#a51321", metalness: 0.55, roughness: 0.38, clearcoat: 1 },
  { id: "m-ceramic", name: "Ceramic, glazed", color: "#eceae4", metalness: 0.0, roughness: 0.32, clearcoat: 1 },
  { id: "m-plastic-white", name: "Plastic, white", color: "#e8e8e8", metalness: 0.02, roughness: 0.6 },
  { id: "m-plastic-black", name: "Plastic, black", color: "#232323", metalness: 0.02, roughness: 0.5 },
  { id: "m-rubber", name: "Rubber", color: "#1d1f22", metalness: 0.0, roughness: 0.95 },
  { id: "m-wood", name: "Wood", color: "#9a6b3f", metalness: 0.0, roughness: 0.8 },
  { id: "m-glass", name: "Glass", color: "#cfe4ee", metalness: 0.0, roughness: 0.05, opacity: 0.25 },
  { id: "m-acrylic", name: "Acrylic, clear", color: "#dfeaf0", metalness: 0.0, roughness: 0.15, opacity: 0.45 },
  // The one entry that is not a material you could hold: a lit indicator. It is
  // in the starter library because the emissive slider is otherwise a control
  // whose effect nobody sees until they have already guessed what it does.
  { id: "m-emitter", name: "Indicator, lit", color: "#42e07a", metalness: 0.0, roughness: 0.4, emissive: 0.8 },
]);

const HEX = /^#?[0-9a-f]{6}$/i;

/** A colour string as "#rrggbb", or null when it is not one.
 *
 *  Three-digit hex is expanded rather than refused: it is what a person types
 *  into a library file by hand, and refusing it would be refusing a colour over
 *  its spelling. */
export function asHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  const short = /^#?([0-9a-f]{3})$/i.exec(t);
  if (short) {
    const [r, g, b] = short[1]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return HEX.test(t) ? `#${t.replace(/^#/, "").toLowerCase()}` : null;
}

const clamp01 = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;

/** One entry of a library file as this app understands it, or null.
 *
 *  Null for anything with no usable colour, because a material without one is
 *  not a material that renders oddly, it is a row that can be assigned to a body
 *  and then change nothing. Everything else is repaired rather than refused: an
 *  out-of-range roughness is clamped, a missing name falls back to the id, and a
 *  missing id is minted from the name, so a hand-written file that gets a field
 *  wrong loses that field and not the material. */
export function normalizeMaterial(raw: unknown, index = 0): MaterialDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const color = asHex(r["color"] ?? r["colour"] ?? r["hex"]);
  if (!color) return null;
  const name = typeof r["name"] === "string" && r["name"].trim() ? r["name"].trim() : "";
  const id =
    typeof r["id"] === "string" && r["id"].trim()
      ? r["id"].trim()
      : slugId(name || `material ${index + 1}`);
  const out: MaterialDef = { id, name: name || id, color };
  // Omit-when-default, so a plain colour round-trips as three fields and a
  // library written by this app reads back byte-identically.
  const metalness = clamp01(r["metalness"]);
  const roughness = clamp01(r["roughness"]);
  const opacity = clamp01(r["opacity"]);
  const emissive = clamp01(r["emissive"]);
  const clearcoat = clamp01(r["clearcoat"]);
  if (metalness !== undefined && metalness !== FINISH.metalness) out.metalness = metalness;
  if (roughness !== undefined && roughness !== FINISH.roughness) out.roughness = roughness;
  if (opacity !== undefined && opacity !== FINISH.opacity) out.opacity = opacity;
  if (emissive !== undefined && emissive !== FINISH.emissive) out.emissive = emissive;
  if (clearcoat !== undefined && clearcoat !== FINISH.clearcoat) out.clearcoat = clearcoat;
  const surface = normalizeSurface(r["surface"]);
  if (surface) out.surface = surface;
  const graph = normalizeGraph(r["surfaceGraph"]);
  if (graph) out.surfaceGraph = graph;
  return out;
}

const NODE_TYPES: readonly SurfaceNode["type"][] = [
  "noise", "scratches", "brushed", "voronoi", "ramp", "mix", "output",
];

/** Narrow an untrusted surface graph, or drop it. Structural only: a node needs
 *  an id and a known type; the output must name a node. The compiler treats a
 *  missing wire or param as a default, so a partial-but-shaped graph is kept
 *  rather than refused. */
export function normalizeGraph(raw: unknown): SurfaceGraph | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r["nodes"]) || typeof r["output"] !== "string") return undefined;
  const nodes: SurfaceNode[] = [];
  for (const n of r["nodes"] as unknown[]) {
    if (!n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    const type = NODE_TYPES.find((t) => t === o["type"]);
    if (typeof o["id"] !== "string" || !type) continue;
    const node: SurfaceNode = { id: o["id"], type };
    if (o["params"] && typeof o["params"] === "object") node.params = o["params"] as Record<string, number | string>;
    if (o["in"] && typeof o["in"] === "object") node.in = o["in"] as Record<string, string>;
    nodes.push(node);
  }
  if (!nodes.some((n) => n.id === r["output"])) return undefined;
  return { nodes, output: r["output"] };
}

const SURFACE_KINDS: readonly SurfaceSpec["kind"][] = ["noise", "scratches", "brushed", "voronoi"];

/** Narrow an untrusted surface object, or drop it. A bad kind or a non-positive
 *  scale is not a surface, so the material reads back as plain rather than as a
 *  shader that does nothing or throws. */
export function normalizeSurface(raw: unknown): SurfaceSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const kind = SURFACE_KINDS.find((k) => k === r["kind"]);
  const scale = typeof r["scale"] === "number" && r["scale"] > 0 ? r["scale"] : undefined;
  const amount = clamp01(r["amount"]);
  if (!kind || scale === undefined || amount === undefined) return undefined;
  const out: SurfaceSpec = { kind, scale, amount };
  if (typeof r["angle"] === "number") out.angle = r["angle"];
  const bump = clamp01(r["bump"]);
  if (bump !== undefined && bump > 0) out.bump = bump;
  const color = asHex(r["color"]);
  const colorAmount = clamp01(r["colorAmount"]);
  if (color && colorAmount !== undefined && colorAmount > 0) {
    out.color = color;
    out.colorAmount = colorAmount;
  }
  return out;
}

/** A name to an id that is safe in a file name, a URL and a JSON key. */
export function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `m-${slug || "material"}`;
}

/** Make `id` unique against `taken`, by suffixing a number. */
export function uniqueId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const next = `${id}-${n}`;
    if (!taken.has(next)) return next;
  }
}

/** A name no other material uses, "Copper", then "Copper 2", … */
export function freshMaterialName(
  materials: readonly MaterialDef[],
  base = "Material",
): string {
  const taken = new Set(materials.map((m) => m.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** What a library file holds, as this app writes it. `version` is there so a
 *  later shape can be told from this one without guessing from the fields. */
export interface MaterialLibraryFile {
  version: 1;
  materials: MaterialDef[];
}

/** Read a library file. Never throws: a file somebody else wrote is data, and
 *  the useful answer to a broken one is the materials that were readable plus a
 *  sentence about the rest, not an exception in a file dialog.
 *
 *  Both shapes are accepted, `{materials:[…]}` and a bare `[…]`, because the
 *  bare array is what a person exports from a spreadsheet or writes by hand. */
export function parseLibrary(json: string): { materials: MaterialDef[]; problem: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { materials: [], problem: `not readable as JSON: ${(e as Error).message}` };
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { materials?: unknown })?.materials)
      ? (parsed as { materials: unknown[] }).materials
      : null;
  if (!rows) {
    return { materials: [], problem: "no materials in it, expected a list or {\"materials\": [...]}" };
  }
  const out: MaterialDef[] = [];
  const taken = new Set<string>();
  let dropped = 0;
  rows.forEach((row, i) => {
    const m = normalizeMaterial(row, i);
    if (!m) {
      dropped++;
      return;
    }
    m.id = uniqueId(m.id, taken);
    taken.add(m.id);
    out.push(m);
  });
  const problem = dropped
    ? `${dropped} of ${rows.length} had no usable colour and ${dropped === 1 ? "was" : "were"} skipped`
    : null;
  return { materials: out, problem };
}

/** Write a library file, pretty, because the point of exporting one is that
 *  somebody can open it. */
export function serializeLibrary(materials: readonly MaterialDef[]): string {
  const file: MaterialLibraryFile = { version: 1, materials: materials.map((m) => ({ ...m })) };
  return JSON.stringify(file, null, 2);
}

function rgb(hex: string): [number, number, number] | null {
  const h = asHex(hex);
  if (!h) return null;
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

/** The material closest to `hex`, or null when nothing is within `tolerance`.
 *
 *  A TOLERANCE, unlike the palette's nearest-slot match, which always answers.
 *  The palette has four physical slots and every part has to print from one of
 *  them, so "nearest" is the whole question. A library is open-ended, and the
 *  useful answer to an imported colour nothing in the library resembles is "this
 *  is a new material", not "here is the least wrong of the ten you had". The
 *  default is a squared RGB distance of 24 per channel, close enough that two
 *  shades of the same grey match and two greys apart do not.
 *
 *  Squared RGB and not a perceptual space, deliberately: what is being matched
 *  is a colour a CAD system wrote into a file, usually one of a handful of round
 *  numbers, and not two photographs. */
export function nearestMaterial(
  hex: string,
  materials: readonly MaterialDef[],
  tolerance = 24 * 24 * 3,
): MaterialDef | null {
  const want = rgb(hex);
  if (!want) return null;
  let best: MaterialDef | null = null;
  let bestD = Infinity;
  for (const m of materials) {
    const got = rgb(m.color);
    if (!got) continue;
    const d = (want[0] - got[0]) ** 2 + (want[1] - got[1]) ** 2 + (want[2] - got[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return bestD <= tolerance ? best : null;
}

// --- what an imported file's own colours become -------------------------------

/** Rough colour names, for naming a material nothing in the library matched.
 *
 *  A STEP file's colours have no names at all (XCAF stores an RGB triple per
 *  product), so "Imported #b06a3b" is the honest alternative and it is a
 *  terrible row to have in a library: unreadable, unsortable, and identical in
 *  shape to the nine beside it. A rough name is wrong about the exact shade and
 *  right about which row is which, which is what a list is for. The file's own
 *  material name is preferred wherever it has one (3MF and glTF do). */
const BASIC_COLORS: readonly [string, number][] = [
  ["black", 0x1a1a1a], ["white", 0xf0f0f0], ["grey", 0x808080],
  ["red", 0xd23b30], ["orange", 0xe07a1f], ["yellow", 0xe0c020],
  ["green", 0x3aa04a], ["cyan", 0x30b0b8], ["blue", 0x3050c8],
  ["purple", 0x7a3fb0], ["pink", 0xd88098], ["brown", 0x8a5a30],
];

/** A rough name for a colour, e.g. "#b06a3b" -> "brown". */
export function colorName(hex: string): string {
  const want = rgb(hex);
  if (!want) return "colour";
  let best = "colour";
  let bestD = Infinity;
  for (const [name, value] of BASIC_COLORS) {
    const got: [number, number, number] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    const d = (want[0] - got[0]) ** 2 + (want[1] - got[1]) ** 2 + (want[2] - got[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** Turn the colours an imported file carried into material assignments.
 *
 *  PURE, and the whole decision: which colours already have a material in this
 *  document, and what to call the ones that do not. The IO half (running the
 *  rebuild, finding which bodies the import produced, writing to the store)
 *  stays in io/files.ts.
 *
 *  MATCHING FIRST, then minting. Importing two revisions of the same assembly
 *  must not leave two libraries of near-identical greys, and a document whose
 *  library already says what "aluminium" looks like should have the imported
 *  aluminium parts wear that material rather than a second one called "Imported
 *  grey". `nearestMaterial` has a tolerance for exactly this: close enough is
 *  the same material, and anything else is genuinely new.
 *
 *  Returns the materials to add and a colour → material id map covering every
 *  input colour it could read. A colour it could not read is absent from the map
 *  rather than assigned something, because a body wearing a material nobody
 *  chose is worse than a body left grey. */
export function materialsForColors(
  colors: readonly { color: string; name?: string | undefined }[],
  library: readonly MaterialDef[],
): { add: MaterialDef[]; byColor: Map<string, string> } {
  const add: MaterialDef[] = [];
  const byColor = new Map<string, string>();
  const taken = new Set(library.map((m) => m.id));
  const names = new Set(library.map((m) => m.name.toLowerCase()));
  // A file's colour is a colour and nothing else. Matching it to a material
  // that is SEE-THROUGH imports a claim the file never made, and the result is
  // not a slightly wrong shade, it is a part you can no longer see: the
  // reference board's pale lavender lands within tolerance of Glass, and every
  // one of its fifteen occurrences opened at a quarter opacity, which reads as
  // a broken import rather than as a material choice. Opaque candidates only;
  // an imported colour that resembles glass mints its own opaque material.
  const opaque = (m: MaterialDef) => (m.opacity ?? 1) >= 1;
  for (const entry of colors) {
    const hex = asHex(entry.color);
    if (!hex || byColor.has(hex)) continue;
    const hit = nearestMaterial(hex, [...library, ...add].filter(opaque));
    if (hit) {
      byColor.set(hex, hit.id);
      continue;
    }
    const base = (entry.name ?? "").trim() || `Imported ${colorName(hex)}`;
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    names.add(name.toLowerCase());
    const id = uniqueId(slugId(name), taken);
    taken.add(id);
    add.push({ id, name, color: hex });
    byColor.set(hex, id);
  }
  return { add, byColor };
}

/** The colour an assembly node shows, INHERITED from its nearest coloured
 *  ancestor when it has none of its own.
 *
 *  XCAF stores a colour on the label that carries one and says nothing about the
 *  labels below it, and a real assembly is coloured at the level somebody
 *  bothered to colour: a subassembly painted red holds twenty parts with no
 *  colour of their own, all of which are red. Reading the leaf alone throws away
 *  most of what the file said, so the walk goes up.
 *
 *  Cycle-safe (a hand-edited manifest can loop) and bounded by the node count. */
export function nodeColors(
  nodes: readonly { parent: number | null; color?: string | undefined }[],
): (string | undefined)[] {
  return nodes.map((_, start) => {
    const seen = new Set<number>();
    for (let i: number | null = start; i !== null && i >= 0 && i < nodes.length && !seen.has(i); i = nodes[i]!.parent) {
      seen.add(i);
      const own = asHex(nodes[i]!.color);
      if (own) return own;
    }
    return undefined;
  });
}
