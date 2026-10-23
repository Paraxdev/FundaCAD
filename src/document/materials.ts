// Materials are appearance only (colour and finish): no mass, no geometry, so deleting them all rebuilds identically.
// Unlike the four slot filament `palette`, a manufacturing choice that wins on screen, they have no cap and no machine.

// Procedural pattern computed in the shader (viewport/proceduralSurface.ts), triplanar so it needs no UVs.
export interface SurfaceSpec {
  kind: "noise" | "scratches" | "brushed" | "voronoi" | "wave";
  scale: number; // feature size in mm
  amount: number; // 0..1, roughness push
  angle?: number; // radians, scratch/brushed/wave direction
  bump?: number; // 0..1, relief
  color?: string; // "#rrggbb" tint
  colorAmount?: number; // 0..1
}

// A surface graph node (see viewport/proceduralSurface.ts). Generators read world space and give a float, `fresnel`
// rises at grazing angles, `ramp`/`colorramp` map a float to colour, `mix`/`math` combine floats, `output` is the sink.
// Params are baked into the shader (numbers, "#rrggbb", a colorramp's "pos:hex;..." stops); `in` wires port to node id.
export interface SurfaceNode {
  id: string;
  type:
    | "noise"
    | "scratches"
    | "brushed"
    | "voronoi"
    | "wave"
    | "fresnel"
    | "ramp"
    | "colorramp"
    | "mix"
    | "math"
    | "output";
  params?: Record<string, number | string>;
  in?: Record<string, string>;
  // Layout only, ignored by the compiler and graphKey, so dragging a node never recompiles the shader.
  x?: number;
  y?: number;
}

export interface SurfaceGraph {
  nodes: SurfaceNode[];
  // Id of the output node.
  output: string;
}

// Everything but id, name and color is optional, absent meaning the default FINISH, so a plain colour is three fields.
export interface MaterialDef {
  id: string;
  name: string;
  // "#rrggbb", lower case.
  color: string;
  // 0..1, 0 is a dielectric (plastic, paint), 1 is bare metal.
  metalness?: number;
  // 0..1, 0 is a mirror, 1 is chalk.
  roughness?: number;
  // 0..1, omitted at the default 1 (opaque).
  opacity?: number;
  // 0..1, self lit in the material's own colour: a second emissive colour would be one more thing to keep in step.
  emissive?: number;
  // 0..1 glossy dielectric coat over the base, like car paint. Physical PBR only, dropped on the lightweight render.
  clearcoat?: number;
  // Index of refraction of a see-through finish, 1 (air) to 2.5: water 1.33, glass 1.5, diamond 2.42.
  ior?: number;
  // mm light travels through a see-through finish. Absent is auto, measured from the body per pixel.
  thickness?: number;
  // "#rrggbb" light turns into as it travels through. Absent is clear.
  attenuationColor?: string;
  // mm until light fully takes on attenuationColor. 0 or absent means never.
  attenuationDistance?: number;
  // 0..10, the fire of a cut diamond. Needs some thickness to be seen.
  dispersion?: number;
  // 0..1 thin film rainbow, on any finish.
  iridescence?: number;
  // "#rrggbb" tint of a non-metal's highlight. Absent is white.
  specularColor?: string;
  // 0..1 soft rim at grazing angles, velvet.
  sheen?: number;
  // 0..1 highlights stretched along one direction, like print layer lines or brushed grain.
  anisotropy?: number;
  // 0..1 glitter or metal flake density.
  flakes?: number;
  // mm per flake.
  flakeSize?: number;
  // mm until light inside a see-through finish has scattered. 0 is clear.
  scatterDistance?: number;
  // False when a glowing part should not light its neighbours. Only written when false.
  castsLight?: boolean;
  // The single generator form the picker writes.
  surface?: SurfaceSpec;
  // The node editor's full graph, preferred over `surface`.
  surfaceGraph?: SurfaceGraph;
}

