//! `interference`, once or at every step of a parameter. The engine does the geometry; this is the sweep's
//! arithmetic and a line per pair and per step, dropping the overlap meshes the op returns for the app.

use serde_json::Value;

use crate::budget::{self, Page};
use crate::describe::g_format;

fn alike(full: bool) -> &'static str {
    if full {
        ""
    } else {
        ", alike pairs in one row"
    }
}

/// Pairs closer than this are reported when the caller does not say.
pub const DEFAULT_CLEARANCE: f64 = 1.0;

/// More steps is a sweep nobody needs in one reply, and each one is a full rebuild.
pub const MAX_STEPS: usize = 100;

pub struct Sweep {
    pub param: String,
    pub values: Vec<f64>,
}

fn number(v: Option<&Value>, key: &str) -> Result<f64, String> {
    match v {
        Some(Value::Number(n)) => {
            n.as_f64().filter(|f| f.is_finite()).ok_or_else(|| format!("`{key}` has to be a number"))
        }
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
        list.iter().enumerate().map(|(i, x)| number(Some(x), &format!("values[{i}]"))).collect::<Result<_, _>>()?
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
            Some(format!("FEATURE FAILED ({}): {m}", e.get("feature_id").and_then(Value::as_str).unwrap_or("None")))
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

/// Bodies the engine could not judge, with why: a pair with one was tested for neither overlap nor clearance.
pub fn unjudged(r: &Value) -> Vec<String> {
    list(r, "unchecked").iter().map(|u| format!("{} {}", who(s(u, "id"), s(u, "name")), s(u, "reason"))).collect()
}

/// The pairs within the clearance that do not overlap, nearest first.
fn gaps(r: &Value) -> Vec<&Value> {
    let mut g: Vec<&Value> = list(r, "clearances").iter().collect();
    g.sort_by(|a, b| f(a, "distance").total_cmp(&f(b, "distance")));
    g
}

/// The ids a folded row spells out before it counts the rest.
const IDS: usize = 240;

/// A pair's row: two rows fold when `same` matches, which leaves out the ids, the copy numbers and the position.
struct PairRow {
    a: String,
    b: String,
    same: String,
    text: String,
}

fn pair_row(p: &Value, same: String, text: String) -> PairRow {
    let stems = format!("{}\n{}", budget::stem(s(p, "aName")), budget::stem(s(p, "bName")));
    PairRow { a: s(p, "a").to_string(), b: s(p, "b").to_string(), same: format!("{stems}\n{same}"), text }
}

fn overlap_row(p: &Value) -> PairRow {
    let bb = p.get("bbox");
    let corner = |k: &str| -> Vec<f64> {
        bb.and_then(|b| b.get(k))
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
            .unwrap_or_default()
    };
    let size: Vec<String> = corner("min").iter().zip(corner("max")).map(|(lo, hi)| mm(hi - lo)).collect();
    let volume = mm(f(p, "volume"));
    let text = format!(
        "  {}: {volume} mm3 overlap, from {} to {}",
        pair(p),
        point(bb.and_then(|b| b.get("min"))),
        point(bb.and_then(|b| b.get("max")))
    );
    pair_row(p, format!("{volume} {}", size.join(" x ")), text)
}

fn gap_row(g: &Value) -> PairRow {
    let d = f(g, "distance");
    let gap = if d < 1e-6 { "touching".to_string() } else { format!("{} mm apart", mm(d)) };
    let text = format!("  {}: {gap}, at {} and {}", pair(g), point(g.get("pointA")), point(g.get("pointB")));
    pair_row(g, gap, text)
}

/// Pairs alike in all but their ids and where they meet become the first of them, with the others' ids.
fn fold_pairs(rows: Vec<PairRow>) -> Vec<String> {
    if rows.len() <= budget::FOLD_FROM {
        return rows.into_iter().map(|r| r.text).collect();
    }
    let mut groups: Vec<(PairRow, Vec<PairRow>)> = Vec::new();
    let mut at: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for r in rows {
        match at.get(&r.same) {
            Some(&i) => groups[i].1.push(r),
            None => {
                at.insert(r.same.clone(), groups.len());
                groups.push((r, Vec::new()));
            }
        }
    }
    groups.into_iter().map(|(first, rest)| folded_pair(first, &rest)).collect()
}

fn folded_pair(first: PairRow, rest: &[PairRow]) -> String {
    if rest.is_empty() {
        return first.text;
    }
    let one_a = rest.iter().all(|r| r.a == first.a);
    let one_b = !one_a && rest.iter().all(|r| r.b == first.b);
    let mut ids: Vec<String> = rest
        .iter()
        .map(|r| {
            if one_a {
                r.b.clone()
            } else if one_b {
                r.a.clone()
            } else {
                format!("{}/{}", r.a, r.b)
            }
        })
        .collect();
    ids.sort_by(|x, y| {
        let (xa, xb) = x.split_once('/').unwrap_or((x, ""));
        let (ya, yb) = y.split_once('/').unwrap_or((y, ""));
        budget::natural(xa, ya).then_with(|| budget::natural(xb, yb))
    });
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (said, left) = budget::ranges_capped(&refs, false, IDS);
    let said = if one_a {
        format!("{} / {said}", first.a)
    } else if one_b {
        format!("{said} / {}", first.b)
    } else {
        said
    };
    let left = if left > 0 { format!(" and {left} more, full true lists every pair") } else { String::new() };
    format!("{} (and {} more alike: {said}{left})", first.text, rest.len())
}

/// The rows of one list, folded unless `full`, and the page of them asked for.
fn listed(rows: Vec<PairRow>, page: Page, full: bool, noun: &str) -> Vec<String> {
    let rows = if full { rows.into_iter().map(|r| r.text).collect() } else { fold_pairs(rows) };
    let (mut shown, more) = page.cut(rows, noun);
    shown.extend(more.map(|m| format!("  {m}")));
    shown
}

/// One check's reply. A list longer than FOLD_FROM pairs says its sum first, folds alike pairs unless `full`,
/// and shows `page` of its rows; a short one reads as it always did.
pub fn report(r: &Value, clearance: f64, page: Page, full: bool) -> String {
    let pairs = list(r, "pairs");
    let near = gaps(r);
    let skipped = unjudged(r);
    let mut out = Vec::new();
    if !skipped.is_empty() {
        let n = r.get("uncheckedPairs").and_then(Value::as_u64).unwrap_or(0);
        out.push(format!(
            "NOT CHECKED: {n} pair{} that may overlap, because {} cannot be judged:",
            if n == 1 { "" } else { "s" },
            if skipped.len() == 1 { "one of the two bodies".to_string() } else { format!("{} bodies", skipped.len()) }
        ));
        out.extend(skipped.iter().map(|b| format!("  {b}")));
    }
    if pairs.is_empty() {
        // "No bodies overlap" is a claim about every pair, and some were not tested.
        out.push(
            if skipped.is_empty() { "No bodies overlap." } else { "No overlap among the pairs that were checked." }
                .to_string(),
        );
    } else {
        let head = format!("{} overlapping pair{}:", pairs.len(), if pairs.len() == 1 { "" } else { "s" });
        let mut sorted: Vec<&Value> = pairs.iter().collect();
        if pairs.len() > budget::FOLD_FROM {
            sorted.sort_by(|a, b| f(b, "volume").total_cmp(&f(a, "volume")));
            let total: f64 = pairs.iter().map(|p| f(p, "volume")).sum();
            out.push(format!("{head} {} mm3 overlap in all, largest first{}", mm(total), alike(full)));
        } else {
            out.push(head);
        }
        out.extend(listed(sorted.into_iter().map(overlap_row).collect(), page, full, "overlap rows"));
    }
    if clearance > 0.0 {
        if near.is_empty() {
            out.push(format!("No other pair comes within {} mm.", mm(clearance)));
        } else {
            let head = format!("Within {} mm without overlapping:", mm(clearance));
            if near.len() > budget::FOLD_FROM {
                out.push(format!("{head} {} pairs, nearest first{}", near.len(), alike(full)));
            } else {
                out.push(head);
            }
            out.extend(listed(near.into_iter().map(gap_row).collect(), page, full, "near rows"));
        }
    }
    if let Some(m) = r.get("message").and_then(Value::as_str) {
        out.push(m.to_string());
    }
    out.join("\n")
}

pub struct Step {
    pub value: f64,
    pub reply: Result<Value, String>,
}

/// `asked` is the `bodies` filter; a step where one of them was not built says so on its line.
pub fn sweep_report(param: &str, unit: &str, steps: &[Step], clearance: f64, asked: &[String]) -> String {
    sweep_paged(param, unit, steps, clearance, asked, Page { offset: 0, limit: budget::FOLD_FROM }, false)
}

/// One step's clashing pairs: a long list sums first and goes largest first unless `full`, and shows `page` of
/// itself. The bool is whether pairs past the page were left out.
fn step_pairs(pairs: &[Value], page: Page, full: bool) -> (String, bool) {
    let long = pairs.len() > budget::FOLD_FROM;
    let mut sorted: Vec<&Value> = pairs.iter().collect();
    if long && !full {
        sorted.sort_by(|a, b| f(b, "volume").total_cmp(&f(a, "volume")));
    }
    let rows: Vec<String> = sorted.iter().map(|p| format!("{} {} mm3", pair_ids(p), mm(f(p, "volume")))).collect();
    let total = rows.len();
    let (shown, cut) = page.cut(rows, "pairs");
    if cut.is_none() && (full || !long) {
        return (shown.join(", "), false);
    }
    let sum: f64 = pairs.iter().map(|p| f(p, "volume")).sum();
    let order = if long && !full { ", largest first" } else { "" };
    let head = format!("{total} pairs, {} mm3 in all{order}", mm(sum));
    if shown.is_empty() {
        return (format!("{head}, none from offset {}", page.offset), false);
    }
    let end = page.offset + shown.len();
    if page.offset > 0 {
        return (format!("{head}, pairs {} to {end}: {}", page.offset + 1, shown.join(", ")), end < total);
    }
    let more = if end < total { format!(" and {} more", total - end) } else { String::new() };
    (format!("{head}: {}{more}", shown.join(", ")), end < total)
}

/// As `sweep_report`, each step's pairs cut to `page`, and every pair in the engine's order when `full`.
pub fn sweep_paged(
    param: &str,
    unit: &str,
    steps: &[Step],
    clearance: f64,
    asked: &[String],
    page: Page,
    full: bool,
) -> String {
    let at = |v: f64| format!("{param} = {}", g_format(v));
    let mut left_out = false;
    let mut lines = Vec::new();
    let mut clashing: Vec<String> = Vec::new();
    let mut closest: Option<(f64, String, f64)> = None;
    let mut unchecked = 0;
    let mut failed_steps = 0;
    let mut cut_short: Option<String> = None;
    let mut cut_steps = 0;
    let mut absent_at: Vec<(String, Vec<String>)> = Vec::new();
    let mut unjudged_at: Vec<(String, Vec<String>)> = Vec::new();
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
        let skipped = unjudged(r);
        let mut line = if pairs.is_empty() {
            format!("{}: {}", at(st.value), if skipped.is_empty() { "clear" } else { "no overlap found" })
        } else {
            clashing.push(g_format(st.value));
            let (said, more) = step_pairs(pairs, page, full);
            left_out |= more;
            format!("{}: CLASH {said}", at(st.value))
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
        if !skipped.is_empty() {
            let ids: Vec<&str> = list(r, "unchecked").iter().map(|u| s(u, "id")).collect();
            line.push_str(&format!(" ({} not judged, its pairs not checked)", ids.join(", ")));
            for b in skipped {
                match unjudged_at.iter_mut().find(|(k, _)| *k == b) {
                    Some((_, at)) => at.push(g_format(st.value)),
                    None => unjudged_at.push((b, vec![g_format(st.value)])),
                }
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
            // Each id with why it failed: at a sweep step that reason (a joint
            // that cannot close, a depth gone negative) is often the answer.
            let why: Vec<String> = list(r, "errors")
                .iter()
                .filter_map(|e| {
                    let id = e.get("feature_id").and_then(Value::as_str);
                    match (id, e.get("message").and_then(Value::as_str)) {
                        (Some(id), Some(m)) => Some(format!("{id}: {m}")),
                        (Some(id), None) => Some(id.to_string()),
                        (None, m) => m.map(str::to_string),
                    }
                })
                .collect();
            line.push_str(&format!(" (features failed: {})", why.join("; ")));
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
    // The same for a body the engine could not judge: "no overlaps" there is
    // only about the other pairs.
    for (body, at) in &unjudged_at {
        summary.push_str(&format!(
            " At {} step{} a body could not be judged and its pairs were NOT CHECKED: {body}.",
            at.len(),
            plural(at.len())
        ));
    }
    if cut_steps > 0 {
        summary.push_str(&format!(
            " At {cut_steps} step{} the check stopped early: {}",
            plural(cut_steps),
            cut_short.as_deref().unwrap_or("not every pair was checked.")
        ));
    }
    if left_out {
        let next = page.offset + page.limit;
        lines.push(format!(
            "A step shows pairs {} to {next}: pass offset {next} for the next {}, or limit 0 for every pair",
            page.offset + 1,
            page.limit
        ));
    }
    format!("{summary}\n{}", lines.join("\n"))
}
