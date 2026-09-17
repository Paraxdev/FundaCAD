//! Parameters and their expression language, the Rust twin of `src/params/`
//! (`parse.ts`, `eval.ts`, and the evaluation half of `engine.ts` and `extras.ts`).
//!
//! What is ported is what a headless engine needs: evaluating the table in
//! dependency order, validating an expression, and running checks. Writing
//! values back into bound fields, garbage collecting dangling model parameters,
//! renames and deletes stay in the app, which owns document edits.

pub mod eval;
pub mod parse;

use std::collections::VecDeque;

use indexmap::IndexMap;

pub use eval::{eval_expr, eval_node, nearly_equal, Scope};
pub use parse::{
    extract_refs, is_ident_name, is_numeric_literal, is_reserved_name, parse_expr, refs_of,
    rename_refs, Expr, ExprError,
};

use crate::schema::{CadDocument, ParamCheck, ParamDef, Real};

/// The table evaluated: every parameter's value (the cached one where it could
/// not be computed) and why each such parameter kept its cache.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resolution {
    pub values: IndexMap<String, f64>,
    pub issues: IndexMap<String, String>,
}

/// Evaluates `defs` in dependency order (Kahn, table order among equals). A
/// member of a cycle, or anything depending on one, keeps its cached value with
/// a "circular reference" issue; so do an unparsable expression, an evaluation
/// error and a non-finite result, each with its own message.
pub fn resolve(defs: &IndexMap<String, ParamDef>) -> Resolution {
    let nodes: Vec<Option<Expr>> = defs.values().map(|d| parse_expr(&d.expr).ok()).collect();
    let deps: Vec<Vec<usize>> = nodes
        .iter()
        .map(|n| {
            n.as_ref().map_or_else(Vec::new, |n| {
                refs_of(n)
                    .iter()
                    .filter_map(|r| defs.get_index_of(r))
                    .collect()
            })
        })
        .collect();

    let mut indeg: Vec<usize> = deps.iter().map(Vec::len).collect();
    let mut dependents = vec![Vec::new(); defs.len()];
    for (n, ds) in deps.iter().enumerate() {
        for &d in ds {
            dependents[d].push(n);
        }
    }
    let mut queue: VecDeque<usize> = (0..defs.len()).filter(|&n| indeg[n] == 0).collect();
    let mut order = Vec::with_capacity(defs.len());
    while let Some(n) = queue.pop_front() {
        order.push(n);
        for &m in &dependents[n] {
            indeg[m] -= 1;
            if indeg[m] == 0 {
                queue.push_back(m);
            }
        }
    }

    let mut issues = IndexMap::new();
    let mut in_order = vec![false; defs.len()];
    for &n in &order {
        in_order[n] = true;
    }
    for (n, name) in defs.keys().enumerate() {
        if !in_order[n] {
            issues.insert(name.clone(), "circular reference".to_owned());
        }
    }

    let mut values: IndexMap<String, f64> = defs
        .iter()
        .map(|(n, d)| (n.clone(), d.value.get()))
        .collect();
    for n in order {
        let name = defs
            .get_index(n)
            .map(|(k, _)| k.clone())
            .unwrap_or_default();
        let Some(node) = &nodes[n] else {
            issues.insert(name, "invalid expression".to_owned());
            continue;
        };
        match eval_node(node, &values) {
            Ok(v) if v.is_finite() => {
                values.insert(name, v);
            }
            Ok(_) => {
                issues.insert(name, "does not evaluate to a finite number".to_owned());
            }
            Err(e) => {
                issues.insert(name, e.message);
            }
        }
    }
    Resolution { values, issues }
}

/// [`resolve`], with each computed value written into its row's cached `value`
/// and the derived `parameters` map refreshed, as `recompute` does in the app.
pub fn recompute_values(doc: &mut CadDocument) -> IndexMap<String, String> {
    let Some(defs) = doc.param_defs.as_mut() else {
        return IndexMap::new();
    };
    let r = resolve(defs);
    for (name, def) in defs.iter_mut() {
        if let Some(real) = r.values.get(name).and_then(|v| Real::from_f64(*v)) {
            if def.value.get() != real.get() {
                def.value = real;
            }
        }
    }
    doc.parameters = Some(
        defs.iter()
            .map(|(n, d)| (n.clone(), d.value.clone()))
            .collect(),
    );
    r.issues
}

