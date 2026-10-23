// The light a document was saved with, when it is one the user made: an
// imported panorama or a saved environment. Built in rooms stay a preference.

export interface EmbeddedHdr {
  name: string;
  width: number;
  height: number;
  /** A flat Radiance file, zlib deflated, base64. */
  encoding: "rgbe-deflate-base64";
  sha256: string;
  data: string;
}

export interface DocEnvironment {
  /** The saved environment's name, when it came from the library. */
  name?: string;
  /** The Environment tab's look, narrowed by ui/renderPrefs asEnvSettings on use. */
  settings: Record<string, unknown>;
  hdr?: EmbeddedHdr;
}

function asEmbeddedHdr(v: unknown): EmbeddedHdr | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const n = (k: string) =>
    typeof o[k] === "number" && Number.isInteger(o[k]) && (o[k] as number) > 0 ? (o[k] as number) : null;
  const width = n("width"),
    height = n("height");
  if (o["encoding"] !== "rgbe-deflate-base64" || !width || !height) return undefined;
  if (typeof o["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(o["sha256"])) return undefined;
  if (typeof o["data"] !== "string" || !o["data"]) return undefined;
  return {
    name: typeof o["name"] === "string" ? o["name"] : "environment.hdr",
    width,
    height,
    encoding: "rgbe-deflate-base64",
    sha256: o["sha256"],
    data: o["data"],
  };
}

export function normalizeDocEnvironment(v: unknown): DocEnvironment | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s = o["settings"];
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const out: DocEnvironment = { settings: { ...(s as Record<string, unknown>) } };
  if (typeof o["name"] === "string" && o["name"].trim()) out.name = o["name"].trim();
  const hdr = asEmbeddedHdr(o["hdr"]);
  if (hdr) out.hdr = hdr;
  return out;
}

/** Equal for saving purposes: the pixels are compared by hash. */
export function sameDocEnvironment(a: DocEnvironment | null, b: DocEnvironment | null): boolean {
  const key = (e: DocEnvironment | null) =>
    e ? JSON.stringify([e.name ?? null, e.settings, e.hdr?.sha256 ?? null]) : "";
  return key(a) === key(b);
}
