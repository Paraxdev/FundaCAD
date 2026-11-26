//! The subset of ICU MessageFormat FundaCAD 1's src/i18n/format.ts reads: {name}, {n, number}, plural and select. It
//! interprets a parsed tree, so a dropped in line can only ever come out as text.

use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Text(String),
    Arg { name: String, number: bool },
    Pound,
    Plural { name: String, options: Vec<(String, Vec<Node>)> },
    Select { name: String, options: Vec<(String, Vec<Node>)> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Text(String),
    Num(f64),
}

impl Arg {
    /// As JavaScript's String() spells it, which select options match against.
    fn plain(&self) -> String {
        match self {
            Arg::Text(s) => s.clone(),
            Arg::Num(n) => js_number(*n),
        }
    }

    fn count(&self) -> f64 {
        match self {
            Arg::Num(n) => *n,
            Arg::Text(s) => s.trim().parse().unwrap_or(f64::NAN),
        }
    }
}

impl From<&str> for Arg {
    fn from(v: &str) -> Self {
        Arg::Text(v.to_owned())
    }
}

impl From<String> for Arg {
    fn from(v: String) -> Self {
        Arg::Text(v)
    }
}

impl From<&String> for Arg {
    fn from(v: &String) -> Self {
        Arg::Text(v.clone())
    }
}

impl From<bool> for Arg {
    /// FundaCAD 1's lines select on yes, as {on, select, yes {...} other {...}}.
    fn from(v: bool) -> Self {
        Arg::Text(if v { "yes" } else { "no" }.to_owned())
    }
}

macro_rules! num_arg {
    ($($t:ty),*) => {$(
        impl From<$t> for Arg {
            fn from(v: $t) -> Self {
                Arg::Num(v as f64)
            }
        }
    )*};
}
num_arg!(i32, i64, u32, u64, usize, f32, f64);

pub type Args<'a> = [(&'a str, Arg)];

#[derive(Debug, PartialEq)]
pub struct SyntaxError(pub String);

const PLURAL_KEYS: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

struct Parser<'a> {
    src: &'a [char],
    i: usize,
}

impl Parser<'_> {
    fn fail<T>(&self, why: &str) -> Result<T, SyntaxError> {
        Err(SyntaxError(format!("{why} at {}", self.i)))
    }

    fn at(&self, k: usize) -> Option<char> {
        self.src.get(self.i + k).copied()
    }

    fn skip_space(&mut self) {
        while self.at(0).is_some_and(char::is_whitespace) {
            self.i += 1;
        }
    }

    fn expect(&mut self, ch: char) -> Result<(), SyntaxError> {
        self.skip_space();
        if self.at(0) != Some(ch) {
            return self.fail(&format!("expected {ch}"));
        }
        self.i += 1;
        Ok(())
    }

    fn name(&mut self) -> Option<String> {
        let start = self.i;
        if !self.at(0).is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
            return None;
        }
        while self.at(0).is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            self.i += 1;
        }
        Some(self.src[start..self.i].iter().collect())
    }

    fn option_key(&mut self) -> Option<String> {
        let start = self.i;
        if self.at(0) == Some('=') {
            self.i += 1;
        }
        let body = self.i;
        while self.at(0).is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            self.i += 1;
        }
        if self.i == body {
            self.i = start;
            return None;
        }
        Some(self.src[start..self.i].iter().collect())
    }

    fn nodes(&mut self, in_plural: bool, nested: bool) -> Result<Vec<Node>, SyntaxError> {
        let mut out = Vec::new();
        let mut text = String::new();
        while let Some(c) = self.at(0) {
            match c {
                '\'' => match self.at(1) {
                    Some('\'') => {
                        text.push('\'');
                        self.i += 2;
                    }
                    // ICU quotes only before syntax, so French l'appui needs no doubling.
                    Some(n) if n == '{' || n == '}' || (in_plural && n == '#') => {
                        let Some(len) = self.src[self.i + 1..].iter().position(|&c| c == '\'') else {
                            return self.fail("unclosed quote");
                        };
                        text.extend(&self.src[self.i + 1..self.i + 1 + len]);
                        self.i += len + 2;
                    }
                    _ => {
                        text.push('\'');
                        self.i += 1;
                    }
                },
                '{' => {
                    if !text.is_empty() {
                        out.push(Node::Text(std::mem::take(&mut text)));
                    }
                    self.i += 1;
                    out.push(self.argument(in_plural)?);
                }
                '}' => {
                    if !nested {
                        return self.fail("stray }");
                    }
                    break;
                }
                '#' if in_plural => {
                    if !text.is_empty() {
                        out.push(Node::Text(std::mem::take(&mut text)));
                    }
                    self.i += 1;
                    out.push(Node::Pound);
                }
                _ => {
                    text.push(c);
                    self.i += 1;
                }
            }
        }
        if !text.is_empty() {
            out.push(Node::Text(text));
        }
        Ok(out)
    }

    fn options(&mut self, plural: bool, in_plural: bool) -> Result<Vec<(String, Vec<Node>)>, SyntaxError> {
        let mut out: Vec<(String, Vec<Node>)> = Vec::new();
        loop {
            self.skip_space();
            if self.at(0) == Some('}') {
                break;
            }
            let Some(key) = self.option_key() else { return self.fail("expected an option") };
            // A typo such as `on` would otherwise never be chosen and fall to other without a word.
            let exact = key.strip_prefix('=').is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()));
            if plural && !exact && !PLURAL_KEYS.contains(&key.as_str()) {
                return self.fail(&format!("unknown plural category {key}"));
            }
            self.expect('{')?;
            let nodes = self.nodes(in_plural, true)?;
            self.expect('}')?;
            match out.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = nodes,
                None => out.push((key, nodes)),
            }
        }
        if !out.iter().any(|(k, _)| k == "other") {
            return self.fail("an option list needs other");
        }
        Ok(out)
    }

    fn argument(&mut self, in_plural: bool) -> Result<Node, SyntaxError> {
        self.skip_space();
        let Some(name) = self.name() else { return self.fail("expected an argument name") };
        self.skip_space();
        if self.at(0) == Some('}') {
            self.i += 1;
            return Ok(Node::Arg { name, number: false });
        }
        self.expect(',')?;
        self.skip_space();
        let kind = self.name();
        self.skip_space();
        match kind.as_deref() {
            Some("number") => {
                self.expect('}')?;
                Ok(Node::Arg { name, number: true })
            }
            Some(k @ ("plural" | "select")) => {
                self.expect(',')?;
                let plural = k == "plural";
                let options = self.options(plural, plural || in_plural)?;
                self.expect('}')?;
                Ok(if plural { Node::Plural { name, options } } else { Node::Select { name, options } })
            }
            other => self.fail(&format!("unknown kind {}", other.unwrap_or(""))),
        }
    }
}

