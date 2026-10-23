//! How many adaptive passes a stress solve runs and which tets each one refines. Pure arithmetic, no geometry.

/// Solve time grows about as elements^1.3 on the sparse Cholesky factorisation (measured on the Wall bracket).
const WORK_EXPONENT: f64 = 1.3;
/// A refinement pass that would not grow the mesh past this factor is not worth a solve.
const MIN_GROWTH: f64 = 1.1;
/// The peak moving by more than this share in the last pass means it has not settled.
const SETTLED: f64 = 0.1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refine {
    Off,
    Standard,
    Fine,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    /// Refinement passes at most, after the first solve.
    pub passes: usize,
    /// Share of the element ceiling a refined mesh may use.
    pub cap_share: f64,
    /// Total work of every pass, as a multiple of the work of the reference mesh.
    pub work_factor: f64,
    /// Edges shorter than this share of the starting size are never split.
    pub min_edge_share: f64,
}

impl Refine {
    pub fn plan(self) -> Plan {
        match self {
            Refine::Off => Plan { passes: 0, cap_share: 0.0, work_factor: 0.0, min_edge_share: 0.0 },
            // Pass 0 is Off's mesh, so a pass that grows it by MIN_GROWTH needs 1 + 1.1^1.3 = 2.13 of its work.
            Refine::Standard => Plan { passes: 1, cap_share: 1.0, work_factor: 2.2, min_edge_share: 0.25 },
            Refine::Fine => Plan { passes: 3, cap_share: 1.0, work_factor: 6.0, min_edge_share: 0.125 },
        }
    }
}

pub fn work(elements: usize) -> f64 {
    (elements as f64).powf(WORK_EXPONENT)
}

/// The element cap of the next refinement pass after the passes of `counts` (pass 0 first), or None when the plan's
/// passes, the work budget or the growth rule say stop. `reference` is the element count whose work the budget
/// multiplies.
pub fn next_cap(plan: &Plan, max_elements: usize, counts: &[usize], reference: usize) -> Option<usize> {
    let last = *counts.last()?;
    if counts.len() > plan.passes {
        return None;
    }
    let left = plan.work_factor * work(reference) - counts.iter().map(|&n| work(n)).sum::<f64>();
    if left <= 0.0 {
        return None;
    }
    let mut n = left.powf(1.0 / WORK_EXPONENT).floor() as usize;
    while work(n + 1) <= left {
        n += 1;
    }
    while n > 0 && work(n) > left {
        n -= 1;
    }
    let cap = n.min((plan.cap_share * max_elements as f64).floor() as usize);
    (cap as f64 > MIN_GROWTH * last as f64).then_some(cap)
}

/// The tets to refine: the eligible ones of `first`, then the other eligible ones by error, largest first and ties
/// by index, until their squared errors reach `theta` of the eligible total (Dorfler marking). Nothing when every
/// eligible error is zero.
pub fn mark(eta: &[f64], eligible: &[bool], first: &[u32], theta: f64) -> Vec<u32> {
    let ok = |t: u32| eligible.get(t as usize).copied().unwrap_or(false);
    let total: f64 = (0..eta.len() as u32).filter(|&t| ok(t)).map(|t| eta[t as usize].powi(2)).sum();
    if total <= 0.0 {
        return Vec::new();
    }
    let mut out: Vec<u32> = Vec::new();
    for &t in first {
        if ok(t) && !out.contains(&t) {
            out.push(t);
        }
    }
    let mut sum: f64 = out.iter().map(|&t| eta[t as usize].powi(2)).sum();
    let mut rest: Vec<u32> = (0..eta.len() as u32).filter(|&t| ok(t) && !out.contains(&t)).collect();
    rest.sort_by(|&a, &b| eta[b as usize].total_cmp(&eta[a as usize]).then(a.cmp(&b)));
    for t in rest {
        if sum >= theta * total {
            break;
        }
        sum += eta[t as usize].powi(2);
        out.push(t);
    }
    out
}

/// The share the peak moved in the last pass, when above the settled share.
pub fn unsettled(peaks: &[f64]) -> Option<f64> {
    let [.., before, last] = peaks else { return None };
    let share = (last - before).abs() / last.abs();
    (share > SETTLED).then_some(share)
}

/// Whether the next pass, predicted from the last one's time by the work model, would end past `limit` seconds.
pub fn over_time(elapsed: f64, last: f64, n_last: usize, n_next: usize, limit: f64) -> bool {
    elapsed + last * (n_next as f64 / n_last.max(1) as f64).powf(WORK_EXPONENT) > limit
}

/// The share of `peak` the tets a pass refines could move it by: the most any `split` tet's stress gap reaches past
/// the peak from its highest corner stress `top`, so a split tet at the peak counts its whole gap.
pub fn reach(peak: f64, top: &[f64], gap: &[f64], split: &[bool]) -> f64 {
    if peak <= 0.0 {
        return 0.0;
    }
    let most = (0..gap.len().min(top.len()))
        .filter(|&t| split.get(t).copied().unwrap_or(false))
        .map(|t| gap[t] - (peak - top[t]))
        .fold(0.0, f64::max);
    most / peak
}