// The finish bodies have always been drawn with (viewport/render.ts), so "no material" and a finish-less material
// draw the same picture.
export const FINISH = {
  metalness: 0.1,
  roughness: 0.55,
  opacity: 1,
  emissive: 0,
  clearcoat: 0,
  ior: 1.5,
  thickness: "auto",
  attenuationDistance: 0,
  dispersion: 0,
  iridescence: 0,
  sheen: 0,
  anisotropy: 0,
  flakes: 0,
  flakeSize: 0.1,
  scatterDistance: 0,
  castsLight: true,
} as const;

// Never undefined, so the render path has no branches.
export interface BodyFinish {
  metalness: number;
  roughness: number;
  opacity: number;
  emissive: number;
  clearcoat: number;
  ior: number;
  thickness: number | "auto";
  attenuationDistance: number;
  dispersion: number;
  iridescence: number;
  sheen: number;
  anisotropy: number;
  flakes: number;
  flakeSize: number;
  scatterDistance: number;
  castsLight: boolean;
  attenuationColor?: string;
  specularColor?: string;
  surface?: SurfaceSpec;
  surfaceGraph?: SurfaceGraph;
}

// A node graph counts as shiny because it can drive emission.
export function isShiny(f: BodyFinish): boolean {
  return (
    f.emissive > 0 ||
    f.metalness >= 0.5 ||
    f.roughness < 0.3 ||
    f.clearcoat > 0 ||
    f.iridescence > 0 ||
    f.opacity < 1 ||
    f.anisotropy > 0 ||
    f.flakes > 0 ||
    !!f.surfaceGraph
  );
}

// Every field must be compared: one left out would be a material whose only change never reaches the screen.
export function isDefaultFinish(f: BodyFinish): boolean {
  return (
    f.metalness === FINISH.metalness &&
    f.roughness === FINISH.roughness &&
    f.opacity === FINISH.opacity &&
    f.emissive === FINISH.emissive &&
    f.clearcoat === FINISH.clearcoat &&
    f.ior === FINISH.ior &&
    f.thickness === FINISH.thickness &&
    f.attenuationDistance === FINISH.attenuationDistance &&
    f.dispersion === FINISH.dispersion &&
    f.iridescence === FINISH.iridescence &&
    f.sheen === FINISH.sheen &&
    f.anisotropy === FINISH.anisotropy &&
    f.flakes === FINISH.flakes &&
    f.flakeSize === FINISH.flakeSize &&
    f.scatterDistance === FINISH.scatterDistance &&
    f.castsLight === FINISH.castsLight &&
    !f.attenuationColor &&
    !f.specularColor &&
    !f.surface &&
    !f.surfaceGraph
  );
}

export function finishOf(m: MaterialDef | undefined): BodyFinish {
  return {
    metalness: m?.metalness ?? FINISH.metalness,
    roughness: m?.roughness ?? FINISH.roughness,
    opacity: m?.opacity ?? FINISH.opacity,
    emissive: m?.emissive ?? FINISH.emissive,
    clearcoat: m?.clearcoat ?? FINISH.clearcoat,
    ior: m?.ior ?? FINISH.ior,
    thickness: m?.thickness ?? FINISH.thickness,
    attenuationDistance: m?.attenuationDistance ?? FINISH.attenuationDistance,
    dispersion: m?.dispersion ?? FINISH.dispersion,
    iridescence: m?.iridescence ?? FINISH.iridescence,
    sheen: m?.sheen ?? FINISH.sheen,
    anisotropy: m?.anisotropy ?? FINISH.anisotropy,
    flakes: m?.flakes ?? FINISH.flakes,
    flakeSize: m?.flakeSize ?? FINISH.flakeSize,
    scatterDistance: m?.scatterDistance ?? FINISH.scatterDistance,
    castsLight: m?.castsLight ?? FINISH.castsLight,
    ...(m?.attenuationColor ? { attenuationColor: m.attenuationColor } : {}),
    ...(m?.specularColor ? { specularColor: m.specularColor } : {}),
    ...(m?.surface ? { surface: m.surface } : {}),
    ...(m?.surfaceGraph ? { surfaceGraph: m.surfaceGraph } : {}),
  };
}

