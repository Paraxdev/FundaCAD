//! A bounding-box tree over every checked body's triangles, for the short
//! rays the wall and gap checks cast. A uniform grid was the other choice, but
//! one 100 mm triangle on a flat face would land in thousands of cells.

/// A triangle the tree holds: its corners, and which body and triangle of
/// that body it is.
#[derive(Debug, Clone, Copy)]
pub struct Tri {
    pub p: [[f64; 3]; 3],
    pub body: usize,
    pub tri: usize,
}

struct Node {
    lo: [f64; 3],
    hi: [f64; 3],
    /// A leaf holds `start..start + count` of `order`; an inner node has a
    /// count of 0 and its children at `left` and `right`.
    start: usize,
    count: usize,
    left: usize,
    right: usize,
}

pub struct Bvh {
    tris: Vec<Tri>,
    order: Vec<usize>,
    nodes: Vec<Node>,
}

/// What a ray hit first: how far along it, and which triangle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub t: f64,
    pub body: usize,
    pub tri: usize,
}

const LEAF: usize = 4;

fn bounds(t: &Tri) -> ([f64; 3], [f64; 3]) {
    let mut lo = t.p[0];
    let mut hi = t.p[0];
    for p in &t.p[1..] {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    (lo, hi)
}

impl Bvh {
    pub fn new(tris: Vec<Tri>) -> Bvh {
        let mut order: Vec<usize> = (0..tris.len()).collect();
        let centres: Vec<[f64; 3]> = tris
            .iter()
            .map(|t| {
                let mut c = [0.0; 3];
                for k in 0..3 {
                    c[k] = (t.p[0][k] + t.p[1][k] + t.p[2][k]) / 3.0;
                }
                c
            })
            .collect();
        let boxes: Vec<([f64; 3], [f64; 3])> = tris.iter().map(bounds).collect();
        let mut nodes = Vec::new();
        if !tris.is_empty() {
            let n = order.len();
            build(&mut nodes, &mut order, 0, n, &centres, &boxes);
        }
        Bvh { tris, order, nodes }
    }

    pub fn tri(&self, i: usize) -> &Tri {
        &self.tris[i]
    }

    /// The nearest triangle the segment `o + t d`, `t_min <= t <= t_max`,
    /// passes through, other than `skip` (an index into the tree's list) and
    /// any of a body `keep` turns down.
    pub fn first_hit(
        &self,
        o: [f64; 3],
        d: [f64; 3],
        t_min: f64,
        t_max: f64,
        skip: usize,
        keep: impl Fn(usize) -> bool,
    ) -> Option<(Hit, usize)> {
        if self.nodes.is_empty() {
            return None;
        }
        let inv = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut best: Option<(Hit, usize)> = None;
        let mut limit = t_max;
        let mut stack = vec![0usize];
        while let Some(i) = stack.pop() {
            let node = &self.nodes[i];
            if !slab(o, inv, node.lo, node.hi, t_min, limit) {
                continue;
            }
            if node.count > 0 {
                for &k in &self.order[node.start..node.start + node.count] {
                    let t = &self.tris[k];
                    if k == skip || !keep(t.body) {
                        continue;
                    }
                    if let Some(at) = intersect(o, d, &t.p) {
                        if at >= t_min && at <= limit {
                            limit = at;
                            best = Some((Hit { t: at, body: t.body, tri: t.tri }, k));
                        }
                    }
                }
            } else {
                stack.push(node.left);
                stack.push(node.right);
            }
        }
        best
    }
}

fn build(
    nodes: &mut Vec<Node>,
    order: &mut [usize],
    start: usize,
    end: usize,
    centres: &[[f64; 3]],
    boxes: &[([f64; 3], [f64; 3])],
) -> usize {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for &k in &order[start..end] {
        for a in 0..3 {
            lo[a] = lo[a].min(boxes[k].0[a]);
            hi[a] = hi[a].max(boxes[k].1[a]);
        }
    }
    let me = nodes.len();
    nodes.push(Node { lo, hi, start, count: end - start, left: 0, right: 0 });
    if end - start <= LEAF {
        return me;
    }
    // Split at the median centre along the box's longest side.
    let mut clo = [f64::INFINITY; 3];
    let mut chi = [f64::NEG_INFINITY; 3];
    for &k in &order[start..end] {
        for a in 0..3 {
            clo[a] = clo[a].min(centres[k][a]);
            chi[a] = chi[a].max(centres[k][a]);
        }
    }
    let axis = (0..3).max_by(|&a, &b| (chi[a] - clo[a]).total_cmp(&(chi[b] - clo[b]))).unwrap_or(0);
    if chi[axis] - clo[axis] <= 0.0 {
        // Every centre in one point: no split separates them.
        return me;
    }
    let mid = (start + end) / 2;
    order[start..end].select_nth_unstable_by(mid - start, |&a, &b| centres[a][axis].total_cmp(&centres[b][axis]));
    let left = build(nodes, order, start, mid, centres, boxes);
    let right = build(nodes, order, mid, end, centres, boxes);
    nodes[me].count = 0;
    nodes[me].left = left;
    nodes[me].right = right;
    me
}

/// Whether the segment overlaps the box, with a little slack so a ray along
/// a flat face's plane still finds it.
fn slab(o: [f64; 3], inv: [f64; 3], lo: [f64; 3], hi: [f64; 3], t_min: f64, t_max: f64) -> bool {
    const PAD: f64 = 1e-7;
    let (mut a, mut b) = (t_min, t_max);
    for k in 0..3 {
        let (l, h) = (lo[k] - PAD, hi[k] + PAD);
        if inv[k].is_infinite() {
            if o[k] < l || o[k] > h {
                return false;
            }
            continue;
        }
        let (mut t0, mut t1) = ((l - o[k]) * inv[k], (h - o[k]) * inv[k]);
        if t0 > t1 {
            std::mem::swap(&mut t0, &mut t1);
        }
        a = a.max(t0);
        b = b.min(t1);
        if a > b {
            return false;
        }
    }
    true
}

/// Möller and Trumbore: how far along `o + t d` the ray meets the triangle, if
/// it does. Either side of the triangle counts.
pub fn intersect(o: [f64; 3], d: [f64; 3], p: &[[f64; 3]; 3]) -> Option<f64> {
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let e1 = sub(p[1], p[0]);
    let e2 = sub(p[2], p[0]);
    let h = cross(d, e2);
    let a = dot(e1, h);
    let scale = dot(e1, e1).sqrt() * dot(e2, e2).sqrt() * dot(d, d).sqrt();
    if a.abs() <= 1e-12 * scale.max(1e-300) {
        return None;
    }
    let f = 1.0 / a;
    let s = sub(o, p[0]);
    let u = f * dot(s, h);
    const EDGE: f64 = 1e-9;
    if !(-EDGE..=1.0 + EDGE).contains(&u) {
        return None;
    }
    let q = cross(s, e1);
    let v = f * dot(d, q);
    if v < -EDGE || u + v > 1.0 + EDGE {
        return None;
    }
    Some(f * dot(e2, q))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small deterministic generator, so the test needs no crate.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
        fn point(&mut self, size: f64) -> [f64; 3] {
            [self.next() * size, self.next() * size, self.next() * size]
        }
    }

    #[test]
    fn the_tree_finds_what_trying_every_triangle_finds() {
        let mut r = Lcg(7);
        let tris: Vec<Tri> = (0..400)
            .map(|i| {
                let c = r.point(20.0);
                let p = [c, [c[0] + r.next() * 3.0, c[1] + r.next(), c[2]], [c[0], c[1] + r.next() * 3.0, c[2] + r.next() * 2.0]];
                Tri { p, body: i % 3, tri: i }
            })
            .collect();
        let bvh = Bvh::new(tris.clone());
        for _ in 0..1000 {
            let o = r.point(20.0);
            let mut d = [r.next() - 0.5, r.next() - 0.5, r.next() - 0.5];
            let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            for x in &mut d {
                *x /= l;
            }
            let brute = tris
                .iter()
                .enumerate()
                .filter_map(|(k, t)| intersect(o, d, &t.p).filter(|&s| (0.0..=5.0).contains(&s)).map(|s| (s, k)))
                .min_by(|a, b| a.0.total_cmp(&b.0));
            let got = bvh.first_hit(o, d, 0.0, 5.0, usize::MAX, |_| true).map(|(h, k)| (h.t, k));
            assert_eq!(got, brute);
        }
    }
}
