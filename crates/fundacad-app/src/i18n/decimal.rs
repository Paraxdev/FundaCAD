//! A decimal comma typed in a language that writes one, turned into the point the value readers take, and stored
//! point text shown with a comma, as FundaCAD 1's src/params/decimalForm.ts. Both directions share one scan and keep
//! the length, so what one shows the other reads back and error positions stay right.

#[derive(Debug, PartialEq, Eq)]
pub struct Ambiguous {
    pub number: String,
    pub at: usize,
}

impl std::fmt::Display for Ambiguous {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "\"{}\" is ambiguous, write a comma for decimals or leave the point out", self.number)
    }
}

fn digit(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_digit())
}

fn ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn ident_part(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// "10x2,5" and "10x,5" are the drawing form of 10 times 2,5 and 0,5, the x is not the start of a name there.
fn is_times_x(t: &[char], i: usize) -> bool {
    let at = |k: usize| t.get(k).copied();
    matches!(at(i), Some('x' | 'X'))
        && i > 0
        && matches!(at(i - 1), Some('0'..='9' | ')'))
        && (digit(at(i + 1)) || (matches!(at(i + 1), Some(',' | '.')) && digit(at(i + 2))))
}

/// "1.500" could be a thousands point, the mirror of "1,000" in a point language. After a zero whole part (0.250) it
/// never is.
fn point_before_three(num: &[char]) -> bool {
    let Some(dot) = num.iter().position(|&c| c == '.') else { return false };
    let (whole, frac) = (&num[..dot], &num[dot + 1..]);
    whole.iter().any(|&c| c != '0')
        && whole.iter().all(char::is_ascii_digit)
        && frac.len() == 3
        && frac.iter().all(char::is_ascii_digit)
}

fn exponent_follows(t: &[char], j: usize) -> bool {
    let at = |k: usize| t.get(k).copied();
    if !matches!(at(j), Some('e' | 'E')) {
        return false;
    }
    let k = if matches!(at(j + 1), Some('+' | '-')) { j + 2 } else { j + 1 };
    digit(at(k))
}

fn swap_mark(text: &str, from: char, to: char) -> Result<String, Ambiguous> {
    let t: Vec<char> = text.chars().collect();
    let at = |k: usize| t.get(k).copied();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < t.len() {
        let ch = t[i];
        if is_times_x(&t, i) {
            out.push(ch);
            i += 1;
            if at(i) == Some(from) {
                out.push(to);
                i += 1;
            }
        } else if ident_start(ch) {
            let mut j = i + 1;
            while ident_part(at(j)) {
                j += 1;
            }
            out.extend(&t[i..j]);
            i = j;
        } else if ch.is_ascii_digit() {
            let mut j = i + 1;
            loop {
                while digit(at(j)) {
                    j += 1;
                }
                if matches!(at(j), Some(',' | '.')) && digit(at(j + 1)) {
                    j += 1;
                } else {
                    break;
                }
            }
            let num = &t[i..j];
            if to == '.' && point_before_three(num) && !exponent_follows(&t, j) {
                let at = text.char_indices().nth(i).map_or(i, |(b, _)| b);
                return Err(Ambiguous { number: num.iter().collect(), at });
            }
            out.extend(num.iter().map(|&c| if c == from { to } else { c }));
            i = j;
        } else if ch == from && digit(at(i + 1)) && !(i > 0 && (ident_part(at(i - 1)) || at(i - 1) == Some(')'))) {
            out.push(to);
            i += 1;
        } else {
            out.push(ch);
            i += 1;
        }
    }
    Ok(out)
}

/// A comma is a decimal mark when a digit follows it and it starts a number or continues one. After a name or a
/// closing bracket it stays, so the reader refuses it. A lone point before exactly three digits after a nonzero whole
/// part (1.500, not 0.250) is refused rather than guessed.
pub fn commas_to_points(text: &str) -> Result<String, Ambiguous> {
    swap_mark(text, ',', '.')
}

/// Stored point text with the point of each number shown as a comma. A point with no digit after it (5. or 5.e3)
/// stays, because a comma there would not read back.
pub fn points_to_commas(stored: &str) -> String {
    swap_mark(stored, '.', ',').unwrap_or_else(|_| stored.to_owned())
}

/// Typed text as the readers take it, in a language that writes `mark`.
pub fn read_typed(text: &str, mark: char) -> Result<String, Ambiguous> {
    if mark == ',' {
        commas_to_points(text)
    } else {
        Ok(text.to_owned())
    }
}

/// Stored text as a language that writes `mark` shows it.
pub fn show_stored(stored: &str, mark: char) -> String {
    if mark == ',' {
        points_to_commas(stored)
    } else {
        stored.to_owned()
    }
}
