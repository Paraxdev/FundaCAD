//! `interference`: which bodies overlap and how close the rest come, once or
//! at every step of a parameter.
//!
//! The engine's `interference` op does the geometry. What lives here is the
//! sweep's arithmetic and the reading of the reply, kept to a line per pair
//! and a line per step: the op also returns each overlap as a mesh for the
//! app to draw, which is no use to an agent and is dropped.

use serde_json::Value;

use crate::describe::g_format;

/// Pairs closer than this are reported when the caller does not say.
pub const DEFAULT_CLEARANCE: f64 = 1.0;

/// More steps than this is a sweep nobody needs in one reply, and each one is
/// a full rebuild.
pub const MAX_STEPS: usize = 100;

/// The parameter a sweep steps and the values it takes.
pub struct Sweep {
    pub param: String,
    pub values: Vec<f64>,
}

fn number(v: Option<&Value>, key: &str) -> Result<f64, String> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).ok_or_else(|| format!("`{key}` has to be a number")),
        Some(Value::String(s)) => s.trim().parse::<f64>().map_err(|_| format!("`{key}` has to be a number, got {s:?}")),
        _ => Err(format!("the sweep needs `{key}`")),
    }
}

/// `{param, from, to, steps}` or `{param, values}`, checked.
pub fn sweep_of(v: &Value) -> Result<Sweep, String> {
    let Some(obj) = v.as_object() else {
        return Err("`sweep` is {param, from, to, steps} or {param, values}".into());
    };
    let param = obj
        .get("param")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or("the sweep needs `param`, the parameter to step")?
        .to_string();
    let known = ["param", "from", "to", "steps", "step", "values"];
    if let Some(k) = obj.keys().find(|k| !known.contains(&k.as_str())) {
        return Err(format!("the sweep takes no '{k}', it takes param, from, to, steps (or step) or values"));
    }
    let values: Vec<f64> = if let Some(list) = obj.get("values") {
        let Some(list) = list.as_array() else {
            return Err("`values` is a list of numbers".into());
        };
        list.iter()
            .enumerate()
            .map(|(i, x)| number(Some(x), &format!("values[{i}]")))
            .collect::<Result<_, _>>()?
    } else {
        let from = number(obj.get("from"), "from")?;
        let to = number(obj.get("to"), "to")?;
        let steps = match (obj.get("steps"), obj.get("step")) {
            (Some(n), _) => {
                let n = number(Some(n), "steps")?;
                if n < 2.0 || n.fract() != 0.0 {
                    return Err("`steps` counts the values, both ends included, so it is a whole number from 2".into());
                }
                n as usize
            }
            (None, Some(s)) => {
                let s = number(Some(s), "step")?.abs();
                if s == 0.0 {
                    return Err("`step` cannot be 0".into());
                }
                ((to - from).abs() / s + 1e-9).floor() as usize + 1
            }
            (None, None) => return Err("the sweep needs `steps` (how many values) or `step` (how far apart)".into()),
        };
        if steps > MAX_STEPS {
            return Err(format!("{steps} steps is more than {MAX_STEPS}, each one is a full rebuild. Use fewer"));
        }
        let span = to - from;
        let last = (steps - 1).max(1) as f64;
        let by_step = obj.get("steps").is_none();
        let step = if by_step { span.signum() * number(obj.get("step"), "step")?.abs() } else { span / last };
        let mut values: Vec<f64> = (0..steps).map(|i| round9(from + step * i as f64)).collect();
        // A step that does not divide the span still ends at `to`: the end
        // of travel is where a mechanism most often clashes.
        if values.last().is_some_and(|v| (v - round9(to)).abs() > 1e-6) {
            values.push(round9(to));
        }
        values
    };
    if values.is_empty() {
        return Err("the sweep has no values".into());
    }
    if values.len() > MAX_STEPS {
        return Err(format!("{} values is more than {MAX_STEPS}, each one is a full rebuild. Use fewer", values.len()));
    }
    Ok(Sweep { param, values })
}

fn round9(v: f64) -> f64 {
    (v * 1e9).round() / 1e9
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("?")
}

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `body3 "Slider"`, or the id alone when the name says nothing more.
fn who(id: &str, name: &str) -> String {
    if name.is_empty() || name == "?" || name == id {
        id.to_string()
    } else {
        format!("{id} \"{name}\"")
    }
}

