//! Tokenizer and parser for parameter expressions, a port of `src/params/parse.ts`
//! (twinned in Python by plugins/FundaCAD.MCP/expr.py).
//!
//! Grammar, loosest first:
//! `or := and ('||' and)*`, `and := cmp ('&&' cmp)*`,
//! `cmp := add (('<'|'<='|'>'|'>='|'=='|'!=') add)?` (does not chain),
//! `add := mul (('+'|'-') mul)*`, `mul := unary (('*'|'/') unary)*`,
//! `unary := '-' unary | '!' unary | pow`, `pow := primary ('^' unary)?`,
//! `primary := NUMBER unit? | IDENT '(' expr (';' expr)* ')' | IDENT | '(' expr ')'`.
//! So `^` is right associative and `-2^2` is `-(2^2)`. Arguments are separated
//! by semicolons because a comma is a decimal separator in many locales.

use std::fmt;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct ExprError {
    pub message: String,
    /// Character offset of the problem, when there is one to point at.
    pub pos: Option<usize>,
}

impl ExprError {
    pub(crate) fn new(message: impl Into<String>, pos: Option<usize>) -> Self {
        ExprError {
            message: message.into(),
            pos,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dim {
    Length,
    Angle,
}

/// Unit suffix, factor into its dimension's canonical unit (mm, degrees).
pub const UNITS: &[(&str, f64, Dim)] = &[
    ("mm", 1.0, Dim::Length),
    ("cm", 10.0, Dim::Length),
    ("in", 25.4, Dim::Length),
    ("deg", 1.0, Dim::Angle),
    ("rad", 180.0 / std::f64::consts::PI, Dim::Angle),
];

pub fn unit(name: &str) -> Option<(f64, Dim)> {
    UNITS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, f, d)| (*f, *d))
}

/// Implemented functions and their arity, `None` meaning unbounded.
pub const FUNCTIONS: &[(&str, usize, Option<usize>)] = &[
    ("sin", 1, Some(1)),
    ("cos", 1, Some(1)),
    ("tan", 1, Some(1)),
    ("asin", 1, Some(1)),
    ("acos", 1, Some(1)),
    ("atan", 1, Some(1)),
    ("floor", 1, Some(1)),
    ("ceil", 1, Some(1)),
    ("round", 1, Some(1)),
    ("abs", 1, Some(1)),
    ("sqrt", 1, Some(1)),
    ("min", 2, None),
    ("max", 2, None),
    ("if", 3, Some(3)),
];

/// Names kept free for future functions, so no parameter can shadow one.
pub const RESERVED_FUNCTIONS: &[&str] = &[
    "pow", "ln", "log", "exp", "sign", "random", "sinh", "cosh", "tanh",
];

pub const CONSTANTS: &[(&str, f64)] = &[("PI", std::f64::consts::PI)];

pub fn constant(name: &str) -> Option<f64> {
    CONSTANTS.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

/// Every name a user parameter may not take.
pub fn is_reserved_name(name: &str) -> bool {
    FUNCTIONS.iter().any(|(n, _, _)| *n == name)
        || RESERVED_FUNCTIONS.contains(&name)
        || unit(name).is_some()
        || constant(name).is_some()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Num {
        value: f64,
        start: usize,
        end: usize,
    },
    Ident {
        name: String,
        start: usize,
        end: usize,
    },
    Op {
        op: &'static str,
        start: usize,
        end: usize,
    },
}

impl Token {
    fn start(&self) -> usize {
        match self {
            Token::Num { start, .. } | Token::Ident { start, .. } | Token::Op { start, .. } => {
                *start
            }
        }
    }

    fn end(&self) -> usize {
        match self {
            Token::Num { end, .. } | Token::Ident { end, .. } | Token::Op { end, .. } => *end,
        }
    }
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Token::Num { value, .. } => f.write_str(&js_number(*value)),
            Token::Ident { name, .. } => f.write_str(name),
            Token::Op { op, .. } => f.write_str(op),
        }
    }
}

/// A number the way JavaScript prints it, for messages that quote a literal.
fn js_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{v:.0}")
    } else {
        format!("{v}")
    }
}

const TWO_CHAR_OPS: &[&str] = &["<=", ">=", "==", "!=", "&&", "||"];
const ONE_CHAR_OPS: &[&str] = &["+", "-", "*", "/", "^", "(", ")", ";", "<", ">", "!"];

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

