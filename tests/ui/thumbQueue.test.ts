import { describe, expect, it } from "vitest";
import { ThumbQueue } from "../../src/ui/thumbQueue";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function deferredFetch() {
  const calls: { paths: string[]; resolve: (urls: (string | null)[]) => void }[] = [];
  const fetch = (paths: string[]) =>
    new Promise<(string | null)[]>((resolve) => calls.push({ paths, resolve }));
  const answer = (i: number) => calls[i]!.resolve(calls[i]!.paths.map((p) => `url:${p}`));
  return { calls, fetch, answer };
}

describe("ThumbQueue", () => {
  it("asks for at most 24 paths a call and 2 calls at a time", async () => {
    const f = deferredFetch();
    const q = new ThumbQueue(f.fetch);
    for (let i = 0; i < 100; i++) q.request(`p${i}`, 1, () => {});
    await flush();
    expect(f.calls.map((c) => c.paths.length)).toEqual([24, 24]);
    f.answer(0);
    await flush();
    expect(f.calls.length).toBe(3);
    expect(f.calls[2]!.paths[0]).toBe("p48");
  });

  it("hands each card its picture and serves a second ask from the cache", async () => {
    const f = deferredFetch();
    const q = new ThumbQueue(f.fetch);
    const got: (string | null)[] = [];
    q.request("a", 5, (u) => got.push(u));
    await flush();
    f.answer(0);
    await flush();
    expect(got).toEqual(["url:a"]);
    q.request("a", 5, (u) => got.push(u));
    expect(got).toEqual(["url:a", "url:a"]);
    expect(f.calls.length).toBe(1);
  });

  it("drops a card scrolled away before its call went out", async () => {
    const f = deferredFetch();
    const q = new ThumbQueue(f.fetch);
    const got: string[] = [];
    q.request("a", 1, () => got.push("a"));
    q.request("b", 1, () => got.push("b"));
    q.cancel("a");
    await flush();
    expect(f.calls[0]!.paths).toEqual(["b"]);
    f.answer(0);
    await flush();
    expect(got).toEqual(["b"]);
  });

  it("asks again when the file's stamp changed", async () => {
    const f = deferredFetch();
    const q = new ThumbQueue(f.fetch);
    q.request("a", 1, () => {});
    await flush();
    f.answer(0);
    await flush();
    q.request("a", 2, () => {});
    await flush();
    expect(f.calls.length).toBe(2);
  });

  it("keeps the newest pictures within its cache size", async () => {
    const f = deferredFetch();
    const q = new ThumbQueue(f.fetch, { cache: 2 });
    for (const p of ["a", "b", "c"]) q.request(p, 1, () => {});
    await flush();
    f.answer(0);
    await flush();
    q.request("c", 1, () => {});
    q.request("a", 1, () => {});
    await flush();
    expect(f.calls.length).toBe(2);
    expect(f.calls[1]!.paths).toEqual(["a"]);
  });

  it("a failed call leaves the cards without a picture and the queue working", async () => {
    let n = 0;
    const q = new ThumbQueue(async (paths) => {
      if (n++ === 0) throw new Error("gone");
      return paths.map(() => "x");
    });
    const got: (string | null)[] = [];
    q.request("a", 1, (u) => got.push(u));
    await flush();
    q.request("b", 1, (u) => got.push(u));
    await flush();
    expect(got).toEqual(["x"]);
  });
});