fn pair(v: &Value) -> String {
    format!("{} / {}", who(s(v, "a"), s(v, "aName")), who(s(v, "b"), s(v, "bName")))
}

fn pair_ids(v: &Value) -> String {
    format!("{}/{}", s(v, "a"), s(v, "b"))
}

fn mm(v: f64) -> String {
    g_format((v * 1000.0).round() / 1000.0)
}

fn point(v: Option<&Value>) -> String {
    let xs: Vec<String> = v
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|x| mm(x.as_f64().unwrap_or(0.0))).collect())
        .unwrap_or_default();
    format!("({})", xs.join(", "))
}

fn list<'a>(r: &'a Value, k: &str) -> &'a [Value] {
    r.get(k).and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

/// Feature failures in the reply, as `build` words them.
pub fn failures(r: &Value) -> Vec<String> {
    list(r, "errors")
        .iter()
        .filter_map(|e| {
            let m = e.get("message").and_then(Value::as_str)?;
            Some(format!(
                "FEATURE FAILED ({}): {m}",
                e.get("feature_id").and_then(Value::as_str).unwrap_or("None")
            ))
        })
        .collect()
}

/// Requested bodies the engine did not find, by the id or name asked for.
pub fn missing(r: &Value, asked: &[String]) -> Vec<String> {
    // No `checked` list is a check of every body, nothing was filtered out.
    if r.get("checked").is_none() {
        return Vec::new();
    }
    let checked = list(r, "checked");
    asked
        .iter()
        .filter(|a| !checked.iter().any(|b| s(b, "id") == a.as_str() || s(b, "name") == a.as_str()))
        .cloned()
        .collect()
}

/// The pairs within the clearance that do not overlap, nearest first.
fn gaps(r: &Value) -> Vec<&Value> {
    let mut g: Vec<&Value> = list(r, "clearances").iter().collect();
    g.sort_by(|a, b| f(a, "distance").total_cmp(&f(b, "distance")));
    g
}

/// One check, in full: every overlap with its volume and where it is, every
/// near pair with its gap and the two closest points.
pub fn report(r: &Value, clearance: f64) -> String {
    let pairs = list(r, "pairs");
    let near = gaps(r);
    let mut out = Vec::new();
    if pairs.is_empty() {
        out.push("No bodies overlap.".to_string());
    } else {
        out.push(format!("{} overlapping pair{}:", pairs.len(), if pairs.len() == 1 { "" } else { "s" }));
        for p in pairs {
            let bb = p.get("bbox");
            out.push(format!(
                "  {}: {} mm3 overlap, from {} to {}",
                pair(p),
                mm(f(p, "volume")),
                point(bb.and_then(|b| b.get("min"))),
                point(bb.and_then(|b| b.get("max")))
            ));
        }
    }
    if clearance > 0.0 {
        if near.is_empty() {
            out.push(format!("No other pair comes within {} mm.", mm(clearance)));
        } else {
            out.push(format!("Within {} mm without overlapping:", mm(clearance)));
            for g in near {
                let d = f(g, "distance");
                let gap = if d < 1e-6 { "touching".to_string() } else { format!("{} mm apart", mm(d)) };
                out.push(format!(
                    "  {}: {gap}, at {} and {}",
                    pair(g),
                    point(g.get("pointA")),
                    point(g.get("pointB"))
                ));
            }
        }
    }
    if let Some(m) = r.get("message").and_then(Value::as_str) {
        out.push(m.to_string());
    }
    out.join("\n")
}

/// What a sweep keeps of each step.
pub struct Step {
    pub value: f64,
    /// The engine's reply, or why there was none.
    pub reply: Result<Value, String>,
}

