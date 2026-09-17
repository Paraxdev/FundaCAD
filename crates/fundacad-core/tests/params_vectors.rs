//! tests/vectors/params.json, the same vectors tests/params/vectors.test.ts runs
//! against src/params, so the two evaluators cannot drift apart.

use std::path::Path;

use fundacad_core::params::{
    check_results, eval_expr, extract_refs, is_ident_name, is_numeric_literal, is_reserved_name,
    rename_refs, resolve, validate_expr, FieldKind,
};
use fundacad_core::schema::{ParamCheck, ParamDef};
use indexmap::IndexMap;
use serde_json::Value;

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/params.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vectors"))
        .expect("parse vectors")
}

fn scope(v: &Value) -> IndexMap<String, f64> {
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(k, x)| (k.clone(), x.as_f64().expect("number")))
                .collect()
        })
        .unwrap_or_default()
}

fn expected(v: &Value) -> f64 {
    match v {
        Value::String(s) if s == "NaN" => f64::NAN,
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        other => other.as_f64().expect("expected value"),
    }
}

fn defs(v: &Value) -> IndexMap<String, ParamDef> {
    serde_json::from_value(v.clone()).expect("defs")
}

#[test]
fn evaluation() {
    let v = vectors();
    let cases = v["eval"].as_array().expect("eval");
    assert!(cases.len() > 50);
    for c in cases {
        let expr = c["expr"].as_str().expect("expr");
        let got = eval_expr(expr, &scope(&c["values"])).unwrap_or_else(|e| panic!("{expr}: {e}"));
        let want = expected(&c["expect"]);
        if want.is_nan() {
            assert!(got.is_nan(), "{expr}: got {got}, want NaN");
        } else if let Some(digits) = c["digits"].as_i64() {
            let tol = 10f64.powi(-i32::try_from(digits).expect("digits")) / 2.0;
            assert!(
                (got - want).abs() < tol,
                "{expr}: got {got}, want {want} to {digits} digits"
            );
        } else {
            assert!(got == want, "{expr}: got {got:?}, want {want:?}");
        }
    }
}

#[test]
fn errors() {
    for c in vectors()["errors"].as_array().expect("errors") {
        let expr = c["expr"].as_str().expect("expr");
        let want = c["error"].as_str().expect("error");
        match eval_expr(expr, &scope(&c["values"])) {
            Ok(v) => panic!("{expr:?}: evaluated to {v}, want an error containing {want:?}"),
            Err(e) => assert!(
                e.message.contains(want),
                "{expr:?}: {:?} does not contain {want:?}",
                e.message
            ),
        }
    }
}

#[test]
fn references_renames_literals_and_names() {
    let v = vectors();
    for c in v["refs"].as_array().expect("refs") {
        let mut got = extract_refs(c["expr"].as_str().expect("expr")).expect("parses");
        got.sort();
        let want: Vec<String> = serde_json::from_value(c["refs"].clone()).expect("refs");
        assert_eq!(got, want, "{}", c["expr"]);
    }
    for c in v["rename"].as_array().expect("rename") {
        let s = |k: &str| c[k].as_str().expect("string");
        assert_eq!(
            rename_refs(s("expr"), s("from"), s("to")).expect("renames"),
            s("expect")
        );
    }
    for c in v["numericLiteral"].as_array().expect("numericLiteral") {
        assert_eq!(
            is_numeric_literal(c["expr"].as_str().expect("expr")),
            c["expect"].as_bool().expect("bool"),
            "{}",
            c["expr"]
        );
    }
    let names = |section: &str, key: &str| -> Vec<String> {
        serde_json::from_value(v[section][key].clone()).expect("names")
    };
    names("reserved", "yes")
        .iter()
        .for_each(|n| assert!(is_reserved_name(n), "{n}"));
    names("reserved", "no")
        .iter()
        .for_each(|n| assert!(!is_reserved_name(n), "{n}"));
    names("identNames", "yes")
        .iter()
        .for_each(|n| assert!(is_ident_name(n), "{n}"));
    names("identNames", "no")
        .iter()
        .for_each(|n| assert!(!is_ident_name(n), "{n}"));
}

#[test]
fn table_resolution() {
    for c in vectors()["recompute"].as_array().expect("recompute") {
        let name = c["name"].as_str().expect("name");
        let r = resolve(&defs(&c["defs"]));
        let want = scope(&c["values"]);
        assert_eq!(r.values.len(), want.len(), "{name}");
        for (k, w) in &want {
            assert!(
                r.values.get(k).is_some_and(|g| g == w),
                "{name}: {k} = {:?}, want {w}",
                r.values.get(k)
            );
        }
        let issues = c["issues"].as_object().expect("issues");
        assert_eq!(r.issues.len(), issues.len(), "{name}: {:?}", r.issues);
        for (k, w) in issues {
            let got = r
                .issues
                .get(k)
                .unwrap_or_else(|| panic!("{name}: no issue for {k}"));
            assert!(
                got.contains(w.as_str().expect("issue")),
                "{name}: {k}: {got:?}"
            );
        }
    }
}

#[test]
fn validation_and_checks() {
    let v = vectors();
    for group in v["validate"].as_array().expect("validate") {
        let table = defs(&group["defs"]);
        for c in group["cases"].as_array().expect("cases") {
            let expr = c["expr"].as_str().expect("expr");
            let kind = (c["kind"].as_str() == Some("count")).then_some(FieldKind::Count);
            let got = validate_expr(&table, c["name"].as_str(), expr, kind);
            match (&got, c.get("ok"), c["error"].as_str()) {
                (Ok(value), Some(ok), _) => assert_eq!(Some(*value), ok.as_f64(), "{expr}"),
                (Err(e), None, Some(want)) => {
                    assert!(e.contains(want), "{expr}: {e:?} lacks {want:?}")
                }
                _ => panic!("{expr}: got {got:?}"),
            }
        }
    }
    for group in v["checks"].as_array().expect("checks") {
        let checks: Vec<ParamCheck> =
            serde_json::from_value(group["checks"].clone()).expect("checks");
        let got = check_results(&defs(&group["defs"]), &checks);
        for (g, want) in got
            .iter()
            .zip(group["results"].as_array().expect("results"))
        {
            assert_eq!(g.ok, want["ok"].as_bool().expect("ok"));
            match (&g.error, want["error"].as_str()) {
                (None, None) => {}
                (Some(e), Some(w)) => assert!(e.contains(w), "{e:?} lacks {w:?}"),
                other => panic!("error mismatch {other:?}"),
            }
        }
    }
}