pub fn tokenize(src: &str) -> Result<Vec<Token>, ExprError> {
    let chars: Vec<char> = src.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let digit = |i: usize| at(i).is_some_and(|c| c.is_ascii_digit());
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == ' ' || ch == '\t' {
            i += 1;
            continue;
        }
        if ch.is_ascii_digit() || (ch == '.' && digit(i + 1)) {
            let start = i;
            while digit(i) || at(i) == Some('.') {
                i += 1;
            }
            if matches!(at(i), Some('e' | 'E')) {
                let mut j = i + 1;
                if matches!(at(j), Some('+' | '-')) {
                    j += 1;
                }
                if digit(j) {
                    i = j;
                    while digit(i) {
                        i += 1;
                    }
                }
            }
            let text: String = chars[start..i].iter().collect();
            match text.parse::<f64>() {
                Ok(value) if value.is_finite() => out.push(Token::Num {
                    value,
                    start,
                    end: i,
                }),
                _ => {
                    return Err(ExprError::new(
                        format!("invalid number \"{text}\""),
                        Some(start),
                    ))
                }
            }
            continue;
        }
        if is_ident_start(ch) {
            let start = i;
            while at(i).is_some_and(is_ident_part) {
                i += 1;
            }
            if at(i) == Some('.') {
                return Err(ExprError::new(
                    "qualified names ('.') are not supported",
                    Some(i),
                ));
            }
            out.push(Token::Ident {
                name: chars[start..i].iter().collect(),
                start,
                end: i,
            });
            continue;
        }
        let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
        if let Some(op) = TWO_CHAR_OPS.iter().find(|o| **o == two) {
            out.push(Token::Op {
                op,
                start: i,
                end: i + 2,
            });
            i += 2;
            continue;
        }
        let one = ch.to_string();
        if let Some(op) = ONE_CHAR_OPS.iter().find(|o| **o == one) {
            out.push(Token::Op {
                op,
                start: i,
                end: i + 1,
            });
            i += 1;
            continue;
        }
        return Err(ExprError::new(
            format!("unexpected character \"{ch}\""),
            Some(i),
        ));
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    And,
    Or,
}

impl BinOp {
    pub fn is_truth(self) -> bool {
        !matches!(
            self,
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Pow
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// Already in canonical units; `unit` keeps the suffix it was written with.
    Num {
        v: f64,
        unit: Option<&'static str>,
    },
    Ref(String),
    Call {
        name: String,
        args: Vec<Expr>,
    },
    Bin {
        op: BinOp,
        l: Box<Expr>,
        r: Box<Expr>,
    },
    Neg(Box<Expr>),
    Not(Box<Expr>),
}

const CMP_OPS: &[(&str, BinOp)] = &[
    ("<=", BinOp::Le),
    (">=", BinOp::Ge),
    ("==", BinOp::Eq),
    ("!=", BinOp::Ne),
    ("<", BinOp::Lt),
    (">", BinOp::Gt),
];

struct Parser {
    toks: Vec<Token>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.toks.get(self.i)
    }

    fn take_op(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Some(Token::Op { op: o, .. }) if *o == op) {
            self.i += 1;
            return true;
        }
        false
    }

    fn parse(mut self) -> Result<Expr, ExprError> {
        if self.toks.is_empty() {
            return Err(ExprError::new("empty expression", None));
        }
        let node = self.or()?;
        if let Some(left) = self.peek() {
            return Err(ExprError::new(
                format!("unexpected \"{left}\""),
                Some(left.start()),
            ));
        }
        Ok(node)
    }

    fn bin(op: BinOp, l: Expr, r: Expr) -> Expr {
        Expr::Bin {
            op,
            l: Box::new(l),
            r: Box::new(r),
        }
    }

    fn or(&mut self) -> Result<Expr, ExprError> {
        let mut l = self.and()?;
        while self.take_op("||") {
            l = Self::bin(BinOp::Or, l, self.and()?);
        }
        Ok(l)
    }

    fn and(&mut self) -> Result<Expr, ExprError> {
        let mut l = self.cmp()?;
        while self.take_op("&&") {
            l = Self::bin(BinOp::And, l, self.cmp()?);
        }
        Ok(l)
    }

    fn cmp(&mut self) -> Result<Expr, ExprError> {
        let l = self.add()?;
        let Some(op) = CMP_OPS
            .iter()
            .find(|(text, _)| self.take_op(text))
            .map(|(_, op)| *op)
        else {
            return Ok(l);
        };
        let node = Self::bin(op, l, self.add()?);
        if let Some(Token::Op { op, start, .. }) = self.peek() {
            if CMP_OPS.iter().any(|(text, _)| text == op) {
                return Err(ExprError::new(
                    "comparisons do not chain, join them with &&",
                    Some(*start),
                ));
            }
        }
        Ok(node)
    }

    fn add(&mut self) -> Result<Expr, ExprError> {
        let mut l = self.mul()?;
        loop {
            if self.take_op("+") {
                l = Self::bin(BinOp::Add, l, self.mul()?);
            } else if self.take_op("-") {
                l = Self::bin(BinOp::Sub, l, self.mul()?);
            } else {
                return Ok(l);
            }
        }
    }

    fn mul(&mut self) -> Result<Expr, ExprError> {
        let mut l = self.unary()?;
        loop {
            if self.take_op("*") {
                l = Self::bin(BinOp::Mul, l, self.unary()?);
            } else if self.take_op("/") {
                l = Self::bin(BinOp::Div, l, self.unary()?);
            } else {
                return Ok(l);
            }
        }
    }