// "Glossy, metallic": surface then kind, for search and screen readers. Kinds are ranked, not combined: a light is a
// light, and see-through comes before anything else.
export function finishLabel(m: MaterialDef | undefined): string {
  const f = finishOf(m);
  const gloss = f.roughness <= 0.18 ? "Glossy" : f.roughness <= 0.45 ? "Satin" : "Matte";
  const kind =
    f.emissive > 0
      ? "lit"
      : f.opacity < 1
        ? "transparent"
        : f.metalness >= 0.5
          ? "metallic"
          : f.flakes > 0
            ? "glitter"
            : f.anisotropy >= 0.3
              ? "brushed"
              : f.sheen >= 0.3
                ? "velvet"
                : "";
  return kind ? `${gloss}, ${kind}` : gloss;
}

// Generic materials named for the stuff, not a supplier's product, and deliberately short: examples of the fields.
// Every entry is already in normal form (materials.test.ts holds it): a default-valued field is dropped on read, which
// would break export round trips and the store's untouched library check that keeps plain documents free of materials.
export const STARTER_LIBRARY: readonly MaterialDef[] = Object.freeze([
  { id: "m-aluminium", name: "Aluminium", color: "#b8bcc0", metalness: 0.9, roughness: 0.35 },
  { id: "m-steel", name: "Steel", color: "#8f959b", metalness: 0.95, roughness: 0.28 },
  { id: "m-brass", name: "Brass", color: "#c9a227", metalness: 0.9, roughness: 0.3 },
  { id: "m-copper", name: "Copper", color: "#b06a3b", metalness: 0.95, roughness: 0.25 },
  { id: "m-gold", name: "Gold", color: "#d4af37", metalness: 1, roughness: 0.22 },
  { id: "m-chrome", name: "Chrome", color: "#e8ecf0", metalness: 1, roughness: 0.03 },
  { id: "m-titanium", name: "Titanium", color: "#9a9ea3", metalness: 0.9, roughness: 0.42 },
  // Clearcoat pair: both keep their base roughness and gain the coat's bright sheen.
  { id: "m-carpaint", name: "Car paint, red", color: "#a51321", metalness: 0.55, roughness: 0.38, clearcoat: 1 },
  { id: "m-ceramic", name: "Ceramic, glazed", color: "#eceae4", metalness: 0.0, roughness: 0.32, clearcoat: 1 },
  { id: "m-plastic-white", name: "Plastic, white", color: "#e8e8e8", metalness: 0.02, roughness: 0.6 },
  { id: "m-plastic-black", name: "Plastic, black", color: "#232323", metalness: 0.02, roughness: 0.5 },
  { id: "m-rubber", name: "Rubber", color: "#1d1f22", metalness: 0.0, roughness: 0.95 },
  { id: "m-wood", name: "Wood", color: "#9a6b3f", metalness: 0.0, roughness: 0.8 },
  { id: "m-glass", name: "Glass", color: "#cfe4ee", metalness: 0.0, roughness: 0.05, opacity: 0.25 },
  // Glass family: thickness is left auto, the body says how deep light travels.
  { id: "m-glass-frosted", name: "Glass, frosted", color: "#e6eef2", metalness: 0.0, roughness: 0.5, opacity: 0.3 },
  {
    id: "m-glass-tinted",
    name: "Glass, tinted",
    color: "#d8efe6",
    metalness: 0.0,
    roughness: 0.05,
    opacity: 0.2,
    attenuationColor: "#2a8f6a",
    attenuationDistance: 20,
  },
  {
    id: "m-diamond",
    name: "Diamond",
    color: "#f4f8fb",
    metalness: 0.0,
    roughness: 0,
    opacity: 0.1,
    ior: 2.42,
    dispersion: 5,
  },
  { id: "m-acrylic", name: "Acrylic, clear", color: "#dfeaf0", metalness: 0.0, roughness: 0.15, opacity: 0.45 },
  // A lit indicator, so the emissive slider has a visible example.
  { id: "m-emitter", name: "Indicator, lit", color: "#42e07a", metalness: 0.0, roughness: 0.4, emissive: 0.8 },
]);