pub fn parse(src: &str) -> Result<Vec<Node>, SyntaxError> {
    let chars: Vec<char> = src.chars().collect();
    Parser { src: &chars, i: 0 }.nodes(false, false)
}

/// JavaScript's String(n), which is what a select option and an English plural see.
fn js_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0. { "Infinity" } else { "-Infinity" }.into()
    } else if n == 0. {
        "0".into()
    } else {
        format!("{n}")
    }
}

/// A language's decimal mark, a comma or a point. A third mark (Arabic) reads as a point, the only two the readers know.
pub fn decimal_mark(bcp47: &str) -> char {
    let lower = bcp47.to_ascii_lowercase();
    // Regions whose base writes a comma but which write a point themselves.
    if matches!(
        lower.as_str(),
        "de-ch" | "de-li" | "it-ch" | "es-mx" | "es-us" | "es-419" | "es-pr" | "es-do" | "es-gt" | "es-hn" | "es-ni"
            | "es-pa" | "es-sv" | "es-pe" | "pt-mo"
    ) {
        return '.';
    }
    if matches!(lower.as_str(), "en-za" | "en-150" | "en-de" | "en-dk" | "en-nl" | "en-se" | "en-fi" | "en-be") {
        return ',';
    }
    let base = lower.split('-').next().unwrap_or("");
    const COMMA: &[&str] = &[
        "af", "az", "be", "bg", "bs", "ca", "cs", "da", "de", "el", "es", "et", "eu", "fi", "fo", "fr", "gl", "hr",
        "hu", "hy", "id", "is", "it", "ka", "kk", "ky", "lb", "lt", "lv", "mk", "nb", "nl", "nn", "no", "pl", "pt",
        "ro", "ru", "sk", "sl", "sq", "sr", "sv", "tk", "tr", "uk", "uz", "vi",
    ];
    if COMMA.contains(&base) {
        ','
    } else {
        '.'
    }
}

/// As Intl.NumberFormat writes it without grouping: German 210.000 reads as 210 beside a value box, and value boxes do
/// not group either. At most three decimals, rounded half away from zero.
pub fn format_number(n: f64, bcp47: &str) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0. { "∞" } else { "-∞" }.into();
    }
    let rounded = (n * 1000.).round() / 1000.;
    let mut s = format!("{:.3}", rounded.abs());
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    let s = if rounded < 0. && s != "0" { format!("-{s}") } else { s };
    match decimal_mark(bcp47) {
        ',' => s.replace('.', ","),
        _ => s,
    }
}

