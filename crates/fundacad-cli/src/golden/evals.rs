//! eval_fillet_corpus.py and eval_selector_survival.py against a golden: every
//! case's outcome on this engine must be the one Python recorded.

use serde_json::Value;

use super::{table, Ctx};

/// Python's `==` between two JSON values, where 1 and 1.0 are equal.
pub fn same_number_or_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn compare_outcomes(
    ctx: &Ctx,
    got: &[(String, String)],
    field: &str,
    extra: impl Fn(&str) -> String,
) -> Result<(Vec<Vec<String>>, usize), String> {
    let cases = ctx.cases().as_object().ok_or("the golden has no cases")?;
    if got.len() != cases.len() {
        return Err(format!(
            "the golden has {} cases, the corpus {}",
            cases.len(),
            got.len()
        ));
    }
    let (mut rows, mut bad) = (Vec::new(), 0);
    for (id, outcome) in got {
        let want = cases
            .get(id)
            .and_then(|c| c[field].as_str())
            .ok_or_else(|| format!("the golden has no case {id}"))?;
        let same = want == outcome;
        bad += usize::from(!same);
        if !same || want != "pass" && want != "survive" {
            rows.push(vec![
                id.clone(),
                extra(id),
                want.to_owned(),
                outcome.clone(),
                if same { "match" } else { "MISMATCH" }.to_owned(),
            ]);
        }
    }
    Ok((rows, bad))
}

pub fn fillet(ctx: &Ctx) -> Result<bool, String> {
    use fundacad_geom::features::blend::eval;
    let report = eval::run(&ctx.corpus, |_| {})?;
    let path = ctx.header()["corpus"].as_str().unwrap_or("");
    println!("{}\n", eval::render(path, &ctx.corpus, &report, true));
    let got: Vec<(String, String)> = report
        .outcomes
        .iter()
        .map(|(id, o)| (id.clone(), (*o).to_owned()))
        .collect();
    let cases = ctx.cases().clone();
    let (rows, bad) = compare_outcomes(ctx, &got, "outcome", |id| {
        cases[id]["band"].as_str().unwrap_or("").to_owned()
    })?;
    println!("cases python did not pass, and every mismatch:");
    table(&rows, &["case", "band", "python", "rust", "status"]);
    let summary = &ctx.header()["summary"];
    println!(
        "\npython: failed={}/{} selector-miss={} failed ids {}",
        summary["failed"], summary["count"], summary["selectorMiss"], summary["failedIds"]
    );
    println!(
        "rust:   failed={}/{} selector-miss={} failed ids {:?}",
        report.failed, report.count, report.selector_miss, report.failed_ids
    );
    Ok(super::verdict(bad, got.len()))
}

fn corpus_case<'a>(ctx: &'a Ctx, id: &str) -> Result<&'a Value, String> {
    ctx.corpus["cases"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["id"] == id)
        .ok_or_else(|| format!("the corpus has no case {id}"))
}

/// A fillet case's golden from this engine, as freeze_goldens.freeze_fillet writes it.
pub fn record_fillet(ctx: &Ctx, id: &str) -> Result<Value, String> {
    use fundacad_geom::features::blend::eval;
    let case = corpus_case(ctx, id)?;
    let r = eval::run(&serde_json::json!({"cases": [case]}), |_| {})?;
    let outcome = r.outcomes.first().map_or("pass", |o| o.1);
    let mut entry = serde_json::json!({"band": case["band"], "outcome": outcome});
    if outcome == "fail" {
        entry["message"] = r.messages.keys().next().cloned().into();
        entry["taxonomy"] = if r.per_edge > 0 {
            "per_edge"
        } else if r.combination > 0 {
            "combination"
        } else {
            "other"
        }
        .into();
    }
    Ok(entry)
}

