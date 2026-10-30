//! The expression parser refuses nesting and length past its limits with an error, so no document can exhaust the
//! stack of the process that parses or evaluates it.

use fundacad_core::params::parse::{parse_expr, tokenize, MAX_EXPR_DEPTH, MAX_EXPR_LEN};
use fundacad_core::params::{eval_expr, refs_of};
use indexmap::IndexMap;

fn refused(src: &str) -> String {
    parse_expr(src).expect_err("expression should be refused").message
}

fn nested(open: &str, inner: &str, close: &str, n: usize) -> String {
    format!("{}{inner}{}", open.repeat(n), close.repeat(n))
}

#[test]
fn deep_parentheses_are_refused() {
    assert!(refused(&nested("(", "1", ")", 100_000)).contains("longer than"));
    assert!(refused(&nested("(", "1", ")", MAX_EXPR_DEPTH + 1)).contains("nests deeper than"));
}

#[test]
fn deep_unary_operators_are_refused() {
    assert!(refused(&nested("-", "1", "", MAX_EXPR_DEPTH + 1)).contains("nests deeper than"));
    assert!(refused(&nested("!", "1", "", MAX_EXPR_DEPTH + 1)).contains("nests deeper than"));
}

#[test]
fn deep_call_arguments_and_powers_are_refused() {
    assert!(refused(&nested("max(1;", "1", ")", MAX_EXPR_DEPTH + 1)).contains("nests deeper than"));
    assert!(refused(&nested("2^", "2", "", MAX_EXPR_DEPTH + 1)).contains("nests deeper than"));
}

#[test]
fn a_long_flat_expression_is_refused() {
    let src = vec!["1"; MAX_EXPR_LEN / 2 + 1].join("+");
    assert!(src.chars().count() > MAX_EXPR_LEN);
    assert!(refused(&src).contains("longer than"));
    assert!(tokenize(&src).is_err());
}

#[test]
fn expressions_at_the_limits_parse_and_evaluate_on_a_small_stack() {
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(|| {
            let scope: IndexMap<String, f64> = IndexMap::new();
            let depth = MAX_EXPR_DEPTH - 1;
            assert_eq!(eval_expr(&nested("(", "1", ")", depth), &scope), Ok(1.0));
            assert_eq!(eval_expr(&nested("max(1;", "1", ")", depth), &scope), Ok(1.0));
            assert_eq!(eval_expr(&nested("-", "1", "", depth), &scope), Ok(-1.0));
            let flat = vec!["1"; MAX_EXPR_LEN / 2].join("+");
            assert!(flat.chars().count() <= MAX_EXPR_LEN);
            assert_eq!(eval_expr(&flat, &scope), Ok((MAX_EXPR_LEN / 2) as f64));
            assert!(refs_of(&parse_expr(&flat).unwrap()).is_empty());
        })
        .unwrap()
        .join()
        .unwrap();
}
