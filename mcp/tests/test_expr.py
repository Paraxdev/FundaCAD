"""The expression language, held to the TypeScript it is a port of.

Every case here is a case where getting it wrong would be silent: the
expression still evaluates, it just gives a different number than the same text
gives in the app. A parametric document that means one thing to the agent that
wrote it and another to the person who opens it is worse than one that fails.

Run: uv run python mcp/tests/test_expr.py
"""

import _bootstrap  # noqa: F401
import _run

import math

from expr import ExprError, evaluate, is_reserved_name, parse_expr, refs_of


def close(a, b, tol=1e-9):
    assert abs(a - b) < tol, f"{a} != {b}"


def test_arithmetic_and_precedence():
    close(evaluate("1 + 2 * 3"), 7)
    close(evaluate("(1 + 2) * 3"), 9)
    close(evaluate("10 / 4"), 2.5)
    close(evaluate("-3 + 1"), -2)


def test_power_is_right_associative_and_binds_tighter_than_unary_minus():
    """Straight from the TypeScript comment: -2^2 = -(2^2) = -4, and
    2^3^2 = 2^(3^2) = 512. A left-associative or looser-binding port would give
    +4 and 64, both perfectly plausible numbers."""
    close(evaluate("-2^2"), -4)
    close(evaluate("2^3^2"), 512)
    close(evaluate("2^-1"), 0.5)


def test_trig_is_in_DEGREES():
    """The single most consequential convention here. sin(30) is 0.5, not
    -0.988: a port that reached for math.sin directly would put a hole 3mm from
    where the app puts it and nothing would look wrong."""
    close(evaluate("sin(30)"), 0.5, 1e-12)
    close(evaluate("cos(60)"), 0.5, 1e-12)
    close(evaluate("asin(0.5)"), 30, 1e-9)


def test_unit_suffixes_convert_at_parse_time():
    close(evaluate("1cm"), 10)
    close(evaluate("1in"), 25.4)
    close(evaluate("2cm + 5mm"), 25)
    close(evaluate("1rad"), 180 / math.pi)
    close(evaluate("sin(1rad)"), math.sin(1.0), 1e-12)


def test_a_unit_suffix_only_binds_to_a_NUMBER():
    """`2cm` is a literal; `x cm` is not, and must not silently become one."""
    close(evaluate("2cm"), 20)
    try:
        evaluate("x mm", {"x": 2})
    except ExprError:
        return
    raise AssertionError("an identifier followed by a unit was accepted")


def test_arguments_are_separated_by_SEMICOLONS():
    close(evaluate("max(3; 7)"), 7)
    close(evaluate("min(3; 7; 2)"), 2)
    try:
        evaluate("max(3, 7)")
    except ExprError:
        return
    raise AssertionError("a comma-separated argument list was accepted")


def test_references_and_constants():
    close(evaluate("d / 2", {"d": 54}), 27)
    close(evaluate("PI"), math.pi)
    assert refs_of(parse_expr("a + b*2 + PI")) == {"a", "b"}


def test_an_unknown_name_is_an_error_but_a_division_by_zero_is_not():
    """The frontend's split, kept exactly: structure raises, arithmetic does not.
    A parameter halfway through being typed evaluates to infinity and is caught
    at the gate; a parameter that names nothing can never be right."""
    try:
        evaluate("nope + 1")
    except ExprError:
        pass
    else:
        raise AssertionError("an unknown parameter was accepted")
    assert evaluate("1/0") == math.inf
    assert math.isnan(evaluate("0/0"))


def test_arity_is_checked():
    for src in ("sqrt(1; 2)", "max(1)"):
        try:
            evaluate(src)
        except ExprError:
            continue
        raise AssertionError(f"{src} was accepted")


def test_reserved_names():
    assert is_reserved_name("sin") and is_reserved_name("mm") and is_reserved_name("PI")
    assert is_reserved_name("log"), "reserved-but-unimplemented names are still reserved"
    assert not is_reserved_name("hub_d")


def test_nothing_is_eval_ed():
    """The parser is a parser. Anything Python would happily execute has to be a
    syntax error here, not a result."""
    for src in ("__import__('os')", "1 if 1 else 2", "[1,2][0]", "a.b"):
        try:
            evaluate(src, {"a": 1})
        except ExprError:
            continue
        raise AssertionError(f"{src!r} evaluated instead of being refused")


if __name__ == "__main__":
    _run.run(globals(), "expressions")
