import { describe, it, expect } from "vitest";
import { sphereCentreFromFace } from "../../src/features/planeMath";
import type { Vec3 } from "../../src/types";

type Mesh = { points: Vec3[]; normals: Vec3[] };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
};

// A grid over (u, v) cut into triangles, as a tessellated face arrives.
function grid(at: (u: number, v: number) => Vec3, nu: number, nv: number): Mesh {
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3) => {
    points.push(a, b, c);
    normals.push(unit(cross(sub(b, a), sub(c, a))));
  };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const [u0, u1, v0, v1] = [i / nu, (i + 1) / nu, j / nv, (j + 1) / nv];
      tri(at(u0, v0), at(u1, v0), at(u1, v1));
      tri(at(u0, v0), at(u1, v1), at(u0, v1));
    }
  }
  return { points, normals };
}

const C: Vec3 = [130, -40, 12];
const cap = (r: number, polar: number) =>
  grid((u, v) => {
    const a = u * 2 * Math.PI, p = 0.1 + v * polar;
    return [C[0] + r * Math.sin(p) * Math.cos(a), C[1] + r * Math.sin(p) * Math.sin(a), C[2] + r * Math.cos(p)];
  }, 24, 8);

describe("sphereCentreFromFace", () => {
  it("finds the centre of a spherical cap far from the origin", () => {
    const m = cap(6, 1.2);
    const c = sphereCentreFromFace(m.points, m.normals);
    expect(c).not.toBeNull();
    for (let i = 0; i < 3; i++) expect(c![i]).toBeCloseTo(C[i]!, 6);
  });

  it("does not care which way the facets face, a dimple and a ball read alike", () => {
    const m = cap(6, 1.2);
    const flipped = m.normals.map((n): Vec3 => [-n[0], -n[1], -n[2]]);
    expect(sphereCentreFromFace(m.points, flipped)).not.toBeNull();
  });

  it("is not put off by a sliver of no area, which a real mesh carries", () => {
    const m = cap(6, 1.2);
    const p = m.points[0]!;
    m.points.push(p, p, m.points[1]!);
    m.normals.push([0, 0, 0]);
    expect(sphereCentreFromFace(m.points, m.normals)).not.toBeNull();
  });

  it("refuses a flat face", () => {
    const m = grid((u, v) => [u * 10, v * 10, 3], 4, 4);
    expect(sphereCentreFromFace(m.points, m.normals)).toBeNull();
  });

  // These two meshes lie on a sphere exactly, facet normals included, so the
  // fit accepts them and only their lack of inner corners turns them down.
  it("refuses a cone whose corners sit on two rings only", () => {
    const m = grid((u, v) => {
      const a = u * 2 * Math.PI, r = 2 + 3 * v;
      return [r * Math.cos(a), r * Math.sin(a), 3 * v];
    }, 24, 1);
    expect(sphereCentreFromFace(m.points, m.normals)).toBeNull();
  });

  it("refuses a drill point, an apex and one ring", () => {
    const m = grid((u, v) => {
      const a = u * 2 * Math.PI, r = 3 * v;
      return [r * Math.cos(a), r * Math.sin(a), -2 * (1 - v)];
    }, 24, 1);
    expect(sphereCentreFromFace(m.points, m.normals)).toBeNull();
  });

  it("refuses a sphere band of one row, which is that same cone", () => {
    const m = cap(6, 0.2);
    const one = grid((u, v) => {
      const a = u * 2 * Math.PI, p = 0.5 + v * 0.2;
      return [6 * Math.sin(p) * Math.cos(a), 6 * Math.sin(p) * Math.sin(a), 6 * Math.cos(p)];
    }, 24, 1);
    expect(sphereCentreFromFace(m.points, m.normals)).not.toBeNull();
    expect(sphereCentreFromFace(one.points, one.normals)).toBeNull();
  });

  it("refuses a torus patch", () => {
    const m = grid((u, v) => {
      const a = u * 0.8, b = v * 1.5;
      const r = 20 + 2 * Math.cos(b);
      return [r * Math.cos(a), r * Math.sin(a), 2 * Math.sin(b)];
    }, 12, 8);
    expect(sphereCentreFromFace(m.points, m.normals)).toBeNull();
  });
});
