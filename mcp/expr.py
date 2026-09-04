"""The parameter expression language, in Python.

A port of src/params/parse.ts + src/params/eval.ts, and it has to stay a port:
an agent that writes `hub_d/2 - wall` into a document and a user who opens that
document in the app must get the same number, or the file is a lie. So the
grammar, the operator precedence, the unit suffixes, the function list and the
DEGREES convention for trig are all copied deliberately rather than reinvented
in whatever shape Python makes convenient.

The two rules easiest to get wrong, both taken from the TypeScript:

  * `^` is right-associative and binds tighter than unary minus, so -2^2 is -4.
  * function arguments are separated by SEMICOLONS, not commas — the frontend
    chose that because a comma is ambiguous where the decimal separator is one.

No eval(), no compile(): this parses. An expression arriving over MCP is
untrusted input, and "it is only arithmetic" is exactly what every sandbox
escape through eval() has been.
"""

import math

#: unit suffix -> factor into the canonical unit of its dimension (mm, degrees)
UNITS = {
    "mm": (1.0, "length"),
    "cm": (10.0, "length"),
    "in": (25.4, "length"),
    "deg": (1.0, "angle"),
    "rad": (180.0 / math.pi, "angle"),
}

#: Trig takes and returns DEGREES, matching the frontend. A `rad` literal is how
#: radians get in.
FUNCTIONS = {
    "sin": ((1, 1), lambda a: math.sin(math.radians(a[0]))),
    "cos": ((1, 1), lambda a: math.cos(math.radians(a[0]))),
    "tan": ((1, 1), lambda a: math.tan(math.radians(a[0]))),
    "asin": ((1, 1), lambda a: math.degrees(math.asin(a[0]))),
    "acos": ((1, 1), lambda a: math.degrees(math.acos(a[0]))),
    "atan": ((1, 1), lambda a: math.degrees(math.atan(a[0]))),
    "floor": ((1, 1), lambda a: math.floor(a[0])),
    "ceil": ((1, 1), lambda a: math.ceil(a[0])),
    "round": ((1, 1), lambda a: float(round(a[0]))),
    "abs": ((1, 1), lambda a: abs(a[0])),
    "sqrt": ((1, 1), lambda a: math.sqrt(a[0])),
    "min": ((2, None), min),
    "max": ((2, None), max),
}

RESERVED_FUNCTIONS = {
    "if", "pow", "ln", "log", "exp", "sign", "random", "sinh", "cosh", "tanh",
}

CONSTANTS = {"PI": math.pi}


class ExprError(ValueError):
    """A structural problem: an unknown name, a bad arity, a syntax error.

    Arithmetic is NOT structural — a division by zero yields inf and the caller
    decides, exactly as the frontend does, because a parameter that briefly
    evaluates to inf while it is being typed is not an error worth refusing."""


def is_reserved_name(name):
    return name in FUNCTIONS or name in RESERVED_FUNCTIONS or name in UNITS or name in CONSTANTS


_IDENT_START = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_")
_IDENT_PART = _IDENT_START | set("0123456789")
_OPS = set("+-*/^();")


def tokenize(src):
    out = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch in " \t":
            i += 1
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and src[i + 1].isdigit()):
            j = i
            while j < n and (src[j].isdigit() or src[j] == "."):
                j += 1
            try:
                out.append(("num", float(src[i:j]), i))
            except ValueError:
                raise ExprError(f"bad number at {i}", i)
            i = j
            continue
        if ch in _IDENT_START:
            j = i
            while j < n and src[j] in _IDENT_PART:
                j += 1
            out.append(("ident", src[i:j], i))
            i = j
            continue
        if ch in _OPS:
            out.append(("op", ch, i))
            i += 1
            continue
        raise ExprError(f"unexpected character {ch!r} at {i}", i)
    return out


