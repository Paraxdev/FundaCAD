//! Some exporters (SolidWorks 2014 seen) write an EDGE_CURVE whose start or end names another entity where a
//! VERTEX_POINT belongs. OCCT then drops the whole shell based model that face sits in without an error, so the
//! vertex is taken back from the edge next to it in the face's loop, or made at the end of the edge's curve, and the
//! file is read from a repaired copy.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

use super::packed::{temp_step, Unpacked};

type Id = u64;

#[derive(Clone, Copy)]
struct Edge {
    start: Id,
    end: Id,
    curve: Id,
    sense: bool,
}

pub struct Repaired {
    file: Unpacked,
    pub fixed: usize,
    pub unfixed: usize,
}

impl Repaired {
    pub fn path(&self) -> &Path {
        self.file.path()
    }
}

#[derive(Default)]
pub struct Scan {
    /// ADVANCED_FACE and FACE_SURFACE records in the file.
    pub faces: usize,
    /// Edges with a start or end that is not a vertex.
    pub bad: usize,
    /// A copy with the vertices put back, when at least one edge could be repaired.
    pub repaired: Option<Repaired>,
}

impl Scan {
    pub fn note(&self) -> Option<String> {
        if self.bad == 0 {
            return None;
        }
        let fixed = self.repaired.as_ref().map_or(0, |r| r.fixed);
        let mut text = format!(
            "{} edge{} of this STEP file named another entity where a vertex belongs, an exporter fault that hides \
             every face of the shell model around it.",
            self.bad,
            if self.bad == 1 { "" } else { "s" }
        );
        if fixed > 0 {
            text.push_str(&format!(
                " FundaCAD rebuilt the vertices of {fixed} from the edges and curves next to them."
            ));
        }
        if fixed < self.bad {
            text.push_str(&format!(
                " {} could not be repaired, so that shell model is still left out with all its faces.",
                self.bad - fixed
            ));
        }
        Some(text)
    }
}

pub fn repair(path: &Path) -> Result<Option<Repaired>, String> {
    scan(path).map(|s| s.repaired)
}