/// A line per step and a summary, which is what replaces a stack of check
/// features: where it clashes, and how close it gets where it does not.
/// `asked` is the `bodies` filter; a step where one of them was not built
/// says so on its line.
pub fn sweep_report(param: &str, unit: &str, steps: &[Step], clearance: f64, asked: &[String]) -> String {
    let at = |v: f64| format!("{param} = {}", g_format(v));
    let mut lines = Vec::new();
    let mut clashing: Vec<String> = Vec::new();
    let mut closest: Option<(f64, String, f64)> = None;
    let mut unchecked = 0;
    let mut failed_steps = 0;
    let mut cut_short: Option<String> = None;
    let mut cut_steps = 0;
    // Asked-for bodies that were not there, and at which steps.
    let mut absent_at: Vec<(String, Vec<String>)> = Vec::new();
    for st in steps {
        let r = match &st.reply {
            Ok(r) => r,
            Err(why) => {
                unchecked += 1;
                lines.push(format!("{}: not checked, {why}", at(st.value)));
                continue;
            }
        };
        let pairs = list(r, "pairs");
        let near = gaps(r);
        let mut line = if pairs.is_empty() {
            format!("{}: clear", at(st.value))
        } else {
            clashing.push(g_format(st.value));
            format!(
                "{}: CLASH {}",
                at(st.value),
                pairs
                    .iter()
                    .map(|p| format!("{} {} mm3", pair_ids(p), mm(f(p, "volume"))))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        if let Some(g) = near.first() {
            let d = f(g, "distance");
            line.push_str(&format!(
                ", closest {} {}",
                pair_ids(g),
                if d < 1e-6 { "touching".to_string() } else { format!("{} mm", mm(d)) }
            ));
            if closest.as_ref().map_or(true, |c| d < c.0) {
                closest = Some((d, pair(g), st.value));
            }
        }
        if r.get("truncated").and_then(Value::as_bool) == Some(true) {
            cut_steps += 1;
            line.push_str(" (stopped early, not every pair checked)");
            if cut_short.is_none() {
                cut_short = r.get("message").and_then(Value::as_str).map(str::to_string);
            }
        }
        let absent = missing(r, asked);
        if !absent.is_empty() {
            line.push_str(&format!(" ({} not built)", absent.join(", ")));
            for a in absent {
                match absent_at.iter_mut().find(|(b, _)| *b == a) {
                    Some((_, at)) => at.push(g_format(st.value)),
                    None => absent_at.push((a, vec![g_format(st.value)])),
                }
            }
        }
        let failed = failures(r);
        if !failed.is_empty() {
            failed_steps += 1;
            let ids: Vec<&str> = list(r, "errors")
                .iter()
                .filter_map(|e| e.get("feature_id").and_then(Value::as_str))
                .collect();
            line.push_str(&format!(" (features failed: {})", ids.join(", ")));
        }
        lines.push(line);
    }
    let checked = steps.len() - unchecked;
    let of = if unchecked > 0 { format!("{checked} checked") } else { checked.to_string() };
    let unit = if unit.is_empty() || unit == "count" { String::new() } else { format!(" {unit}") };
    let mut summary = if checked == 0 {
        format!("None of the {} steps could be checked.", steps.len())
    } else if clashing.is_empty() {
        format!("No overlaps at any of the {of} steps.")
    } else {
        format!("Overlaps at {} of {of} steps: {param} = {}{unit}.", clashing.len(), clashing.join(", "))
    };
    if clearance > 0.0 && checked > 0 {
        match closest {
            Some((d, who, v)) => summary.push_str(&format!(
                " Closest any non-overlapping pair gets: {} ({who}, at {param} = {}{unit}).",
                if d < 1e-6 { "touching".to_string() } else { format!("{} mm", mm(d)) },
                g_format(v)
            )),
            None => summary.push_str(&format!(" No other pair comes within {} mm at any step.", mm(clearance))),
        }
    }
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    if unchecked > 0 && checked > 0 {
        summary.push_str(&format!(" {unchecked} step{} could not be checked.", plural(unchecked)));
    }
    if failed_steps > 0 {
        summary.push_str(&format!(
            " {failed_steps} step{} had failed features, so {} checked a different set of bodies.",
            plural(failed_steps),
            if failed_steps == 1 { "it" } else { "they" }
        ));
    }
    // A step without one of the bodies asked about did not check its pairs:
    // "clear" there says nothing about the positions an agent sweeps for.
    for (body, at) in &absent_at {
        summary.push_str(&format!(
            " {body} was not built at {} step{} ({param} = {}{unit}), so its pairs were not checked there.",
            at.len(),
            plural(at.len()),
            at.join(", ")
        ));
    }
    if cut_steps > 0 {
        summary.push_str(&format!(
            " At {cut_steps} step{} the check stopped early: {}",
            plural(cut_steps),
            cut_short.as_deref().unwrap_or("not every pair was checked.")
        ));
    }
    format!("{summary}\n{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_sweep_counts_both_ends() {
        let s = sweep_of(&json!({"param": "press", "from": 0, "to": 12, "steps": 13})).unwrap();
        assert_eq!(s.values.len(), 13);
        assert_eq!(s.values[12], 12.0);
        let s = sweep_of(&json!({"param": "press", "from": 0, "to": 1, "step": 0.25})).unwrap();
        assert_eq!(s.values, vec![0.0, 0.25, 0.5, 0.75, 1.0]);
        let s = sweep_of(&json!({"param": "a", "from": 10, "to": 0, "step": 5})).unwrap();
        assert_eq!(s.values, vec![10.0, 5.0, 0.0]);
        assert!(sweep_of(&json!({"param": "a", "from": 0, "to": 1})).is_err());
        assert!(sweep_of(&json!({"param": "a", "values": [1, 2], "by": 3})).is_err());
    }

    #[test]
    fn a_step_that_does_not_divide_the_span_still_ends_at_to() {
        let s = sweep_of(&json!({"param": "press", "from": 0, "to": 10, "step": 3})).unwrap();
        assert_eq!(s.values, vec![0.0, 3.0, 6.0, 9.0, 10.0]);
        let s = sweep_of(&json!({"param": "press", "from": 0, "to": 1, "step": 5})).unwrap();
        assert_eq!(s.values, vec![0.0, 1.0]);
        assert!(sweep_of(&json!({"param": "a", "from": 0, "to": 100, "step": 1})).is_err());
    }

    #[test]
    fn steps_that_were_not_checked_are_not_counted_as_clear() {
        let clear = json!({"pairs": [], "clearances": [], "checked": [{"id": "body1", "name": "Frame"}, {"id": "body2", "name": "Slider"}]});
        let partial = json!({"pairs": [], "clearances": [], "checked": [{"id": "body1", "name": "Frame"}],
                             "errors": [{"feature_id": "ex2", "message": "depth must be positive"}]});
        let cut = json!({"pairs": [], "clearances": [], "truncated": true, "checked": [{"id": "body1", "name": "Frame"}, {"id": "body2", "name": "Slider"}],
                         "message": "Stopped after checking 400 candidate pairs; pick a smaller set of bodies for a full sweep."});
        let text = sweep_report(
            "press",
            "mm",
            &[
                Step { value: 0.0, reply: Ok(clear) },
                Step { value: 6.0, reply: Ok(cut) },
                Step { value: 12.0, reply: Ok(partial) },
                Step { value: 13.0, reply: Err("the geometry engine could not be reached".into()) },
            ],
            0.0,
            &["Frame".to_string(), "Slider".to_string()],
        );
        assert!(text.starts_with("No overlaps at any of the 3 checked steps. 1 step could not be checked."), "{text}");
        assert!(text.contains("1 step had failed features"), "{text}");
        assert!(text.contains("At 1 step the check stopped early: Stopped after checking 400"), "{text}");
        assert!(text.contains("press = 6: clear (stopped early, not every pair checked)"), "{text}");
        assert!(text.contains("press = 12: clear (Slider not built) (features failed: ex2)"), "{text}");
        assert!(text.contains("Slider was not built at 1 step (press = 12 mm), so its pairs were not checked there."), "{text}");
        let none = sweep_report("press", "mm", &[Step { value: 0.0, reply: Err("x".into()) }], 1.0, &[]);
        assert!(none.starts_with("None of the 1 steps could be checked.\n"), "{none}");
    }

    #[test]
    fn a_sweep_names_where_it_clashes() {
        let clash = json!({"pairs": [{"a": "body1", "b": "body2", "aName": "Head", "bName": "Slider", "volume": 2.5}],
                           "clearances": []});
        let clear = json!({"pairs": [], "clearances": [{"a": "body1", "b": "body2", "aName": "Head", "bName": "Slider",
                                                       "distance": 0.4, "pointA": [0, 0, 0], "pointB": [0, 0, 0.4]}]});
        let text = sweep_report(
            "press",
            "mm",
            &[Step { value: 0.0, reply: Ok(clear) }, Step { value: 4.0, reply: Ok(clash) }],
            1.0,
            &[],
        );
        assert!(text.starts_with("Overlaps at 1 of 2 steps: press = 4 mm."), "{text}");
        assert!(text.contains("0.4 mm (body1 \"Head\" / body2 \"Slider\", at press = 0 mm)"), "{text}");
        assert!(text.contains("press = 4: CLASH body1/body2 2.5 mm3"), "{text}");
    }
}
