//! Pseudo text for finding cut labels and strings that skip the lookup, as FundaCAD 1's src/i18n/pseudo.ts: accented,
//! about 1.7 times English, between brackets, so a missing closing bracket means cut and plain letters mean not
//! converted.

use super::format::Node;

/// Latin-1 only, so the letters render in the UI font.
fn accent(c: char) -> Option<char> {
    Some(match c {
        'a' => 'á',
        'c' => 'ç',
        'e' => 'é',
        'i' => 'í',
        'n' => 'ñ',
        'o' => 'ö',
        'u' => 'ü',
        'y' => 'ý',
        'A' => 'Å',
        'C' => 'Ç',
        'E' => 'É',
        'I' => 'Î',
        'N' => 'Ñ',
        'O' => 'Ö',
        'U' => 'Ü',
        'Y' => 'Ý',
        _ => return None,
    })
}

fn stretch(text: &str) -> String {
    let mut doubled = String::new();
    for c in text.chars() {
        match accent(c) {
            Some(a) => {
                doubled.push(a);
                doubled.push(a);
            }
            None => doubled.push(c),
        }
    }
    // Short labels grow the most in real translations, so each word of three letters or more also gets a tail.
    let mut out = String::new();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if word.chars().count() >= 3 {
            let last = word.chars().last();
            out.push_str(word);
            out.extend(last);
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in doubled.chars() {
        if c.is_alphabetic() {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn map(nodes: &[Node]) -> Vec<Node> {
    nodes
        .iter()
        .map(|node| match node {
            Node::Text(v) => Node::Text(stretch(v)),
            Node::Plural { name, options } => Node::Plural {
                name: name.clone(),
                options: options.iter().map(|(k, o)| (k.clone(), map(o))).collect(),
            },
            Node::Select { name, options } => Node::Select {
                name: name.clone(),
                options: options.iter().map(|(k, o)| (k.clone(), map(o))).collect(),
            },
            other => other.clone(),
        })
        .collect()
}

pub fn pseudo_nodes(nodes: &[Node]) -> Vec<Node> {
    let mut out = vec![Node::Text("[".into())];
    out.extend(map(nodes));
    out.push(Node::Text("]".into()));
    out
}

#[cfg(test)]
pub fn pseudo_text(text: &str) -> String {
    format!("[{}]", stretch(text))
}
