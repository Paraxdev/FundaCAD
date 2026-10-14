//! Object File Format (OFF, COFF, NOFF, STOFF and the like, ascii only).
//! Millimetres, as STL.

use super::mesh::{dominant_color, unit_color, MeshObject, MAX_IMPORT_TRIANGLES};

fn bad(why: &str) -> String {
    format!("couldn't read this OFF file, {why}")
}

pub fn read_off(text: &str) -> Result<MeshObject, String> {
    let mut lines = text.lines().map(|l| l.split('#').next().unwrap_or("").trim()).filter(|l| !l.is_empty());
    let first = lines.next().ok_or_else(|| bad("it is empty"))?;
    let mut head = first.split_whitespace();
    let tag = head.next().unwrap_or("");
    if !tag.ends_with("OFF") {
        return Err(bad("it does not start with OFF"));
    }
    if tag.contains('4') || tag.starts_with('n') {
        return Err(bad("only three dimensional OFF files import"));
    }
    let counts: Vec<&str> = match head.collect::<Vec<_>>() {
        rest if rest.len() >= 2 => rest,
        _ => lines.next().ok_or_else(|| bad("it has no vertex and face counts"))?.split_whitespace().collect(),
    };
    let num = |s: Option<&&str>| s.and_then(|s| s.parse::<usize>().ok()).ok_or_else(|| bad("its counts are not numbers"));
    let nv = num(counts.first())?;
    let nf = num(counts.get(1))?;
    if nf as u64 > MAX_IMPORT_TRIANGLES {
        return Err(super::mesh::too_dense_error(nf as u64));
    }
    if nv > text.len() / 6 {
        return Err(bad(&format!("it claims {nv} vertices, more than the file holds")));
    }
    let mut pos = Vec::with_capacity(nv * 3);
    for _ in 0..nv {
        let line = lines.next().ok_or_else(|| bad("it ends before all its vertices are read"))?;
        let v: Vec<f64> = line.split_whitespace().take(3).filter_map(|t| t.parse().ok()).collect();
        if v.len() < 3 {
            return Err(bad(&format!("the vertex '{line}' does not have three numbers")));
        }
        pos.extend(v);
    }
    let mut idx = Vec::new();
    let mut colors = Vec::new();
    for _ in 0..nf {
        let line = lines.next().ok_or_else(|| bad("it ends before all its faces are read"))?;
        let t: Vec<&str> = line.split_whitespace().collect();
        let n: usize = t.first().and_then(|s| s.parse().ok()).ok_or_else(|| bad(&format!("the face '{line}' has no corner count")))?;
        if t.len() < 1 + n {
            return Err(bad(&format!("the face '{line}' lists fewer corners than it says")));
        }
        let mut c = Vec::with_capacity(n);
        for s in &t[1..=n] {
            let i: usize = s.parse().map_err(|_| bad(&format!("the face '{line}' has a corner that is not a number")))?;
            if i >= nv {
                return Err(bad("a face references a vertex that does not exist"));
            }
            c.push(i as u32);
        }
        let rgb: Vec<f64> = t[1 + n..].iter().take(3).filter_map(|s| s.parse().ok()).collect();
        let color = (rgb.len() == 3).then(|| unit_color([rgb[0], rgb[1], rgb[2]]));
        for k in 1..n.saturating_sub(1) {
            idx.extend([c[0], c[k], c[k + 1]]);
            colors.push(color);
        }
    }
    if idx.is_empty() {
        return Err(bad("it has no faces"));
    }
    Ok(MeshObject { name: None, color: dominant_color(colors.into_iter()), pos, idx })
}
