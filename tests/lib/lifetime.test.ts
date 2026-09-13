import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LruCache } from "../../src/lib/lruCache";
import { Disposer, disposeObject3D } from "../../src/lib/disposer";

describe("LruCache", () => {
  it("forgets the least recently used entry past its size", () => {
    const c = new LruCache<string, number>(2);
    c.set("a", 1).set("b", 2);
    expect(c.get("a")).toBe(1);
    c.set("c", 3);
    expect(c.has("b")).toBe(false);
    expect(c.get("a")).toBe(1);
    expect(c.size).toBe(2);
  });
});

describe("Disposer", () => {
  it("releases in reverse order, once, and releases late additions at once", () => {
    const d = new Disposer();
    const order: string[] = [];
    d.add(() => order.push("first"));
    const early = d.add(() => order.push("second"));
    early();
    d.add(() => order.push("third"));
    d.dispose();
    d.dispose();
    expect(order).toEqual(["second", "third", "first"]);
    d.add(() => order.push("late"));
    expect(order.at(-1)).toBe("late");
  });

  it("removes the listeners it added", () => {
    const d = new Disposer();
    const target = new EventTarget();
    let hits = 0;
    d.listen(target, "ping", () => hits++, true);
    target.dispatchEvent(new Event("ping"));
    d.dispose();
    target.dispatchEvent(new Event("ping"));
    expect(hits).toBe(1);
  });

  it("frees nested geometry and keeps shared materials unless told otherwise", () => {
    const shared = new THREE.MeshBasicMaterial();
    const group = new THREE.Group();
    const inner = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    inner.add(mesh);
    group.add(inner);
    const parent = new THREE.Group();
    parent.add(group);
    let geometryFreed = false;
    let materialFreed = false;
    mesh.geometry.addEventListener("dispose", () => { geometryFreed = true; });
    shared.addEventListener("dispose", () => { materialFreed = true; });
    disposeObject3D(group);
    expect(parent.children).toHaveLength(0);
    expect(geometryFreed).toBe(true);
    expect(materialFreed).toBe(false);
  });
});
