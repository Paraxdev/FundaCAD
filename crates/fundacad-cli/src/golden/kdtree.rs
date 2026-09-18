//! A static 3D k-d tree with exact nearest, k nearest and ball queries, what
//! diff_meshes.py asks scipy's cKDTree.

pub struct KdTree {
    pts: Vec<[f64; 3]>,
    /// Point indices, arranged so each node's median sits in the middle of its range.
    order: Vec<usize>,
}

impl KdTree {
    pub fn new(pts: &[[f64; 3]]) -> KdTree {
        let mut order: Vec<usize> = (0..pts.len()).collect();
        build(pts, &mut order, 0);
        KdTree {
            pts: pts.to_vec(),
            order,
        }
    }

    /// (distance, index) of the nearest point.
    pub fn nearest(&self, q: [f64; 3]) -> (f64, usize) {
        let mut best = (f64::INFINITY, usize::MAX);
        self.nearest_in(0, self.order.len(), 0, q, &mut best);
        (best.0.sqrt(), best.1)
    }

    fn nearest_in(&self, lo: usize, hi: usize, axis: usize, q: [f64; 3], best: &mut (f64, usize)) {
        if lo >= hi {
            return;
        }
        let mid = (lo + hi) / 2;
        let idx = self.order[mid];
        let p = self.pts[idx];
        let d = dist2(p, q);
        if d < best.0 || (d == best.0 && idx < best.1) {
            *best = (d, idx);
        }
        let delta = q[axis] - p[axis];
        let (near, far) = if delta < 0.0 {
            ((lo, mid), (mid + 1, hi))
        } else {
            ((mid + 1, hi), (lo, mid))
        };
        let next = (axis + 1) % 3;
        self.nearest_in(near.0, near.1, next, q, best);
        if delta * delta <= best.0 {
            self.nearest_in(far.0, far.1, next, q, best);
        }
    }

    /// The indices of the k nearest points, nearest first.
    pub fn knn(&self, q: [f64; 3], k: usize) -> Vec<usize> {
        let mut heap: Vec<(f64, usize)> = Vec::with_capacity(k + 1);
        self.knn_in(0, self.order.len(), 0, q, k, &mut heap);
        heap.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        heap.into_iter().map(|(_, i)| i).collect()
    }

    fn knn_in(
        &self,
        lo: usize,
        hi: usize,
        axis: usize,
        q: [f64; 3],
        k: usize,
        heap: &mut Vec<(f64, usize)>,
    ) {
        if lo >= hi {
            return;
        }
        let mid = (lo + hi) / 2;
        let idx = self.order[mid];
        let p = self.pts[idx];
        let d = dist2(p, q);
        let worst = |h: &Vec<(f64, usize)>| {
            if h.len() < k {
                f64::INFINITY
            } else {
                h.iter().map(|e| e.0).fold(f64::NEG_INFINITY, f64::max)
            }
        };
        if heap.len() < k {
            heap.push((d, idx));
        } else if d < worst(heap) {
            let at = heap
                .iter()
                .enumerate()
                .max_by(|a, b| {
                    a.1 .0
                        .partial_cmp(&b.1 .0)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
                .unwrap_or(0);
            heap[at] = (d, idx);
        }
        let delta = q[axis] - p[axis];
        let (near, far) = if delta < 0.0 {
            ((lo, mid), (mid + 1, hi))
        } else {
            ((mid + 1, hi), (lo, mid))
        };
        let next = (axis + 1) % 3;
        self.knn_in(near.0, near.1, next, q, k, heap);
        if delta * delta <= worst(heap) {
            self.knn_in(far.0, far.1, next, q, k, heap);
        }
    }

    /// Every point within r of q, r included.
    pub fn within(&self, q: [f64; 3], r: f64) -> Vec<usize> {
        let mut out = Vec::new();
        self.within_in(0, self.order.len(), 0, q, r, &mut out);
        out.sort_unstable();
        out
    }

    fn within_in(
        &self,
        lo: usize,
        hi: usize,
        axis: usize,
        q: [f64; 3],
        r: f64,
        out: &mut Vec<usize>,
    ) {
        if lo >= hi {
            return;
        }
        let mid = (lo + hi) / 2;
        let idx = self.order[mid];
        let p = self.pts[idx];
        if dist2(p, q).sqrt() <= r {
            out.push(idx);
        }
        let delta = q[axis] - p[axis];
        let next = (axis + 1) % 3;
        if delta - r <= 0.0 {
            self.within_in(lo, mid, next, q, r, out);
        }
        if delta + r >= 0.0 {
            self.within_in(mid + 1, hi, next, q, r, out);
        }
    }
}

fn dist2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let (x, y, z) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    x * x + y * y + z * z
}

fn build(pts: &[[f64; 3]], order: &mut [usize], axis: usize) {
    if order.len() <= 1 {
        return;
    }
    let mid = order.len() / 2;
    order.select_nth_unstable_by(mid, |a, b| {
        pts[*a][axis]
            .partial_cmp(&pts[*b][axis])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (left, right) = order.split_at_mut(mid);
    build(pts, left, (axis + 1) % 3);
    build(pts, &mut right[1..], (axis + 1) % 3);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brute_knn(pts: &[[f64; 3]], q: [f64; 3], k: usize) -> Vec<usize> {
        let mut all: Vec<(f64, usize)> = pts
            .iter()
            .enumerate()
            .map(|(i, p)| (dist2(*p, q), i))
            .collect();
        all.sort_by(|a, b| a.partial_cmp(b).unwrap());
        all.into_iter().take(k).map(|(_, i)| i).collect()
    }

    #[test]
    fn queries_agree_with_brute_force() {
        let mut s = 12345u64;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s % 10_000) as f64 / 1000.0
        };
        let pts: Vec<[f64; 3]> = (0..500).map(|_| [rnd(), rnd(), rnd()]).collect();
        let tree = KdTree::new(&pts);
        for _ in 0..50 {
            let q = [rnd(), rnd(), rnd()];
            assert_eq!(tree.knn(q, 7), brute_knn(&pts, q, 7));
            assert_eq!(tree.nearest(q).1, brute_knn(&pts, q, 1)[0]);
            let mut within: Vec<usize> = (0..pts.len())
                .filter(|i| dist2(pts[*i], q).sqrt() <= 1.5)
                .collect();
            within.sort_unstable();
            assert_eq!(tree.within(q, 1.5), within);
        }
    }
}
