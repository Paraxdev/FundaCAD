//! The `measure` tool: the engine replies with raw numbers, this rounds them
//! for reading and keeps the raw reply at the end.

use rmcp::model::JsonObject;
use serde_json::{json, Map, Value};

use crate::describe::fmt;

/// The engine payload for the tool's arguments, without the document.
pub fn request_of(args: &JsonObject) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    match args.get("a").filter(|v| !v.is_null()) {
        None => return Err("give `a`, the thing to measure, and `b` to measure between two".into()),
        Some(a) => {
            out.insert("a".into(), a.clone());
        }
    }
    if let Some(b) = args.get("b").filter(|v| !v.is_null()) {
        out.insert("b".into(), b.clone());
    }
    if let Some(w) = args.get("want").filter(|v| !v.is_null()) {
        match w.as_str() {
            Some("distance" | "angle" | "centres") => {
                out.insert("want".into(), w.clone());
            }
            _ => return Err(format!("`want` is distance, angle or centres, got {w}")),
        }
    }
    Ok(out)
}

/// mm and degrees to 3 places, and never a "-0".
fn n(v: Option<&Value>) -> String {
    let s = fmt(v, 3);
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

fn point(v: &Value) -> String {
    let parts: Vec<String> = (0..3).map(|k| n(v.get(k))).collect();
    format!("({})", parts.join(", "))
}

fn axis(v: &Value) -> String {
    format!("axis {} through {}", point(&v["dir"]), point(&v["origin"]))
}

fn round(item: &Value, out: &mut String) {
    if item.get("radius").is_some() {
        out.push_str(&format!(", radius {} mm (diameter {})", n(item.get("radius")), n(item.get("diameter"))));
    }
    if let Some(c) = item.get("centre") {
        out.push_str(&format!(", centre {}", point(c)));
    }
}

pub fn item_line(item: &Value) -> String {
    let s = |k: &str| item.get(k).and_then(Value::as_str).unwrap_or("?").to_string();
    let owner = match item.get("body").and_then(Value::as_str) {
        Some(b) => format!(" of {b} \"{}\"", s("name")),
        None => String::new(),
    };
    let index =
        |label: &str| item.get("index").and_then(Value::as_u64).map_or(String::new(), |i| format!(" {label}{i}"));
    let mut out = String::new();
    match s("kind").as_str() {
        "point" => out.push_str(&format!("point {}", point(&item["at"]))),
        "body" => {
            out.push_str(&format!(
                "{} \"{}\", volume {} mm3, area {} mm2",
                s("body"),
                s("name"),
                n(item.get("volume")),
                n(item.get("area"))
            ));
            if let Some(size) = item.get("size") {
                let dims: Vec<String> = (0..3).map(|k| n(size.get(k))).collect();
                out.push_str(&format!(", size {} mm", dims.join(" x ")));
            }
            if let Some(bb) = item.get("bbox") {
                out.push_str(&format!(", bbox {} to {}", point(&bb["min"]), point(&bb["max"])));
            }
        }
        "face" => {
            out.push_str(&format!("face{}{owner}, {}, area {} mm2", index("F"), s("surface"), n(item.get("area"))));
            if let Some(nv) = item.get("normal") {
                out.push_str(&format!(", normal {}", point(nv)));
            }
            round(item, &mut out);
            if let Some(a) = item.get("semiAngle") {
                out.push_str(&format!(", half angle {} deg, apex {}", n(Some(a)), point(&item["apex"])));
            }
            if item.get("majorRadius").is_some() {
                out.push_str(&format!(
                    ", major radius {} mm, minor radius {} mm",
                    n(item.get("majorRadius")),
                    n(item.get("minorRadius"))
                ));
            }
            if let Some(ax) = item.get("axis") {
                out.push_str(&format!(", {}", axis(ax)));
            }
        }
        "edge" => {
            out.push_str(&format!("edge{}{owner}, {}, length {} mm", index("E"), s("curve"), n(item.get("length"))));
            if let Some(d) = item.get("dir") {
                out.push_str(&format!(", along {}", point(d)));
            }
            round(item, &mut out);
            if let Some(ax) = item.get("axis") {
                out.push_str(&format!(", axis {}, arc {} deg", point(&ax["dir"]), n(item.get("arc"))));
            }
            if item.get("start").is_some() {
                out.push_str(&format!(", from {} to {}", point(&item["start"]), point(&item["end"])));
            }
        }
        other => out.push_str(other),
    }
    out
}

fn from_to(v: &Value) -> String {
    format!("from {} to {}", point(&v["from"]), point(&v["to"]))
}

pub fn report(r: &Value) -> String {
    let mut lines = vec![format!("a: {}", item_line(&r["a"]))];
    if let Some(b) = r.get("b") {
        lines.push(format!("b: {}", item_line(b)));
    }
    let between = &r["between"];
    if let Some(d) = between.get("distance") {
        if d["inside"] == json!(true) {
            lines.push("distance 0 mm, one lies inside the other (interference measures an overlap)".into());
        } else {
            let delta = &d["delta"];
            let mut line = format!(
                "distance {} mm, {}, dx {} dy {} dz {}",
                n(d.get("value")),
                from_to(d),
                n(delta.get(0)),
                n(delta.get(1)),
                n(delta.get(2))
            );
            match d.get("ties").and_then(Value::as_u64) {
                Some(t) if t > 1 => line.push_str(&format!(" ({t} closest pairs tie, this is one of them)")),
                _ => {}
            }
            lines.push(line);
        }
    }
    if let Some(g) = between.get("planeGap") {
        lines.push(format!("plane gap {} mm (parallel faces)", n(g.get("value"))));
    }
    if let Some(c) = between.get("centres") {
        let how = c.get("how").and_then(Value::as_str).unwrap_or("centres");
        let parallel = if c["parallel"] == json!(true) { " (parallel axes)" } else { "" };
        lines.push(format!("{how} {} mm{parallel}, {}", n(c.get("value")), from_to(c)));
    }
    if let Some(a) = between.get("angle") {
        let how = a.get("how").and_then(Value::as_str).unwrap_or("");
        let mut line = format!("angle {} deg {how}", n(a.get("value")));
        if let Some(normals) = a.get("normals") {
            line.push_str(&format!(", {} deg between the outward normals", n(Some(normals))));
        }
        lines.push(line);
    }
    let failed = crate::clash::failures(r);
    if !failed.is_empty() {
        lines.push("Some features failed, so this measured what did build:".into());
        lines.extend(failed);
    }
    lines.push(format!("raw: {}", serde_json::to_string(r).unwrap_or_default()));
    lines.join("\n")
}