class _Parser:
    def __init__(self, tokens):
        self.t = tokens
        self.i = 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take_op(self, op):
        tok = self.peek()
        if tok and tok[0] == "op" and tok[1] == op:
            self.i += 1
            return True
        return False

    def parse(self):
        node = self.add()
        if self.i != len(self.t):
            tok = self.t[self.i]
            raise ExprError(f"unexpected {tok[1]!r} at {tok[2]}", tok[2])
        return node

    def add(self):
        node = self.mul()
        while True:
            for op in ("+", "-"):
                if self.take_op(op):
                    node = ("bin", op, node, self.mul())
                    break
            else:
                return node

    def mul(self):
        node = self.unary()
        while True:
            for op in ("*", "/"):
                if self.take_op(op):
                    node = ("bin", op, node, self.unary())
                    break
            else:
                return node

    def unary(self):
        if self.take_op("-"):
            return ("neg", self.unary())
        return self.pow()

    def pow(self):
        base = self.primary()
        # right-associative, and the exponent may itself be unary: 2^-1
        if self.take_op("^"):
            return ("bin", "^", base, self.unary())
        return base

    def primary(self):
        tok = self.peek()
        if tok is None:
            raise ExprError("expression ended early")
        kind, val, pos = tok
        if kind == "num":
            self.i += 1
            nxt = self.peek()
            if nxt and nxt[0] == "ident" and nxt[1] in UNITS:
                self.i += 1
                return ("num", val * UNITS[nxt[1]][0])
            return ("num", val)
        if kind == "ident":
            self.i += 1
            if self.take_op("("):
                args = []
                if not self.take_op(")"):
                    args.append(self.add())
                    while self.take_op(";"):
                        args.append(self.add())
                    if not self.take_op(")"):
                        raise ExprError(f"missing ) in {val}(...)", pos)
                return ("call", val, args, pos)
            return ("ref", val, pos)
        if val == "(":
            self.i += 1
            node = self.add()
            if not self.take_op(")"):
                raise ExprError("missing )", pos)
            return node
        raise ExprError(f"unexpected {val!r} at {pos}", pos)


def parse_expr(src):
    """The AST for one expression, or ExprError."""
    if not isinstance(src, str) or not src.strip():
        raise ExprError("empty expression")
    return _Parser(tokenize(src)).parse()


def refs_of(node, out=None):
    """Every parameter name an expression reads. Constants are not references —
    PI resolves without anyone defining it, and treating it as a reference would
    make every expression using it look broken."""
    out = set() if out is None else out
    t = node[0]
    if t == "ref":
        if node[1] not in CONSTANTS:
            out.add(node[1])
    elif t == "neg":
        refs_of(node[1], out)
    elif t == "bin":
        refs_of(node[2], out)
        refs_of(node[3], out)
    elif t == "call":
        for a in node[2]:
            refs_of(a, out)
    return out


def eval_node(node, values):
    t = node[0]
    if t == "num":
        return node[1]
    if t == "ref":
        name = node[1]
        if name in values:
            return float(values[name])
        if name in CONSTANTS:
            return CONSTANTS[name]
        raise ExprError(f"unknown parameter {name!r}", node[2])
    if t == "neg":
        return -eval_node(node[1], values)
    if t == "bin":
        op = node[1]
        a = eval_node(node[2], values)
        b = eval_node(node[3], values)
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            # Never raises: matches the frontend, where a non-finite result is
            # rejected at the gate rather than at the arithmetic.
            if b == 0:
                return math.inf if a > 0 else (-math.inf if a < 0 else math.nan)
            return a / b
        if op == "^":
            try:
                return float(a) ** float(b)
            except (OverflowError, ValueError):
                return math.nan
    if t == "call":
        name, args, pos = node[1], node[2], node[3]
        fn = FUNCTIONS.get(name)
        if fn is None:
            raise ExprError(f"unknown function {name!r}", pos)
        (lo, hi), apply = fn
        vals = [eval_node(a, values) for a in args]
        if len(vals) < lo or (hi is not None and len(vals) > hi):
            want = f"{lo}" if hi == lo else f"{lo}..{'many' if hi is None else hi}"
            raise ExprError(f"{name} takes {want} arguments, got {len(vals)}", pos)
        try:
            return float(apply(vals))
        except (ValueError, OverflowError):
            return math.nan
    raise ExprError(f"cannot evaluate {t}")


def evaluate(src, values=None):
    """Parse and evaluate in one go, for a caller with no table to build."""
    return eval_node(parse_expr(src), values or {})
