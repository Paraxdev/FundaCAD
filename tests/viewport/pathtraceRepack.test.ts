import { describe, expect, it } from "vitest";
import { repackInPlace, type SwappableBvhData } from "../../src/viewport/pathtrace/bvhSwap";

class Buf {
  disposed = false;
  constructor(readonly tag: string) {}
  dispose() {
    this.disposed = true;
  }
}

/** Like BVHComputeData's NodeProxyObject: a member reads back as a proxy that
 *  resolves to whatever node is assigned now, an assignment stores the node. */
function proxied(init: Record<string, unknown>) {
  return new Proxy(
    { ...init },
    {
      get: (t, k: string) => ({
        get proxyNode() {
          return t[k] ?? null;
        },
      }),
      set: (t, k: string, v) => {
        t[k] = v;
        return true;
      },
    },
  ) as Record<string, unknown>;
}

const rawOf = (p: unknown) => (p as { proxyNode: { value: Buf } }).proxyNode;

/** update() makes new storage nodes and a new struct, and disposes the old
 *  buffers itself, as PathtracerBVHComputeData does. */
function fakeData(withUv = false): SwappableBvhData {
  let round = 0;
  const node = (tag: string) => ({ value: new Buf(tag) });
  return {
    storage: proxied({ nodes: node("nodes0"), attributes: node("attributes0"), materials: node("materials0") }),
    structs: proxied({ attributes: { s: 0 } }),
    attributes: { position: "vec4f", normal: "vec4f", color: "vec4f" },
    update() {
      round++;
      this.dispose();
      for (const k of Object.keys(this.storage)) this.storage[k] = node(`${k}${round}`);
      this.structs.attributes = { s: round };
      if (withUv) this.attributes.uv = "vec4f";
    },
    dispose() {
      for (const k of Object.keys(this.storage)) rawOf(this.storage[k]).value.dispose();
    },
  };
}

describe("in place repack", () => {
  it("moves the new buffers into the nodes the kernels were compiled with", () => {
    const d = fakeData();
    const keys = Object.keys(d.storage);
    const nodes = keys.map((k) => rawOf(d.storage[k]));
    const old = nodes.map((n) => n.value);
    const struct = (d.structs.attributes as { proxyNode: object }).proxyNode;
    expect(repackInPlace(d)).toBe(true);
    keys.forEach((k, i) => {
      expect(rawOf(d.storage[k])).toBe(nodes[i]);
      expect(nodes[i]!.value.tag).toBe(`${k}1`);
      expect(nodes[i]!.value.disposed).toBe(false);
    });
    expect((d.structs.attributes as { proxyNode: object }).proxyNode).toBe(struct);
    expect(old.every((b) => b.disposed)).toBe(true);
  });

  it("reports a changed attribute layout so the caller sets the scene in full", () => {
    const d = fakeData(true);
    const old = Object.keys(d.storage).map((k) => rawOf(d.storage[k]).value);
    expect(repackInPlace(d)).toBe(false);
    expect(old.every((b) => b.disposed)).toBe(true);
    expect(rawOf(d.storage.nodes).value.tag).toBe("nodes1");
  });
});
