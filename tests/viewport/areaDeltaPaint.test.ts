// A box frame paints by the delta from the last one, so its colours, overlays, wide lines and selection order must
// end where a clear and select of the same take would.
import { describe, expect, it } from "vitest";
import { Highlighter } from "../../src/viewport/highlight";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import { bodiesRig, painted, seeded, settle } from "./boxDeltaRig";

const take = (faces: Iterable<number>, edges: Iterable<EdgeRef>, bodies: Iterable<string> = []) => ({
  faces: new Set(faces),
  edges: new Set(edges),
  bodies: new Set(bodies),
});

function clearAndSelect(h: Highlighter, want: ReturnType<typeof take>) {
  h.clearSelection();
  h.clearBodySelection();
  for (const f of want.faces) h.selectFace(f);
  for (const e of want.edges) h.selectEdge(e);
  for (const b of want.bodies) h.selectBody(b);
}

describe("box delta end state", () => {
  it("lists the selection in the take's order whatever path the drag took", () => {
    const { view, refs } = bodiesRig(3, 12);
    const h = new Highlighter(view);
    h.setSelection(take([], [], ["b2"]));
    h.setSelection(take([], [], ["b0", "b2"]));
    expect(h.getSelectedBodies()).toEqual(["b0", "b2"]);
    h.setSelection(take([20, 30], [refs[20]!]));
    h.setSelection(take([3, 20, 30], [refs[3]!, refs[20]!]));
    expect(h.getSelectedFaces()).toEqual([3, 20, 30]);
    expect(h.getSelectedEdges()).toEqual([refs[3], refs[20]]);
    h.dispose();
  });

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const hover of [false, true]) {
      it(`equals a clear and select build over a random drag, seed ${seed}${hover ? " with hover" : ""}`, async () => {
        const a = bodiesRig(3, 12);
        const b = bodiesRig(3, 12);
        const ha = new Highlighter(a.view);
        const hb = new Highlighter(b.view);
        if (seed % 2 === 0) {
          ha.setErrorEdges([a.refs[2]!, a.refs[15]!]);
          hb.setErrorEdges([b.refs[2]!, b.refs[15]!]);
        }
        const rnd = seeded(seed);
        for (let step = 0; step < 25; step++) {
          const p = rnd() * 0.5;
          const faces: number[] = [];
          const edges: number[] = [];
          const bodies: string[] = [];
          if (rnd() < 0.15) {
            for (let i = 0; i < 3; i++) if (rnd() < 0.5) bodies.push(`b${i}`);
          } else {
            for (let f = 0; f < 36; f++) if (rnd() < p) faces.push(f);
            a.refs.forEach((_, i) => rnd() < p && edges.push(i));
          }
          if (hover && rnd() < 0.5) {
            const at = Math.floor(rnd() * a.refs.length);
            const run = [Math.floor(rnd() * 36)];
            ha.hoverEdge(a.refs[at]!);
            hb.hoverEdge(b.refs[at]!);
            ha.hoverFaceRun(run);
            hb.hoverFaceRun(run);
          }
          ha.setSelection(
            take(
              faces,
              edges.map((i) => a.refs[i]!),
              bodies,
            ),
          );
          clearAndSelect(
            hb,
            take(
              faces,
              edges.map((i) => b.refs[i]!),
              bodies,
            ),
          );
          await settle();
          expect(painted(ha, a), `step ${step}`).toEqual(painted(hb, b));
        }
        ha.dispose();
        hb.dispose();
      });
    }
  }

  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
    it(`equals a fresh build after clicks, error edges, hovers and boxes mixed, seed ${seed}`, async () => {
      const a = bodiesRig(3, 12);
      const ha = new Highlighter(a.view);
      const rnd = seeded(seed);
      let errors: number[] = [];
      let hovered = -1;
      for (let step = 0; step < 40; step++) {
        const op = Math.floor(rnd() * 9);
        if (op === 0) ha.toggleSelectFace(Math.floor(rnd() * 36));
        else if (op === 1) ha.toggleSelectEdge(a.refs[Math.floor(rnd() * a.refs.length)]!);
        else if (op === 2) {
          errors = [Math.floor(rnd() * a.refs.length), Math.floor(rnd() * a.refs.length)];
          ha.setErrorEdges(errors.map((i) => a.refs[i]!));
        } else if (op === 3) {
          hovered = Math.floor(rnd() * a.refs.length);
          ha.hoverEdge(a.refs[hovered]!);
        } else if (op === 4) ha.clearSelection();
        else if (op === 5) {
          ha.hoverEdge(null);
          hovered = -1;
        } else {
          const p = rnd() * 0.5;
          const faces: number[] = [];
          for (let f = 0; f < 36; f++) if (rnd() < p) faces.push(f);
          ha.setSelection(
            take(
              faces,
              a.refs.filter(() => rnd() < p),
            ),
          );
        }
        await settle();
        const b = bodiesRig(3, 12);
        const hb = new Highlighter(b.view);
        if (errors.length) hb.setErrorEdges(errors.map((i) => b.refs[i]!));
        if (hovered >= 0) hb.hoverEdge(b.refs[hovered]!);
        for (const f of ha.getSelectedFaces()) hb.selectFace(f);
        for (const e of ha.getSelectedEdges()) hb.selectEdge(b.refs[a.refs.indexOf(e)]!);
        await settle();
        expect(painted(ha, a), `step ${step}`).toEqual(painted(hb, b));
        hb.dispose();
      }
      ha.dispose();
    });
  }

  it("keeps the overlay mesh and wide line of a body whose take did not change", async () => {
    const { view, draws } = bodiesRig(3, 12);
    const h = new Highlighter(view);
    const own = h as unknown as {
      overlays: { select: { meshes: { userData: { body: string } }[] } | null };
      selectLines: Map<unknown, unknown>;
    };
    const meshOf = (body: string) => own.overlays.select?.meshes.find((m) => m.userData.body === body);
    h.setSelection(take([0, 1, 12, 13], [draws[0]!.refs[0]!, draws[1]!.refs[0]!]));
    await settle();
    const before = {
      b0: meshOf("b0"),
      b1: meshOf("b1"),
      line0: own.selectLines.get(draws[0]),
      line1: own.selectLines.get(draws[1]),
    };
    h.setSelection(take([0, 1, 12, 13, 14], [draws[0]!.refs[0]!, draws[1]!.refs[0]!, draws[1]!.refs[1]!]));
    await settle();
    expect(before.b0).toBeDefined();
    expect(meshOf("b0")).toBe(before.b0);
    expect(meshOf("b1")).not.toBe(before.b1);
    expect(own.selectLines.get(draws[0])).toBe(before.line0);
    expect(own.selectLines.get(draws[1])).not.toBe(before.line1);
    h.dispose();
  });
});
