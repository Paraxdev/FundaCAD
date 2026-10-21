import { describe, expect, it } from "vitest";
import { blake2b128Hex } from "../../src/document/blake2b";

// Vectors from Python's hashlib.blake2b(data, digest_size=16), the hash the
// engine's blob store names a blob by (crates/fundacad-format json_doc.rs).
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const text = (s: string) => new TextEncoder().encode(s);
const PNG = import.meta.glob("../fixtures/refimg/ref400x200.png", { query: "?inline", import: "default", eager: true }) as Record<string, string>;

describe("blake2b128Hex", () => {
  it("matches the engine's hash", () => {
    expect(blake2b128Hex(new Uint8Array())).toBe("cae66941d9efbd404e4d88758ea67670");
    expect(blake2b128Hex(text("fundacad"))).toBe("5648909c8c0ccf6096c0e672255e68a0");
  });

  it("is right on both sides of the 128 byte block boundary", () => {
    expect(blake2b128Hex(bytes(128))).toBe("a74787004ef589e31149183900d0294a");
    expect(blake2b128Hex(bytes(129))).toBe("aaf1b0371f6d4ee49ee4fb5ddd9c49ef");
    expect(blake2b128Hex(bytes(1000))).toBe("bca120dfd89cd95d82898473a5b01c90");
  });

  it("names the reference image fixture the way the blob store does", () => {
    const url = Object.values(PNG)[0]!;
    const png = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    expect(png.length).toBe(109905);
    expect(blake2b128Hex(png)).toBe("429c5bc1257ce3bdfc611423f2302bd2");
  });
});