/// The CLDR plural category of `n` in a language, for the languages FundaCAD ships and the common drop-ins.
pub fn plural_category(n: f64, bcp47: &str) -> &'static str {
    let lower = bcp47.to_ascii_lowercase();
    let base = lower.split('-').next().unwrap_or("");
    let abs = n.abs();
    let integer = abs.fract() == 0.;
    let i = abs.trunc();
    let million = integer && i != 0. && i % 1_000_000. == 0.;
    let (i10, i100) = (i % 10., i % 100.);
    match base {
        "ja" | "zh" | "ko" | "th" | "vi" | "id" | "ms" | "lo" | "my" | "km" => "other",
        "fr" => {
            if i == 0. || i == 1. {
                "one"
            } else if million {
                "many"
            } else {
                "other"
            }
        }
        "pt" if lower != "pt-pt" => {
            if i == 0. || i == 1. {
                "one"
            } else if million {
                "many"
            } else {
                "other"
            }
        }
        "es" | "it" | "ca" | "pt" => {
            if abs == 1. && integer {
                "one"
            } else if million {
                "many"
            } else {
                "other"
            }
        }
        "ru" | "uk" | "be" if integer => {
            if i10 == 1. && i100 != 11. {
                "one"
            } else if (2. ..=4.).contains(&i10) && !(12. ..=14.).contains(&i100) {
                "few"
            } else {
                "many"
            }
        }
        "ru" | "uk" | "be" => "other",
        "pl" if integer => {
            if i == 1. {
                "one"
            } else if (2. ..=4.).contains(&i10) && !(12. ..=14.).contains(&i100) {
                "few"
            } else {
                "many"
            }
        }
        "pl" => "other",
        "cs" | "sk" => {
            if !integer {
                "many"
            } else if i == 1. {
                "one"
            } else if (2. ..=4.).contains(&i) {
                "few"
            } else {
                "other"
            }
        }
        _ => {
            if abs == 1. && integer {
                "one"
            } else {
                "other"
            }
        }
    }
}

fn arg<'a>(args: &'a Args, name: &str) -> Option<&'a Arg> {
    args.iter().find(|(n, _)| *n == name).map(|(_, v)| v)
}

fn option<'a>(options: &'a [(String, Vec<Node>)], key: &str) -> Option<&'a [Node]> {
    options.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_slice())
}

/// `locale` spells the numbers, `plurals` picks the plural forms: an English line keeps English plurals, or Japanese
/// rules would read "1 lines".
pub fn format(nodes: &[Node], args: &Args, locale: &str, plurals: &str) -> String {
    let mut out = String::new();
    write(&mut out, nodes, args, locale, None, plurals);
    out
}

fn write(out: &mut String, nodes: &[Node], args: &Args, locale: &str, pound: Option<f64>, plurals: &str) {
    for node in nodes {
        match node {
            Node::Text(v) => out.push_str(v),
            Node::Pound => match pound {
                Some(n) => out.push_str(&format_number(n, locale)),
                None => out.push('#'),
            },
            Node::Arg { name, number } => match arg(args, name) {
                None => {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
                Some(Arg::Num(n)) if *number => out.push_str(&format_number(*n, locale)),
                Some(v) => out.push_str(&v.plain()),
            },
            Node::Plural { name, options } => {
                let n = arg(args, name).map_or(0., Arg::count);
                let chosen = option(options, &format!("={}", js_number(n)))
                    .or_else(|| option(options, plural_category(n, plurals)))
                    .or_else(|| option(options, "other"))
                    .unwrap_or_default();
                write(out, chosen, args, locale, Some(n), plurals);
            }
            Node::Select { name, options } => {
                let value = arg(args, name).map_or_else(|| "undefined".to_owned(), Arg::plain);
                let chosen = option(options, &value).or_else(|| option(options, "other")).unwrap_or_default();
                write(out, chosen, args, locale, pound, plurals);
            }
        }
    }
}

/// So a translation or a dropped in line cannot ask for a value the code never passes.
pub fn arg_names(nodes: &[Node], into: &mut BTreeSet<String>) {
    for node in nodes {
        match node {
            Node::Arg { name, .. } => {
                into.insert(name.clone());
            }
            Node::Plural { name, options } | Node::Select { name, options } => {
                into.insert(name.clone());
                for (_, o) in options {
                    arg_names(o, into);
                }
            }
            Node::Text(_) | Node::Pound => {}
        }
    }
}