/// The scope a document's expressions evaluate in: the table's cached values,
/// or the plain `parameters` map of a document from before the table existed.
pub fn scope_of(doc: &CadDocument) -> IndexMap<String, f64> {
    match &doc.param_defs {
        Some(defs) => defs
            .iter()
            .map(|(n, d)| (n.clone(), d.value.get()))
            .collect(),
        None => doc
            .parameters
            .iter()
            .flatten()
            .map(|(n, v)| (n.clone(), v.get()))
            .collect(),
    }
}

/// The kind of field an expression is headed for; a count takes no unit suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Length,
    Angle,
    Count,
}

fn find_cycle(
    defs: &IndexMap<String, ParamDef>,
    name: &str,
    refs: &[String],
) -> Option<Vec<String>> {
    fn walk(
        defs: &IndexMap<String, ParamDef>,
        name: &str,
        from: &str,
        path: &[String],
        seen: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        let mut here = path.to_vec();
        here.push(from.to_owned());
        if from == name {
            return Some(here);
        }
        if seen.iter().any(|s| s == from) {
            return None;
        }
        seen.push(from.to_owned());
        let def = defs.get(from)?;
        let refs = parse_expr(&def.expr)
            .map(|n| refs_of(&n))
            .unwrap_or_default();
        refs.iter()
            .filter(|r| defs.contains_key(*r))
            .find_map(|r| walk(defs, name, r, &here, seen))
    }
    let mut seen = Vec::new();
    let start = vec![name.to_owned()];
    refs.iter()
        .find_map(|r| walk(defs, name, r, &start, &mut seen))
}

/// Commit-time validation of `expr` for the parameter `name` (or a fresh
/// binding when `None`): parses, names only known parameters, closes no cycle,
/// has no unit on a count, and evaluates to a finite number, which is returned.
pub fn validate_expr(
    defs: &IndexMap<String, ParamDef>,
    name: Option<&str>,
    expr: &str,
    kind: Option<FieldKind>,
) -> Result<f64, String> {
    let node = parse_expr(expr).map_err(|e| e.message)?;
    let refs = refs_of(&node);
    for r in &refs {
        if !defs.contains_key(r) {
            return Err(format!("unknown parameter \"{r}\""));
        }
        if Some(r.as_str()) == name {
            return Err(format!("\"{r}\" cannot reference itself"));
        }
    }
    if let Some(name) = name {
        if let Some(cycle) = find_cycle(defs, name, &refs) {
            return Err(format!("circular reference: {}", cycle.join(" \u{2192} ")));
        }
    }
    if kind == Some(FieldKind::Count) && parse::has_unit_literal(&node) {
        return Err("this field is unitless, write a plain number".to_owned());
    }
    let values: IndexMap<String, f64> = defs
        .iter()
        .map(|(n, d)| (n.clone(), d.value.get()))
        .collect();
    let value = eval_node(&node, &values).map_err(|e| e.message)?;
    if !value.is_finite() {
        return Err("does not evaluate to a finite number".to_owned());
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckResult {
    pub ok: bool,
    /// Set when the rule could not be evaluated at all, which is also not ok.
    pub error: Option<String>,
}

/// Each check against the cached values: it holds when its expression is non-zero.
pub fn check_results(defs: &IndexMap<String, ParamDef>, checks: &[ParamCheck]) -> Vec<CheckResult> {
    let values: IndexMap<String, f64> = defs
        .iter()
        .map(|(n, d)| (n.clone(), d.value.get()))
        .collect();
    checks
        .iter()
        .map(|c| match eval_expr(&c.expr, &values) {
            Ok(v) if v.is_nan() => CheckResult {
                ok: false,
                error: Some("does not evaluate to a number".to_owned()),
            },
            Ok(v) => CheckResult {
                ok: v != 0.0,
                error: None,
            },
            Err(e) => CheckResult {
                ok: false,
                error: Some(e.message),
            },
        })
        .collect()
}