pub fn refresh_fillet_summary(ctx: &mut Ctx) {
    let cases = ctx.cases().as_object().cloned().unwrap_or_default();
    let with = |o: &str| -> Vec<String> {
        cases
            .iter()
            .filter(|(_, c)| c["outcome"] == o)
            .map(|(k, _)| k.clone())
            .collect()
    };
    let failed = with("fail");
    ctx.golden["golden"]["summary"] = serde_json::json!({
        "count": cases.len(), "failed": failed.len(),
        "selectorMiss": with("selector-miss").len(), "failedIds": failed});
    ctx.golden["golden"]["corpusSelfHash"] = ctx.corpus["self_hash"].clone();
}

/// A selector case's golden from this engine, as freeze_goldens.freeze_selectors writes it.
pub fn record_selector(ctx: &Ctx, id: &str) -> Result<Value, String> {
    use fundacad_geom::select::eval::{self, Outcome};
    let case = corpus_case(ctx, id)?;
    let (o, _) = eval::score_case(case, fundacad_geom::select::Tuning::shipped());
    let name = match o {
        Outcome::Survive => "survive",
        Outcome::Miss => "miss",
        Outcome::Invalid => "invalid",
    };
    Ok(serde_json::json!({"category": case["category"], "outcome": name}))
}

pub fn refresh_selector_metrics(ctx: &mut Ctx) {
    use fundacad_geom::select::eval::{self, Outcome};
    let cases = ctx.cases().as_object().cloned().unwrap_or_default();
    let outcomes: Vec<(&str, Outcome)> = cases
        .values()
        .map(|c| {
            let o = match c["outcome"].as_str() {
                Some("survive") => Outcome::Survive,
                Some("miss") => Outcome::Miss,
                _ => Outcome::Invalid,
            };
            (c["category"].as_str().unwrap_or(""), o)
        })
        .collect();
    ctx.golden["golden"]["metrics"] = Value::Object(eval::aggregate(&outcomes));
}

pub fn selectors(ctx: &Ctx) -> Result<bool, String> {
    use fundacad_geom::select::eval::{self, Outcome};
    use fundacad_geom::select::Tuning;
    let tuning = *Tuning::shipped();
    let cases_in = ctx.corpus["cases"]
        .as_array()
        .ok_or("the corpus has no cases")?;
    let mut outcomes = Vec::new();
    let mut got = Vec::new();
    for case in cases_in {
        let (o, err) = eval::score_case(case, &tuning);
        let id = case["id"].as_str().unwrap_or("?").to_owned();
        if let Some(err) = err {
            eprintln!("  case {id} raised: {err}");
        }
        let name = match o {
            Outcome::Survive => "survive",
            Outcome::Miss => "miss",
            Outcome::Invalid => "invalid",
        };
        outcomes.push((case["category"].as_str().unwrap_or(""), o));
        got.push((id, name.to_owned()));
    }
    let metrics = eval::aggregate(&outcomes);
    let cases = ctx.cases().clone();
    let (mut rows, mut bad) = compare_outcomes(ctx, &got, "outcome", |id| {
        cases[id]["category"].as_str().unwrap_or("").to_owned()
    })?;
    let want = ctx.header()["metrics"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut metric_rows = Vec::new();
    for (k, w) in &want {
        let g = metrics.get(k).cloned().unwrap_or(Value::Null);
        let same = same_number_or_value(&g, w);
        bad += usize::from(!same);
        metric_rows.push(vec![
            k.clone(),
            w.to_string(),
            g.to_string(),
            if same { "match" } else { "MISMATCH" }.into(),
        ]);
    }
    let tests = eval::selector_v2_checks(&tuning);
    if let Err(e) = &tests {
        bad += 1;
        rows.push(vec![
            "selector v2 checks".into(),
            String::new(),
            "pass".into(),
            e.clone(),
            "MISMATCH".into(),
        ]);
    }
    println!("cases python did not see survive, and every mismatch:");
    table(&rows, &["case", "category", "python", "rust", "status"]);
    println!();
    table(&metric_rows, &["metric", "python", "rust", "status"]);
    println!(
        "\nselector v2 checks: {}",
        if tests.is_ok() { "pass" } else { "FAIL" }
    );
    Ok(super::verdict(bad, got.len() + want.len() + 1))
}
