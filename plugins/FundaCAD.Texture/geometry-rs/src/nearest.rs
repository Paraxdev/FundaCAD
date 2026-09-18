//! `scipy.spatial.cKDTree(...).query(points)` for the distance alone: the exact
//! Euclidean distance to the nearest site, which does not depend on how the
//! tree is built.

pub struct Tree {
    pts: Vec<Vec<f64>>,
    /// Node order: a balanced kd tree laid out in `pts` by median splits.
    dim: usize,
}

fn build(pts: &mut [Vec<f64>], depth: usize, dim: usize) {
    if pts.len() <= 1 {
        return;
    }
    let axis = depth % dim;
    let mid = pts.len() / 2;
    pts.select_nth_unstable_by(mid, |a, b| a[axis].partial_cmp(&b[axis]).unwrap_or(std::cmp::Ordering::Equal));
    let (lo, hi) = pts.split_at_mut(mid);
    build(lo, depth + 1, dim);
    build(&mut hi[1..], depth + 1, dim);
}

impl Tree {
    pub fn new(mut pts: Vec<Vec<f64>>) -> Tree {
        let dim = pts.first().map_or(2, Vec::len);
        build(&mut pts, 0, dim);
        Tree { pts, dim }
    }

    fn search(&self, lo: usize, hi: usize, depth: usize, q: &[f64], best: &mut f64) {
        if lo >= hi {
            return;
        }
        let mid = lo + (hi - lo) / 2;
        let p = &self.pts[mid];
        let d2: f64 = p.iter().zip(q).map(|(a, b)| (a - b) * (a - b)).sum();
        if d2 < *best {
            *best = d2;
        }
        let axis = depth % self.dim;
        let diff = q[axis] - p[axis];
        let (near, far) = if diff < 0.0 {
            ((lo, mid), (mid + 1, hi))
        } else {
            ((mid + 1, hi), (lo, mid))
        };
        self.search(near.0, near.1, depth + 1, q, best);
        if diff * diff < *best {
            self.search(far.0, far.1, depth + 1, q, best);
        }
    }

    /// The distance from `q` to the nearest point, infinity with none.
    pub fn nearest(&self, q: &[f64]) -> f64 {
        let mut best = f64::INFINITY;
        self.search(0, self.pts.len(), 0, q, &mut best);
        best.sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_brute_force() {
        let mut pts = Vec::new();
        let mut s = 7u64;
        let mut next = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..500 {
            pts.push(vec![next() * 10.0, next() * 10.0, next()]);
        }
        let t = Tree::new(pts.clone());
        for _ in 0..200 {
            let q = [next() * 12.0 - 1.0, next() * 12.0 - 1.0, next()];
            let brute = pts
                .iter()
                .map(|p| p.iter().zip(&q).map(|(a, b)| (a - b) * (a - b)).sum::<f64>())
                .fold(f64::INFINITY, f64::min)
                .sqrt();
            assert_eq!(t.nearest(&q), brute);
        }
    }
}
