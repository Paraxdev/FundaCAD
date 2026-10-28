//! What `doc_get` hands out on a long document, and how `doc_set` reads it back: runs of `bodyIds` as one
//! range entry, an import's long assembly lists left out by length, one feature to a line.

use serde_json::{Map, Value};

use crate::budget::{numbered, FOLD_FROM, ROWS};

/// The most bodies one `bodyIds` range entry may stand for when `doc_set` spells it out.
pub const MOST_IN_RANGE: u64 = 1_000_000;

/// A `doc_get` reply pretty printed to more bytes than this puts one feature to a line; a shorter one reads
/// as it always did.
pub const LINES_FROM: usize = 2048;

/// The import fields `doc_get` leaves out over ROWS entries: the assembly tree, which `doc_set` takes back
/// from the open document.
pub const IMPORT_LISTS: [&str; 2] = ["nodes", "parts"];

/// A map over FOLD_FROM entries with runs of three or more, where the key and the body both count up by one,
/// as one entry each: "sep1:0..sep1:2998": "body4..body3002". Shorter maps come back as they were.
pub fn fold_body_ids(ids: &Map<String, Value>) -> Map<String, Value> {
    if ids.len() <= FOLD_FROM {
        return ids.clone();
    }
    type Counted<'a> = ((&'a str, u64), (&'a str, u64));
    let entries: Vec<(&String, &Value)> = ids.iter().collect();
    let step = |i: usize| -> Option<Counted> {
        let (k, v) = entries[i];
        Some((numbered(k)?, numbered(v.as_str()?)?))
    };
    let mut out = Map::new();
    let mut i = 0;
    while i < entries.len() {
        let mut j = i;
        if let Some(((kh, kn), (vh, vn))) = step(i) {
            while j + 1 < entries.len() {
                let n = (j + 1 - i) as u64;
                if step(j + 1) != Some(((kh, kn + n), (vh, vn + n))) {
                    break;
                }
                j += 1;
            }
        }
        if j - i >= 2 {
            let (k0, v0) = entries[i];
            let (k1, v1) = entries[j];
            let v = format!("{}..{}", v0.as_str().unwrap_or_default(), v1.as_str().unwrap_or_default());
            out.insert(format!("{k0}..{k1}"), Value::String(v));
            i = j + 1;
        } else {
            out.insert(entries[i].0.clone(), entries[i].1.clone());
            i += 1;
        }
    }
    out
}

/// `fold_body_ids` undone: every entry whose key and body both read "first..last" becomes one entry per
/// body. Any other key is kept as it is.
pub fn unfold_body_ids(ids: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for (k, v) in ids {
        let (Some((k0, k1)), Some((v0, v1))) = (k.split_once(".."), v.as_str().and_then(|s| s.split_once(".."))) else {
            out.insert(k.clone(), v.clone());
            continue;
        };
        let bad = || {
            format!(
                "the bodyIds range \"{k}\": \"{}\" does not count up alike on both sides",
                v.as_str().unwrap_or_default()
            )
        };
        let (Some((kh, kn0)), Some((kh1, kn1)), Some((vh, vn0)), Some((vh1, vn1))) =
            (numbered(k0), numbered(k1), numbered(v0), numbered(v1))
        else {
            return Err(bad());
        };
        if kh != kh1 || vh != vh1 || kn1 <= kn0 || vn1 < vn0 || kn1 - kn0 != vn1 - vn0 {
            return Err(bad());
        }
        if kn1 - kn0 >= MOST_IN_RANGE {
            return Err(format!("the bodyIds range \"{k}\" stands for more than {MOST_IN_RANGE} bodies"));
        }
        for n in 0..=kn1 - kn0 {
            out.insert(format!("{kh}{}", kn0 + n), Value::String(format!("{vh}{}", vn0 + n)));
        }
    }
    Ok(out)
}

/// The features with each import's long assembly lists replaced by a line saying how long they were.
pub fn leave_out_lists(features: &Value) -> Value {
    let mut features = features.clone();
    for f in features.as_array_mut().into_iter().flatten().filter_map(Value::as_object_mut) {
        if f.get("type").and_then(Value::as_str) != Some("import") {
            continue;
        }
        for key in IMPORT_LISTS {
            if let Some(n) = f.get(key).and_then(Value::as_array).map(Vec::len).filter(|n| *n > ROWS) {
                f.insert(key.into(), Value::String(format!("{n} {key} left out, doc_get full true lists them")));
            }
        }
    }
    features
}

/// Puts back the lists `leave_out_lists` took out, from the open document's feature of the same id.
pub fn take_back_lists(open: &Map<String, Value>, next: &mut Map<String, Value>) -> Result<(), String> {
    let had = |id: &str, key: &str| -> Option<Value> {
        open.get("features")?
            .as_array()?
            .iter()
            .find(|f| f.get("id").and_then(Value::as_str) == Some(id))?
            .get(key)
            .filter(|v| v.is_array())
            .cloned()
    };
    for f in
        next.get_mut("features").and_then(Value::as_array_mut).into_iter().flatten().filter_map(Value::as_object_mut)
    {
        let id = f.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        for key in IMPORT_LISTS {
            if !f.get(key).is_some_and(Value::is_string) {
                continue;
            }
            match had(&id, key) {
                Some(list) => {
                    f.insert(key.into(), list);
                }
                None => {
                    return Err(format!(
                        "{id} has its {key} left out and the open document has no {id} to take them from: \
                         doc_get with full true gives them"
                    ))
                }
            }
        }
    }
    Ok(())
}

/// JSON with each top level entry, and each entry of a list or map under it, on a line of its own, written
/// as Python's json.dumps writes a line: ", " between entries and ": " after a key.
pub fn lines(v: &Map<String, Value>) -> String {
    let mut out = String::from("{\n");
    let n = v.len();
    for (i, (k, val)) in v.iter().enumerate() {
        out.push_str(&format!(" {}: ", one_line(&Value::String(k.clone()))));
        match val {
            Value::Array(a) if !a.is_empty() => {
                let rows: Vec<String> = a.iter().map(|x| format!("  {}", one_line(x))).collect();
                out.push_str(&format!("[\n{}\n ]", rows.join(",\n")));
            }
            Value::Object(o) if !o.is_empty() => {
                let rows: Vec<String> = o
                    .iter()
                    .map(|(k, x)| format!("  {}: {}", one_line(&Value::String(k.clone())), one_line(x)))
                    .collect();
                out.push_str(&format!("{{\n{}\n }}", rows.join(",\n")));
            }
            other => out.push_str(&one_line(other)),
        }
        out.push_str(if i + 1 < n { ",\n" } else { "\n" });
    }
    out.push('}');
    out
}

struct Spaced;

impl serde_json::ser::Formatter for Spaced {
    fn begin_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }

    fn begin_object_key<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }

    fn begin_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        w.write_all(b": ")
    }
}

fn one_line(v: &Value) -> String {
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, Spaced);
    if serde::Serialize::serialize(v, &mut ser).is_err() {
        return v.to_string();
    }
    String::from_utf8(buf).unwrap_or_else(|_| v.to_string())
}
