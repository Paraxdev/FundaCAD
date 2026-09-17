//! The parameter expression language, held to the app's. A port of
//! `plugins/FundaCAD.MCP/tests/test_expr.py`.
//!
//! The MCP server no longer carries its own evaluator, it uses
//! `fundacad-core::params`, which is the Rust twin of `src/params/{parse,eval}.ts`.
//! That makes this suite a seam test rather than a unit one, and it is worth
//! keeping for exactly that: an agent that writes `hub_d/2 - wall` into a
//! document and a user who opens that document in the app must get the same
//! number, or the file is a lie.

use fundacad_core::params::{eval_expr, is_reserved_name, parse_expr, refs_of, Scope};

struct Vals(Vec<(&'static str, f64)>);

impl Scope for Vals {
    fn get(&self, name: &str) -> Option<f64> {
        self.0.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
    }
}

fn ev(src: &str) -> f64 {
    eval_expr(src, &Vals(Vec::new())).expect(src)
}

fn ev_with(src: &str, values: &[(&'static str, f64)]) -> f64 {
    eval_expr(src, &Vals(values.to_vec())).expect(src)
}

fn refused(src: &str, values: &[(&'static str, f64)]) -> bool {
    eval_expr(src, &Vals(values.to_vec())).is_err()
}

fn close(a: f64, b: f64, tol: f64) {
    assert!((a - b).abs() < tol, "{a} != {b}");
}

fn names(src: &str) -> Vec<String> {
    let mut out = refs_of(&parse_expr(src).expect(src));
    out.sort();
    out
}

#[test]
fn arithmetic_and_precedence() {
    close(ev("1 + 2 * 3"), 7.0, 1e-9);
    close(ev("(1 + 2) * 3"), 9.0, 1e-9);
    close(ev("10 / 4"), 2.5, 1e-9);
    close(ev("-3 + 1"), -2.0, 1e-9);
}

#[test]
fn power_is_right_associative_and_binds_tighter_than_unary_minus() {
    // Straight from the TypeScript comment: -2^2 = -(2^2) = -4, and
    // 2^3^2 = 2^(3^2) = 512. A left-associative or looser-binding port would
    // give +4 and 64, both perfectly plausible numbers.
    close(ev("-2^2"), -4.0, 1e-9);
    close(ev("2^3^2"), 512.0, 1e-9);
    close(ev("2^-1"), 0.5, 1e-9);
}

#[test]
fn trig_is_in_degrees() {
    // The single most consequential convention here. sin(30) is 0.5, not
    // -0.988: a port that reached for the radian sine directly would put a hole
    // 3 mm from where the app puts it and nothing would look wrong.
    close(ev("sin(30)"), 0.5, 1e-12);
    close(ev("cos(60)"), 0.5, 1e-12);
    close(ev("asin(0.5)"), 30.0, 1e-9);
}

#[test]
fn unit_suffixes_convert_at_parse_time() {
    close(ev("1cm"), 10.0, 1e-9);
    close(ev("1in"), 25.4, 1e-9);
    close(ev("2cm + 5mm"), 25.0, 1e-9);
    close(ev("1rad"), 180.0 / std::f64::consts::PI, 1e-9);
    close(ev("sin(1rad)"), 1.0f64.sin(), 1e-12);
}

#[test]
fn a_unit_suffix_only_binds_to_a_number() {
    // `2cm` is a literal; `x cm` is not, and must not silently become one.
    close(ev("2cm"), 20.0, 1e-9);
    assert!(
        refused("x mm", &[("x", 2.0)]),
        "an identifier followed by a unit was accepted"
    );
}

#[test]
fn arguments_are_separated_by_semicolons() {
    close(ev("max(3; 7)"), 7.0, 1e-9);
    close(ev("min(3; 7; 2)"), 2.0, 1e-9);
    assert!(
        refused("max(3, 7)", &[]),
        "a comma-separated argument list was accepted"
    );
}

#[test]
fn references_and_constants() {
    close(ev_with("d / 2", &[("d", 54.0)]), 27.0, 1e-9);
    close(ev("PI"), std::f64::consts::PI, 1e-12);
    assert_eq!(names("a + b*2 + PI"), ["a", "b"]);
}

#[test]
fn an_unknown_name_is_an_error_but_a_division_by_zero_is_not() {
    // The frontend's split, kept exactly: structure refuses, arithmetic does
    // not. A parameter halfway through being typed evaluates to infinity and is
    // caught at the gate; a parameter that names nothing can never be right.
    assert!(refused("nope + 1", &[]), "an unknown parameter was accepted");
    assert_eq!(ev("1/0"), f64::INFINITY);
    assert!(ev("0/0").is_nan());
}

#[test]
fn arity_is_checked() {
    for src in ["sqrt(1; 2)", "max(1)"] {
        assert!(refused(src, &[]), "{src} was accepted");
    }
}

#[test]
fn comparisons_and_logic_match_the_app() {
    // Same cases as tests/params/expr.test.ts. The tolerance on == is the one
    // that would drift silently: bit equality says 0.1 + 0.2 != 0.3, and a
    // feature gated on it would build in one program and not the other.
    let cases: &[(&str, f64)] = &[
        ("3 > 2", 1.0),
        ("3 < 2", 0.0),
        ("2 <= 2", 1.0),
        ("2 >= 3", 0.0),
        ("1 + 1 == 2", 1.0),
        ("0.1 + 0.2 == 0.3", 1.0),
        ("0.1 + 0.2 != 0.3", 0.0),
        ("1 == 1.001", 0.0),
        ("0 || 0 && 1", 0.0),
        ("1 || 0 && 0", 1.0),
        ("!0 + !5", 1.0),
        ("(2 > 1) * 10", 10.0),
    ];
    for (src, want) in cases {
        close(ev(src), *want, 1e-9);
    }
    close(ev_with("a > 1 && b < 5", &[("a", 2.0), ("b", 4.0)]), 1.0, 1e-9);
    close(ev_with("a > 1 && b < 5", &[("a", 0.0), ("b", 4.0)]), 0.0, 1e-9);
    close(ev_with("a > 1 || b < 5", &[("a", 0.0), ("b", 4.0)]), 1.0, 1e-9);
    for src in ["1 < 2 < 3", "1 & 2"] {
        assert!(refused(src, &[]), "{src} was accepted");
    }
}

#[test]
fn if_picks_a_branch_and_nan_never_picks_one() {
    close(ev_with("if(solid == 1; 0; 2.4)", &[("solid", 1.0)]), 0.0, 1e-9);
    close(ev_with("if(solid == 1; 0; 2.4)", &[("solid", 0.0)]), 2.4, 1e-9);
    close(ev("if(-3; 1; 2)"), 1.0, 1e-9);
    close(ev_with("if(n > 0; n; 1) * 2", &[("n", 0.0)]), 2.0, 1e-9);
    assert!(ev("if(sqrt(-1); 1; 2)").is_nan());
    assert!(ev("sqrt(-1) > 0").is_nan());
    assert!(ev("!sqrt(-1)").is_nan());
    assert_eq!(names("if(a > b; c; !d)"), ["a", "b", "c", "d"]);
    assert!(refused("if(1; 2)", &[]), "if with two arguments was accepted");
}

#[test]
fn reserved_names() {
    assert!(is_reserved_name("sin") && is_reserved_name("mm") && is_reserved_name("PI"));
    assert!(
        is_reserved_name("log"),
        "reserved-but-unimplemented names are still reserved"
    );
    assert!(!is_reserved_name("hub_d"));
}

#[test]
fn nothing_is_evaluated_that_is_not_arithmetic() {
    // The parser is a parser. Anything a scripting language would happily
    // execute has to be a syntax error here, not a result.
    for src in ["__import__('os')", "1 if 1 else 2", "[1,2][0]", "a.b"] {
        assert!(
            refused(src, &[("a", 1.0)]),
            "{src:?} evaluated instead of being refused"
        );
    }
}
