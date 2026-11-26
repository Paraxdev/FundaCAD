//! Which ways each sketch shape can still move, found by solves that hold one shape at a time, FundaCAD 1's
//! `src/sketch/freedom.ts`.

use std::collections::HashMap;

use crate::compile::{compile_and_solve, Probe, ProbeAxis, SolveOpts};
use crate::model::{Constraint, Entity};

/// A slanted 40 shape sketch took 92 probe solves in FundaCAD 1, and each solve grows with the sketch.
pub const MAX_PROBED: usize = 60;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Freedom {
    pub x: bool,
    pub y: bool,
    pub size: bool,
}

/// None while constraints conflict or the solver fails. Shapes the solver never sees (polygons, slots, text) and
/// shapes past `MAX_PROBED` get no entry.
pub fn shape_freedom(entities: &[Entity], constraints: &[Constraint]) -> Option<HashMap<String, Freedom>> {
    let base = compile_and_solve(entities, constraints, None, &SolveOpts::default()).ok()?;
    if !base.ok || !base.conflicts.is_empty() {
        return None;
    }
    let mut out = HashMap::new();
    let mut probed = 0;
    for e in entities {
        if matches!(e, Entity::Other { .. }) {
            continue;
        }
        let mut f = Freedom::default();
        if matches!(e, Entity::Projected { .. }) || base.dof == 0 {
            out.insert(e.id().to_string(), f);
            continue;
        }
        if probed >= MAX_PROBED {
            continue;
        }
        probed += 1;
        let round = matches!(e, Entity::Circle { .. } | Entity::Arc { .. });
        let axes: &[ProbeAxis] = if round { &[ProbeAxis::X, ProbeAxis::Y, ProbeAxis::Size] } else { &[ProbeAxis::X, ProbeAxis::Y] };
        for &axis in axes {
            let opts = SolveOpts { probe: Some(Probe { entity: e.id().to_string(), axis }), ..Default::default() };
            let held = compile_and_solve(entities, constraints, None, &opts).ok()?;
            let free = held.dof < base.dof;
            match axis {
                ProbeAxis::X => f.x = free,
                ProbeAxis::Y => f.y = free,
                ProbeAxis::Size => f.size = free,
            }
        }
        out.insert(e.id().to_string(), f);
    }
    Some(out)
}