    fn unary(&mut self) -> Result<Expr, ExprError> {
        if self.take_op("-") {
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.take_op("!") {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        self.pow()
    }

    fn pow(&mut self) -> Result<Expr, ExprError> {
        let base = self.primary()?;
        if self.take_op("^") {
            return Ok(Self::bin(BinOp::Pow, base, self.unary()?));
        }
        Ok(base)
    }

    fn primary(&mut self) -> Result<Expr, ExprError> {
        let Some(t) = self.peek().cloned() else {
            return Err(ExprError::new("unexpected end of expression", None));
        };
        match t {
            Token::Num { value, .. } => {
                self.i += 1;
                if let Some(Token::Ident { name, .. }) = self.peek() {
                    if let Some((text, factor, _)) = UNITS.iter().find(|(n, _, _)| n == name) {
                        self.i += 1;
                        return Ok(Expr::Num {
                            v: value * factor,
                            unit: Some(text),
                        });
                    }
                }
                Ok(Expr::Num {
                    v: value,
                    unit: None,
                })
            }
            Token::Ident { ref name, end, .. } => {
                self.i += 1;
                if self.take_op("(") {
                    let mut args = vec![self.or()?];
                    while self.take_op(";") {
                        args.push(self.or()?);
                    }
                    if !self.take_op(")") {
                        let pos = self.peek().map_or(end, Token::start);
                        return Err(ExprError::new(
                            format!("missing \")\" in {name}(\u{2026})"),
                            Some(pos),
                        ));
                    }
                    return Ok(Expr::Call {
                        name: name.clone(),
                        args,
                    });
                }
                Ok(Expr::Ref(name.clone()))
            }
            Token::Op { op: "(", .. } => {
                self.i += 1;
                let inner = self.or()?;
                if !self.take_op(")") {
                    let pos = self.peek().map_or(t.end(), Token::start);
                    return Err(ExprError::new("missing \")\"", Some(pos)));
                }
                Ok(inner)
            }
            Token::Op { op, start, .. } => {
                Err(ExprError::new(format!("unexpected \"{op}\""), Some(start)))
            }
        }
    }
}

pub fn parse_expr(src: &str) -> Result<Expr, ExprError> {
    Parser {
        toks: tokenize(src)?,
        i: 0,
    }
    .parse()
}

/// Parameter names a parsed expression references, first use first, constants excluded.
pub fn refs_of(node: &Expr) -> Vec<String> {
    fn walk(n: &Expr, out: &mut Vec<String>) {
        match n {
            Expr::Ref(name) => {
                if constant(name).is_none() && !out.contains(name) {
                    out.push(name.clone());
                }
            }
            Expr::Call { args, .. } => args.iter().for_each(|a| walk(a, out)),
            Expr::Bin { l, r, .. } => {
                walk(l, out);
                walk(r, out);
            }
            Expr::Neg(e) | Expr::Not(e) => walk(e, out),
            Expr::Num { .. } => {}
        }
    }
    let mut out = Vec::new();
    walk(node, &mut out);
    out
}

pub fn extract_refs(src: &str) -> Result<Vec<String>, ExprError> {
    parse_expr(src).map(|n| refs_of(&n))
}

pub fn is_ident_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(is_ident_start) && chars.all(is_ident_part)
}

/// Rewrites every reference to `from` as `to`, token by token so `width` never
/// hits `widths`, a unit suffix or a function name, keeping the rest verbatim.
pub fn rename_refs(src: &str, from: &str, to: &str) -> Result<String, ExprError> {
    let toks = tokenize(src)?;
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut last = 0;
    for (i, t) in toks.iter().enumerate() {
        let Token::Ident { name, start, end } = t else {
            continue;
        };
        if name != from {
            continue;
        }
        if matches!(toks.get(i + 1), Some(Token::Op { op: "(", .. })) {
            continue;
        }
        if i > 0 && matches!(toks.get(i - 1), Some(Token::Num { .. })) && unit(name).is_some() {
            continue;
        }
        out.extend(&chars[last..*start]);
        out.push_str(to);
        last = *end;
    }
    out.extend(&chars[last..]);
    Ok(out)
}

/// True for a plain literal, optionally negated or with a unit: not worth an fx badge.
pub fn is_numeric_literal(src: &str) -> bool {
    match parse_expr(src) {
        Ok(Expr::Num { .. }) => true,
        Ok(Expr::Neg(e)) => matches!(*e, Expr::Num { .. }),
        _ => false,
    }
}

pub fn has_unit_literal(n: &Expr) -> bool {
    match n {
        Expr::Num { unit, .. } => unit.is_some(),
        Expr::Ref(_) => false,
        Expr::Call { args, .. } => args.iter().any(has_unit_literal),
        Expr::Bin { l, r, .. } => has_unit_literal(l) || has_unit_literal(r),
        Expr::Neg(e) | Expr::Not(e) => has_unit_literal(e),
    }
}
