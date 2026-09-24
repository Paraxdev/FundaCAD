//! The feature's nodes and chains, read and checked.

use serde_json::Value;

use crate::feature;
use crate::math::{self, M, V};

pub struct Node {
    pub id: String,
    pub center: V,
    /// Rotation times the semi-axes: the unit sphere carried onto the node.
    pub shape: M,
}

impl Node {
    /// The semi-axis vector of the node's ellipsoid whose tangent plane faces
    /// `n`: where a plane normal to `n` slides to as it leaves the node.
    pub fn conjugate(&self, n: V) -> V {
        let w = math::apply(&math::transpose(&self.shape), n);
        math::mul(math::apply(&self.shape, w), 1.0 / math::norm(w))
    }

    /// The node's cut through its centre by the plane normal to `n`: the two
    /// principal semi-axis vectors of that ellipse.
    pub fn section(&self, n: V) -> (V, V) {
        let w = math::unit(math::apply(&math::transpose(&self.shape), n));
        let (e1, e2) = math::perp_pair(w, [1.0, 0.0, 0.0]);
        let (a, b) = (math::apply(&self.shape, e1), math::apply(&self.shape, e2));
        let turn = 0.5 * (2.0 * math::dot(a, b)).atan2(math::dot(a, a) - math::dot(b, b));
        let (s, c) = turn.sin_cos();
        let e1r = math::add(math::mul(e1, c), math::mul(e2, s));
        let e2r = math::sub(math::mul(e2, c), math::mul(e1, s));
        (math::apply(&self.shape, e1r), math::apply(&self.shape, e2r))
    }
}

fn number(v: Option<&Value>, default: f64, what: &str) -> Result<f64, String> {
    match v {
        None | Some(Value::Null) => Ok(default),
        Some(v) => feature::number(&v.to_string()).map_err(|e| format!("{what}: {e}")),
    }
}

/// Every node, in document order, ids unique.
pub fn read_nodes(raw: &Value) -> Result<Vec<Node>, String> {
    let list = raw.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out: Vec<Node> = Vec::with_capacity(list.len());
    for (i, n) in list.iter().enumerate() {
        let id = n
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("#{}", i + 1));
        if out.iter().any(|o| o.id == id) {
            return Err(format!("two nodes are both called {id}"));
        }
        let at = |k: &str, d: f64| number(n.get(k), d, &format!("node {id} {k}"));
        let center = [at("x", 0.0)?, at("y", 0.0)?, at("z", 0.0)?];
        let sx = at("sx", 5.0)?;
        let sy = at("sy", sx)?;
        let sz = at("sz", sx)?;
        for (k, s) in [("sx", sx), ("sy", sy), ("sz", sz)] {
            if !(s > 1e-4) || !s.is_finite() {
                return Err(format!("node {id} {k} must be greater than 0"));
            }
        }
        if !center.iter().all(|c| c.is_finite()) {
            return Err(format!("node {id} has a position that is not a number"));
        }
        let r = math::rotation(at("rx", 0.0)?, at("ry", 0.0)?, at("rz", 0.0)?);
        let scale = [[sx, 0.0, 0.0], [0.0, sy, 0.0], [0.0, 0.0, sz]];
        out.push(Node { id, center, shape: math::mat_mul(&r, &scale) });
    }
    Ok(out)
}

/// Each chain as indices into `nodes`, a node repeated back to back kept once.
/// A chain of one node is left out: that node is drawn on its own.
pub fn read_chains(raw: &Value, nodes: &[Node]) -> Result<Vec<Vec<usize>>, String> {
    let list = raw.get("chains").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for (ci, chain) in list.iter().enumerate() {
        let ids: Vec<&str> = chain
            .as_array()
            .ok_or_else(|| format!("chain {} is not a list of node ids", ci + 1))?
            .iter()
            .map(|v| v.as_str().ok_or_else(|| format!("chain {} holds something that is not a node id", ci + 1)))
            .collect::<Result<_, _>>()?;
        let mut idx: Vec<usize> = Vec::with_capacity(ids.len());
        for id in ids {
            let i = nodes
                .iter()
                .position(|n| n.id == id)
                .ok_or_else(|| format!("chain {} names node {id}, which does not exist", ci + 1))?;
            if idx.last() != Some(&i) {
                idx.push(i);
            }
        }
        for w in idx.windows(2) {
            let (a, b) = (&nodes[w[0]], &nodes[w[1]]);
            if math::norm(math::sub(a.center, b.center)) < 1e-6 {
                return Err(format!("nodes {} and {} sit on the same point, a chain cannot run between them", a.id, b.id));
            }
        }
        if idx.len() >= 2 {
            out.push(idx);
        }
    }
    Ok(out)
}
