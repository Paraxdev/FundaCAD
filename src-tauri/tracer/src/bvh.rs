//! The software path's per body tree, in the body's own space, so an edit
//! rebuilds one body's tree like the hardware path rebuilds one BLAS.

/// Two vec4 per node: min.xyz + first (child or triangle), max.xyz + count.
/// count 0 marks an inner node whose children sit at first and first + 1.
pub struct Bvh {
    pub nodes: Vec<[f32; 4]>,
    /// Triangle ids in leaf order.
    pub order: Vec<u32>,
}

/// Entries in sw.wgsl's traversal stack.
pub const STACK: u32 = 64;

const BINS: usize = 12;
const LEAF: usize = 4;
/// Past this depth a node splits at the median, which bounds the depth at
/// MEDIAN_DEPTH + log2(n / LEAF): 62 for 16M triangles, inside STACK.
const MEDIAN_DEPTH: u32 = 40;

#[derive(Clone, Copy)]
struct Aabb {
    lo: [f32; 3],
    hi: [f32; 3],
}

impl Aabb {
    const EMPTY: Aabb = Aabb { lo: [f32::MAX; 3], hi: [f32::MIN; 3] };
    fn grow(&mut self, p: [f32; 3]) {
        for k in 0..3 {
            self.lo[k] = self.lo[k].min(p[k]);
            self.hi[k] = self.hi[k].max(p[k]);
        }
    }
    fn join(&mut self, o: &Aabb) {
        self.grow(o.lo);
        self.grow(o.hi);
    }
    fn area(&self) -> f32 {
        let d = [0, 1, 2].map(|k| (self.hi[k] - self.lo[k]).max(0.0));
        d[0] * d[1] + d[1] * d[2] + d[2] * d[0]
    }
}

pub fn build(positions: &[[f32; 3]], indices: &[u32]) -> Bvh {
    let n = indices.len() / 3;
    let boxes: Vec<Aabb> = (0..n)
        .map(|t| {
            let mut b = Aabb::EMPTY;
            for k in 0..3 {
                b.grow(positions[indices[t * 3 + k] as usize]);
            }
            b
        })
        .collect();
    let cent: Vec<[f32; 3]> = boxes.iter().map(|b| [0, 1, 2].map(|k| 0.5 * (b.lo[k] + b.hi[k]))).collect();
    let mut order: Vec<u32> = (0..n as u32).collect();
    let mut nodes: Vec<(Aabb, u32, u32)> = vec![(Aabb::EMPTY, 0, 0)];
    let mut stack = vec![(0usize, 0usize, n, 0u32)];
    while let Some((ni, lo, hi, depth)) = stack.pop() {
        let mut bb = Aabb::EMPTY;
        let mut cb = Aabb::EMPTY;
        for &t in &order[lo..hi] {
            bb.join(&boxes[t as usize]);
            cb.grow(cent[t as usize]);
        }
        let count = hi - lo;
        let leaf = (bb, lo as u32, count as u32);
        if count <= LEAF {
            nodes[ni] = leaf;
            continue;
        }
        let mid = if depth >= MEDIAN_DEPTH {
            let ax = (0..3).max_by(|&a, &b| (cb.hi[a] - cb.lo[a]).total_cmp(&(cb.hi[b] - cb.lo[b]))).unwrap_or(0);
            order[lo..hi]
                .select_nth_unstable_by(count / 2, |a, b| cent[*a as usize][ax].total_cmp(&cent[*b as usize][ax]));
            count / 2
        } else {
            let mut best = (f32::MAX, 0usize, 0usize);
            for ax in 0..3 {
                let ext = cb.hi[ax] - cb.lo[ax];
                if ext <= 0.0 {
                    continue;
                }
                let bin_of = |t: u32| (((cent[t as usize][ax] - cb.lo[ax]) / ext * BINS as f32) as usize).min(BINS - 1);
                let mut bins = [(Aabb::EMPTY, 0usize); BINS];
                for &t in &order[lo..hi] {
                    let b = &mut bins[bin_of(t)];
                    b.0.join(&boxes[t as usize]);
                    b.1 += 1;
                }
                let mut right = [0f32; BINS];
                let (mut acc, mut cnt) = (Aabb::EMPTY, 0);
                for i in (1..BINS).rev() {
                    acc.join(&bins[i].0);
                    cnt += bins[i].1;
                    right[i] = if cnt > 0 { acc.area() * cnt as f32 } else { 0.0 };
                }
                let (mut acc, mut cnt) = (Aabb::EMPTY, 0);
                for i in 0..BINS - 1 {
                    acc.join(&bins[i].0);
                    cnt += bins[i].1;
                    let cost = if cnt > 0 { acc.area() * cnt as f32 } else { 0.0 } + right[i + 1];
                    if cnt > 0 && cnt < count && cost < best.0 {
                        best = (cost, ax, i);
                    }
                }
            }
            if best.0 < f32::MAX {
                let (ax, split) = (best.1, best.2);
                let ext = cb.hi[ax] - cb.lo[ax];
                let slice = &mut order[lo..hi];
                let mut i = 0;
                for j in 0..slice.len() {
                    let t = slice[j] as usize;
                    let b = (((cent[t][ax] - cb.lo[ax]) / ext * BINS as f32) as usize).min(BINS - 1);
                    if b <= split {
                        slice.swap(i, j);
                        i += 1;
                    }
                }
                i
            } else {
                // Every centroid in one spot: halve the list as it stands.
                count / 2
            }
        };
        let l = nodes.len();
        nodes.push((Aabb::EMPTY, 0, 0));
        nodes.push((Aabb::EMPTY, 0, 0));
        nodes[ni] = (bb, l as u32, 0);
        stack.push((l, lo, lo + mid, depth + 1));
        stack.push((l + 1, lo + mid, hi, depth + 1));
    }
    let nodes = nodes
        .iter()
        .flat_map(|(b, first, c)| {
            [[b.lo[0], b.lo[1], b.lo[2], f32::from_bits(*first)], [b.hi[0], b.hi[1], b.hi[2], f32::from_bits(*c)]]
        })
        .collect();
    Bvh { nodes, order }
}