const HEX = /^#?[0-9a-f]{6}$/i;

// Three digit hex is expanded, since that is what people type into a library file by hand.
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

const clampRange = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
const clamp01 = (v: unknown): number | undefined => clampRange(v, 0, 1);

// Null without a usable colour: such a row assigns but changes nothing. Everything else is repaired (clamped, name
// from id, id from name), so a bad field loses that field and not the material.
export function normalizeMaterial(raw: unknown, index = 0): MaterialDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const color = asHex(r["color"] ?? r["colour"] ?? r["hex"]);
  if (!color) return null;
  const name = typeof r["name"] === "string" && r["name"].trim() ? r["name"].trim() : "";
  const id = typeof r["id"] === "string" && r["id"].trim() ? r["id"].trim() : slugId(name || `material ${index + 1}`);
  const out: MaterialDef = { id, name: name || id, color };
  // Omit-when-default, so a library written by this app reads back byte-identically.
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
  const ior = clampRange(r["ior"], 1, 2.5);
  const thickness = clampRange(r["thickness"], 0, 200);
  const attenuationDistance = clampRange(r["attenuationDistance"], 0, 1000);
  const dispersion = clampRange(r["dispersion"], 0, 10);
  const iridescence = clamp01(r["iridescence"]);
  if (ior !== undefined && ior !== FINISH.ior) out.ior = ior;
  // Kept whatever its value, a stored number is an override and absent is auto.
  if (thickness !== undefined) out.thickness = thickness;
  const attenuationColor = asHex(r["attenuationColor"]);
  if (attenuationColor) out.attenuationColor = attenuationColor;
  if (attenuationDistance !== undefined && attenuationDistance !== FINISH.attenuationDistance) {
    out.attenuationDistance = attenuationDistance;
  }
  if (dispersion !== undefined && dispersion !== FINISH.dispersion) out.dispersion = dispersion;
  if (iridescence !== undefined && iridescence !== FINISH.iridescence) out.iridescence = iridescence;
  const specularColor = asHex(r["specularColor"]);
  if (specularColor) out.specularColor = specularColor;
  const fields = {
    sheen: clamp01(r["sheen"]),
    anisotropy: clamp01(r["anisotropy"]),
    flakes: clamp01(r["flakes"]),
    flakeSize: clampRange(r["flakeSize"], 0.01, 5),
    scatterDistance: clampRange(r["scatterDistance"], 0, 100),
  };
  for (const [key, v] of Object.entries(fields) as [keyof typeof fields, number | undefined][]) {
    if (v !== undefined && v !== FINISH[key]) out[key] = v;
  }
  if (r["castsLight"] === false) out.castsLight = false;
  const surface = normalizeSurface(r["surface"]);
  if (surface) out.surface = surface;
  const graph = normalizeGraph(r["surfaceGraph"]);
  if (graph) out.surfaceGraph = graph;
  // A later build's fields ride through, like the Rust schema's flattened extra, so a save does not strip them.
  const carried = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (KNOWN_MATERIAL_KEYS.has(key) || key === "__proto__") continue;
    carried[key] = structuredClone(r[key]);
  }
  return out;
}

const KNOWN_MATERIAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "color",
  "colour",
  "hex",
  "metalness",
  "roughness",
  "opacity",
  "emissive",
  "clearcoat",
  "ior",
  "thickness",
  "attenuationColor",
  "attenuationDistance",
  "dispersion",
  "iridescence",
  "specularColor",
  "surface",
  "surfaceGraph",
  "sheen",
  "anisotropy",
  "flakes",
  "flakeSize",
  "scatterDistance",
  "castsLight",
]);