pub fn scan(path: &Path) -> Result<Scan, String> {
    let mut vertices: HashSet<Id> = HashSet::new();
    let mut vertex_at: HashMap<Id, Id> = HashMap::new();
    let mut edges: HashMap<Id, Edge> = HashMap::new();
    let (mut faces, mut last_id) = (0usize, 0);
    for_each_record(path, |rec| {
        let Some((id, kind, rest)) = head(rec) else { return Ok(()) };
        last_id = last_id.max(id);
        match kind {
            b"VERTEX_POINT" => {
                vertices.insert(id);
                if let Some(p) = args(rest).get(1).and_then(|r| reference(r)) {
                    vertex_at.insert(id, p);
                }
            }
            b"EDGE_CURVE" => {
                let a = args(rest);
                let r = |i: usize| a.get(i).and_then(|r| reference(r));
                if let (Some(start), Some(end), Some(curve)) = (r(1), r(2), r(3)) {
                    let sense = a.get(4).is_none_or(|s| trim(s) != b".F.");
                    edges.insert(id, Edge { start, end, curve, sense });
                }
            }
            b"ADVANCED_FACE" | b"FACE_SURFACE" => faces += 1,
            b"" if rec.windows(12).any(|w| w == b"VERTEX_POINT") => {
                vertices.insert(id);
            }
            _ => {}
        }
        Ok(())
    })?;
    let is_vertex = |v: &Id| vertices.contains(v);
    let mut ends: HashMap<Id, (Id, Id)> = edges
        .iter()
        .filter(|(_, e)| !is_vertex(&e.start) || !is_vertex(&e.end))
        .map(|(&id, e)| (id, (e.start, e.end)))
        .collect();
    let bad = ends.len();
    if bad == 0 {
        return Ok(Scan { faces, bad, repaired: None });
    }

    let mut oriented: HashMap<Id, (Id, bool)> = HashMap::new();
    let mut loops: Vec<Vec<Id>> = Vec::new();
    for_each_record(path, |rec| {
        let Some((id, kind, rest)) = head(rec) else { return Ok(()) };
        match kind {
            b"ORIENTED_EDGE" => {
                let a = args(rest);
                if let (Some(edge), Some(sense)) = (a.get(3).and_then(|r| reference(r)), a.get(4)) {
                    oriented.insert(id, (edge, trim(sense) == b".T."));
                }
            }
            b"EDGE_LOOP" => {
                if let Some(l) = args(rest).get(1) {
                    loops.push(list(l).filter_map(reference).collect());
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    loops.retain(|l| l.iter().any(|oe| oriented.get(oe).is_some_and(|(e, _)| ends.contains_key(e))));

    // An edge loop is a chain, so the end of each oriented edge is the start of the next.
    let side = |oe: Id, start: bool, ends: &HashMap<Id, (Id, Id)>| -> Option<Id> {
        let &(edge, fwd) = oriented.get(&oe)?;
        let (s, e) = ends.get(&edge).copied().or_else(|| edges.get(&edge).map(|e| (e.start, e.end)))?;
        Some(if start == fwd { s } else { e })
    };
    let mut changed = true;
    while changed {
        changed = false;
        for l in &loops {
            let n = l.len();
            for i in 0..n {
                let Some(&(edge, fwd)) = oriented.get(&l[i]) else { continue };
                let Some(&(s, e)) = ends.get(&edge) else { continue };
                let (mut from, mut to) = if fwd { (s, e) } else { (e, s) };
                if !is_vertex(&from) {
                    if let Some(v) = side(l[(i + n - 1) % n], false, &ends).filter(is_vertex) {
                        from = v;
                        changed = true;
                    }
                }
                if !is_vertex(&to) {
                    if let Some(v) = side(l[(i + 1) % n], true, &ends).filter(is_vertex) {
                        to = v;
                        changed = true;
                    }
                }
                ends.insert(edge, if fwd { (from, to) } else { (to, from) });
            }
        }
    }

    // A vertex id the file never defines as a vertex (SolidWorks gave it to an edge) gets a new VERTEX_POINT on the
    // end control point of a clamped B-spline edge that uses it, only where every such edge at it ends at one place
    // and runs from there to its other vertex, so an edge on part of a curve is left alone.
    let missing: HashSet<Id> = ends.values().flat_map(|&(s, e)| [s, e]).filter(|v| !is_vertex(v)).collect();
    let mut point_of: HashMap<Id, Id> = HashMap::new();
    if !missing.is_empty() {
        let mut uses: Vec<(Id, Id, bool, Id)> = Vec::new();
        for (id, &(s, e)) in &ends {
            let edge = edges[id];
            if missing.contains(&s) {
                uses.push((s, edge.curve, edge.sense, e));
            }
            if missing.contains(&e) {
                uses.push((e, edge.curve, !edge.sense, s));
            }
        }
        let curves = curve_ends(path, uses.iter().map(|u| u.1).collect())?;
        let mut wanted: HashSet<Id> = HashSet::new();
        for (_, curve, _, other) in &uses {
            if let Some(&(first, last)) = curves.get(curve) {
                wanted.extend([first, last]);
                wanted.extend(vertex_at.get(other));
            }
        }
        let at = points(path, wanted)?;
        let same = |a: Id, b: Id| a == b || at.get(&a).zip(at.get(&b)).is_some_and(|(p, q)| close(p, q));
        let mut place: BTreeMap<Id, Option<Id>> = BTreeMap::new();
        for &(v, curve, at_start, other) in &uses {
            let Some(&(first, last)) = curves.get(&curve) else { continue };
            let (here, there) = if at_start { (first, last) } else { (last, first) };
            let whole = vertex_at.get(&other).is_none_or(|&p| same(p, there));
            let slot = place.entry(v).or_insert(Some(here));
            if !whole || !slot.is_some_and(|p| same(p, here)) {
                *slot = None;
            }
        }
        let mut made: HashMap<Id, Id> = HashMap::new();
        for (v, point) in place {
            if let Some(point) = point {
                last_id += 1;
                made.insert(v, last_id);
                point_of.insert(last_id, point);
            }
        }
        for (s, e) in ends.values_mut() {
            for v in [s, e] {
                if let Some(&new) = made.get(v) {
                    *v = new;
                }
            }
        }
    }
    let good = |v: &Id| is_vertex(v) || point_of.contains_key(v);
    ends.retain(|id, &mut (s, e)| (edges[id].start, edges[id].end) != (s, e));
    let fixed = ends.values().filter(|(s, e)| good(s) && good(e)).count();
    if ends.is_empty() {
        return Ok(Scan { faces, bad, repaired: None });
    }

    let (file, out) = temp_step()?;
    let failed = |e: std::io::Error| format!("couldn't write the repaired STEP file into the temp folder ({e})");
    let mut w = BufWriter::with_capacity(1 << 20, out);
    let mut written: HashSet<Id> = HashSet::new();
    for_each_record(path, |rec| {
        if let Some((id, b"EDGE_CURVE", rest)) = head(rec) {
            if let Some(&(s, e)) = ends.get(&id) {
                let a = args(rest);
                w.write_all(&rec[..rec.len() - rest.len()]).map_err(failed)?;
                write!(w, "({},#{s},#{e}", String::from_utf8_lossy(a[0])).map_err(failed)?;
                for more in &a[3..] {
                    write!(w, ",{}", String::from_utf8_lossy(more)).map_err(failed)?;
                }
                w.write_all(b");").map_err(failed)?;
                for v in [s, e] {
                    if let Some(point) = point_of.get(&v).filter(|_| written.insert(v)) {
                        write!(w, "\n#{v}=VERTEX_POINT('',#{point});").map_err(failed)?;
                    }
                }
                return Ok(());
            }
        }
        w.write_all(rec).map_err(failed)
    })?;
    w.flush().map_err(failed)?;
    Ok(Scan { faces, bad, repaired: Some(Repaired { file, fixed, unfixed: bad - fixed }) })
}

/// The first and last control point of each clamped B-spline curve asked for, through SURFACE_CURVE and SEAM_CURVE.
fn curve_ends(path: &Path, mut look: HashSet<Id>) -> Result<HashMap<Id, (Id, Id)>, String> {
    let mut found: HashMap<Id, (Id, Id)> = HashMap::new();
    let mut inner: HashMap<Id, Id> = HashMap::new();
    for _ in 0..3 {
        for_each_record(path, |rec| {
            let Some((id, kind, rest)) = head(rec).filter(|h| look.contains(&h.0)) else { return Ok(()) };
            let a = args(rest);
            match kind {
                b"B_SPLINE_CURVE_WITH_KNOTS" => {
                    let number = |s: &[u8]| -> Option<usize> { std::str::from_utf8(trim(s)).ok()?.parse().ok() };
                    let degree = a.get(1).and_then(|d| number(d));
                    let points: Vec<Id> = a.get(2).map(|l| list(l).filter_map(reference).collect()).unwrap_or_default();
                    let mults: Vec<usize> = a.get(6).map(|l| list(l).filter_map(number).collect()).unwrap_or_default();
                    let clamped =
                        degree.is_some_and(|d| mults.first() == Some(&(d + 1)) && mults.last() == Some(&(d + 1)));
                    if let (true, Some(&first), Some(&last)) = (clamped, points.first(), points.last()) {
                        found.insert(id, (first, last));
                    }
                }
                b"SURFACE_CURVE" | b"SEAM_CURVE" => {
                    if let Some(c) = a.get(1).and_then(|r| reference(r)) {
                        inner.insert(id, c);
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
        let more: Vec<Id> = inner.values().filter(|c| !look.contains(c)).copied().collect();
        if more.is_empty() {
            break;
        }
        look.extend(more);
    }
    for (wrapper, curve) in &inner {
        if let Some(&ends) = found.get(curve) {
            found.insert(*wrapper, ends);
        }
    }
    Ok(found)
}

/// The coordinates of each CARTESIAN_POINT asked for, a 2D point at z 0.
fn points(path: &Path, look: HashSet<Id>) -> Result<HashMap<Id, [f64; 3]>, String> {
    let mut found: HashMap<Id, [f64; 3]> = HashMap::new();
    if look.is_empty() {
        return Ok(found);
    }
    for_each_record(path, |rec| {
        let Some((id, b"CARTESIAN_POINT", rest)) = head(rec).filter(|h| look.contains(&h.0)) else { return Ok(()) };
        let a = args(rest);
        let xyz: Vec<f64> = a
            .get(1)
            .map(|l| list(l).filter_map(|n| std::str::from_utf8(trim(n)).ok()?.parse().ok()).collect())
            .unwrap_or_default();
        if (2..=3).contains(&xyz.len()) {
            found.insert(id, [xyz[0], xyz[1], xyz.get(2).copied().unwrap_or(0.0)]);
        }
        Ok(())
    })?;
    Ok(found)
}

/// Within a millionth of the model's reach, whatever its length unit.
fn close(p: &[f64; 3], q: &[f64; 3]) -> bool {
    let reach = p.iter().chain(q).fold(1.0f64, |m, c| m.max(c.abs()));
    let d = (0..3).map(|i| (p[i] - q[i]).powi(2)).sum::<f64>().sqrt();
    d <= 1e-6 * reach
}

/// The items of `(a,b,c)`.
fn list(s: &[u8]) -> impl Iterator<Item = &[u8]> {
    let s = trim(s);
    let s = s.strip_prefix(b"(").and_then(|s| s.strip_suffix(b")")).unwrap_or(s);
    s.split(|&b| b == b',')
}

/// Past this a quote never closed, so the scan gives up rather than hold the rest of the file.
const MAX_RECORD: usize = 64 << 20;

/// Every `;` ended record, a `;` inside a quoted string kept in its record.
fn for_each_record(path: &Path, mut f: impl FnMut(&[u8]) -> Result<(), String>) -> Result<(), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut rec: Vec<u8> = Vec::new();
    let mut quoted = false;
    loop {
        let mut i = rec.len();
        if reader.read_until(b';', &mut rec).map_err(|e| e.to_string())? == 0 {
            return if rec.is_empty() { Ok(()) } else { f(&rec) };
        }
        while i < rec.len() {
            i += if rec[i] == b'\'' { quote_at(&rec, i, &mut quoted) } else { 1 };
        }
        if quoted {
            if rec.len() > MAX_RECORD {
                return Err(format!("a quoted string runs past {} MiB", MAX_RECORD >> 20));
            }
            continue;
        }
        f(&rec)?;
        rec.clear();
    }
}

/// Steps over the `'` at `s[i]`, answering how many bytes it took. A quote inside a string closes it only before a
/// `,`, `)` or `;`, so a stray apostrophe an exporter left in a name stays in its string.
fn quote_at(s: &[u8], i: usize, quoted: &mut bool) -> usize {
    if !*quoted {
        *quoted = true;
        return 1;
    }
    if s.get(i + 1) == Some(&b'\'') {
        return 2;
    }
    let next = s[i + 1..].iter().find(|b| !b.is_ascii_whitespace());
    *quoted = !matches!(next, None | Some(b',' | b')' | b';'));
    1
}

/// `#12 = NAME(...)` as (12, NAME, `(...)`), NAME empty for a complex entity.
fn head(rec: &[u8]) -> Option<(Id, &[u8], &[u8])> {
    let mut s = trim_start(rec);
    while let Some(comment) = s.strip_prefix(b"/*") {
        let close = comment.windows(2).position(|w| w == b"*/")?;
        s = trim_start(&comment[close + 2..]);
    }
    let s = s.strip_prefix(b"#")?;
    let digits = s.iter().take_while(|b| b.is_ascii_digit()).count();
    let id = std::str::from_utf8(&s[..digits]).ok()?.parse().ok()?;
    let rest = trim_start(trim_start(&s[digits..]).strip_prefix(b"=")?);
    let name = rest.iter().take_while(|&&b| b.is_ascii_alphanumeric() || b == b'_').count();
    Some((id, &rest[..name], &rest[name..]))
}

/// The top level arguments of `(a,b,(c,d),'e,f')`.
fn args(s: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let (mut depth, mut quoted, mut from) = (0usize, false, 0usize);
    let mut i = 0;
    while i < s.len() {
        let b = s[i];
        if b == b'\'' {
            i += quote_at(s, i, &mut quoted);
            continue;
        }
        match b {
            _ if quoted => {}
            b'(' => {
                depth += 1;
                if depth == 1 {
                    from = i + 1;
                }
            }
            b')' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    out.push(&s[from..i]);
                    return out;
                }
            }
            b',' if depth == 1 => {
                out.push(&s[from..i]);
                from = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn reference(a: &[u8]) -> Option<Id> {
    let a = trim(a);
    let a = a.strip_prefix(b"(").unwrap_or(a);
    let a = a.strip_suffix(b")").unwrap_or(a);
    std::str::from_utf8(trim(a).strip_prefix(b"#")?).ok()?.trim().parse().ok()
}

fn trim_start(s: &[u8]) -> &[u8] {
    let n = s.iter().take_while(|b| b.is_ascii_whitespace()).count();
    &s[n..]
}

fn trim(s: &[u8]) -> &[u8] {
    let s = trim_start(s);
    let n = s.iter().rev().take_while(|b| b.is_ascii_whitespace()).count();
    &s[..s.len() - n]
}