const NODE_TYPES: readonly SurfaceNode["type"][] = [
  "noise",
  "scratches",
  "brushed",
  "voronoi",
  "wave",
  "fresnel",
  "ramp",
  "colorramp",
  "mix",
  "math",
  "output",
];

// Structural only: the compiler defaults a missing wire or param, so a partial but shaped graph is kept.
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
    if (typeof o["x"] === "number") node.x = o["x"];
    if (typeof o["y"] === "number") node.y = o["y"];
    nodes.push(node);
  }
  if (!nodes.some((n) => n.id === r["output"])) return undefined;
  return { nodes, output: r["output"] };
}

const SURFACE_KINDS: readonly SurfaceSpec["kind"][] = ["noise", "scratches", "brushed", "voronoi", "wave"];

// A bad kind or non-positive scale drops the surface, so the material reads back plain rather than as a broken shader.
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

// Safe in a file name, a URL and a JSON key.
export function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `m-${slug || "material"}`;
}

export function uniqueId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const next = `${id}-${n}`;
    if (!taken.has(next)) return next;
  }
}

export function freshMaterialName(materials: readonly MaterialDef[], base = "Material"): string {
  const taken = new Set(materials.map((m) => m.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// `version` lets a later shape be told apart without guessing from the fields.
export interface MaterialLibraryFile {
  version: 1;
  materials: MaterialDef[];
}

// Never throws: a broken file gives the readable materials plus a sentence. A bare `[…]` is accepted too, as a
// spreadsheet export or hand-written file would be.
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
    return { materials: [], problem: 'no materials in it, expected a list or {"materials": [...]}' };
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

export function serializeLibrary(materials: readonly MaterialDef[]): string {
  const file: MaterialLibraryFile = { version: 1, materials: materials.map((m) => ({ ...m })) };
  return JSON.stringify(file, null, 2);
}

function rgb(hex: string): [number, number, number] | null {
  const h = asHex(hex);
  if (!h) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

// Unlike the palette's nearest slot, a library match has a tolerance: an unlike import colour is a new material.
// Squared RGB, 24 per channel by default, is enough for the round numbers CAD files write.
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

// Rough names for minted materials: STEP colours have no names, and "Imported #b06a3b" rows are unreadable.
// A file's own material name (3MF, glTF) is preferred wherever it exists.
const BASIC_COLORS: readonly [string, number][] = [
  ["black", 0x1a1a1a],
  ["white", 0xf0f0f0],
  ["grey", 0x808080],
  ["red", 0xd23b30],
  ["orange", 0xe07a1f],
  ["yellow", 0xe0c020],
  ["green", 0x3aa04a],
  ["cyan", 0x30b0b8],
  ["blue", 0x3050c8],
  ["purple", 0x7a3fb0],
  ["pink", 0xd88098],
  ["brown", 0x8a5a30],
];

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

// Matches before minting, so two revisions of one assembly do not leave two libraries of near-identical greys. IO lives
// in io/files.ts. An unreadable colour is absent from the map: a material nobody chose is worse than grey.
export function materialsForColors(
  colors: readonly { color: string; name?: string | undefined }[],
  library: readonly MaterialDef[],
): { add: MaterialDef[]; byColor: Map<string, string> } {
  const add: MaterialDef[] = [];
  const byColor = new Map<string, string>();
  const taken = new Set(library.map((m) => m.id));
  const names = new Set(library.map((m) => m.name.toLowerCase()));
  // Opaque candidates only: the reference board's lavender matched Glass and opened at quarter opacity, like a broken
  // import. A colour that resembles glass mints its own opaque material.
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

// XCAF colours only the label someone coloured, so a red subassembly's twenty parts inherit by walking up.
// Cycle safe for hand-edited manifests and bounded by the node count.
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
