//! Some exporters (SolidWorks 2014 seen) write an EDGE_CURVE whose start or end names another entity where a
//! VERTEX_POINT belongs. OCCT then drops the whole shell based model that face sits in without an error, so the
//! vertex is taken back from the edge next to it in the face's loop, or made at the end of the edge's curve, and the
//! file is read from a repaired copy.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
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
    /// Records naming another document, which OCCT would open and read beside this file.
    pub documents: usize,
    /// A copy with the vertices put back and the document references left out, when either was needed.
    pub repaired: Option<Repaired>,
}

impl Scan {
    pub fn documents_note(&self) -> Option<String> {
        match self.documents {
            0 => None,
            1 => Some(
                "1 external document named by this STEP file was not loaded, FundaCAD reads only the file itself."
                    .into(),
            ),
            n => Some(format!(
                "{n} external documents named by this STEP file were not loaded, FundaCAD reads only the file itself."
            )),
        }
    }

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
    let mut holds: HashMap<Id, Vec<Id>> = HashMap::new();
    let (mut mapped, mut maps): (HashMap<Id, Id>, HashMap<Id, Id>) = (HashMap::new(), HashMap::new());
    let (mut faces, mut last_id, mut documents) = (0usize, 0, 0usize);
    for_each_record(path, |rec, _| {
        let Some((id, kind, rest)) = head(rec) else { return Ok(()) };
        last_id = last_id.max(id);
        let parts: Vec<(&[u8], &[u8])> =
            if kind.is_empty() { complex_parts(rest).collect() } else { vec![(kind, rest)] };
        for (name, a) in &parts {
            let second = || args(a).get(1).and_then(|r| reference(r));
            if named(name, "MAPPED_ITEM", "MPPITM") {
                mapped.extend(second().map(|map| (id, map)));
            } else if named(name, "REPRESENTATION_MAP", "RPRMP") {
                maps.extend(second().map(|rep| (id, rep)));
            }
        }
        if document_ref(kind).is_some() {
            documents += 1;
        } else if is_usage(kind) {
            if let Some((parent, child)) = usage_ends(&args(rest)) {
                holds.entry(parent).or_default().push(child);
            }
        } else if kind.is_empty() {
            if parts.iter().any(|(n, _)| document_ref(n).is_some()) {
                return Err(
                    "this STEP file names an external document inside a complex entity, which FundaCAD does not read"
                        .into(),
                );
            }
            if parts.iter().any(|(n, _)| is_usage(n)) {
                let relationship = parts
                    .iter()
                    .find(|(n, _)| n.eq_ignore_ascii_case(b"PRODUCT_DEFINITION_RELATIONSHIP"))
                    .map(|(_, a)| args(a));
                let Some((parent, child)) = relationship.as_deref().and_then(usage_ends) else {
                    return Err("this STEP file places an assembly part through a complex entity whose parent and \
                                part FundaCAD cannot find"
                        .into());
                };
                holds.entry(parent).or_default().push(child);
            }
        }
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
    match assembly_depth(&holds) {
        None => return Err("this STEP assembly holds itself through its own parts, so it has no end to place".into()),
        Some(depth) if depth > MAX_DEPTH => {
            return Err(format!(
                "this STEP assembly is nested more than {MAX_DEPTH} levels deep, which FundaCAD does not import"
            ))
        }
        Some(_) => {}
    }
    if !mapped.is_empty() {
        match assembly_depth(&mapped_nesting(path, &mapped, &maps)?) {
            None => {
                return Err(
                    "this STEP file places a shape inside itself through its mapped items, so it has no end to place"
                        .into(),
                )
            }
            Some(depth) if depth > MAX_DEPTH => {
                return Err(format!(
                    "this STEP file nests shapes more than {MAX_DEPTH} levels deep through mapped items, which \
                     FundaCAD does not import"
                ))
            }
            Some(_) => {}
        }
    }
    let is_vertex = |v: &Id| vertices.contains(v);
    let mut ends: BTreeMap<Id, (Id, Id)> = edges
        .iter()
        .filter(|(_, e)| !is_vertex(&e.start) || !is_vertex(&e.end))
        .map(|(&id, e)| (id, (e.start, e.end)))
        .collect();
    let bad = ends.len();
    if bad == 0 && documents == 0 {
        return Ok(Scan { faces, bad, documents, repaired: None });
    }

    let mut oriented: HashMap<Id, (Id, bool)> = HashMap::new();
    let mut loops: Vec<Vec<Id>> = Vec::new();
    for_each_record(path, |rec, _| {
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
    let side = |oe: Id, start: bool, ends: &BTreeMap<Id, (Id, Id)>| -> Option<Id> {
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
    // end control point of the clamped B-spline edges that use it, only where they all end at one place, none misses
    // a known vertex at its other end, and a second curve or such a vertex vouches for the place.
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
        let mut place: BTreeMap<Id, Option<(Id, bool)>> = BTreeMap::new();
        for &(v, curve, at_start, other) in &uses {
            let Some(&(first, last)) = curves.get(&curve) else { continue };
            let (here, there) = if at_start { (first, last) } else { (last, first) };
            let whole = vertex_at.get(&other).map(|&p| same(p, there));
            let next = match place.get(&v) {
                None => Some((here, whole == Some(true))),
                Some(&seen) => seen.filter(|&(p, _)| same(p, here)).map(|(p, _)| (p, true)),
            };
            place.insert(v, next.filter(|_| whole != Some(false)));
        }
        let mut made: HashMap<Id, Id> = HashMap::new();
        for (v, point) in place {
            if let Some((point, true)) = point {
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
    if ends.is_empty() && documents == 0 {
        return Ok(Scan { faces, bad, documents, repaired: None });
    }

    let (file, out) = temp_step()?;
    let failed = |e: std::io::Error| format!("couldn't write the repaired STEP file into the temp folder ({e})");
    let mut w = BufWriter::with_capacity(1 << 20, out);
    let mut written: HashSet<Id> = HashSet::new();
    let mut source = File::open(path).map_err(|e| format!("{UNCHECKED}{e}"))?;
    for_each_record(path, |rec, cut| {
        if let Some(Cut { at, len }) = cut {
            source.seek(SeekFrom::Start(at)).map_err(failed)?;
            return std::io::copy(&mut (&mut source).take(len), &mut w).map(drop).map_err(failed);
        }
        let record = head(rec);
        match record.and_then(|(_, kind, rest)| Some((document_ref(kind)?, kind, rest))) {
            Some((DocumentRef::Applied, ..)) => return Ok(()),
            Some((DocumentRef::Product, kind, rest)) => {
                let a = args(rest);
                w.write_all(&rec[..rec.len() - rest.len() - kind.len()]).map_err(failed)?;
                w.write_all(b"PRODUCT_DEFINITION(").map_err(failed)?;
                w.write_all(&a[..a.len().min(4)].join(&b","[..])).map_err(failed)?;
                return w.write_all(b");").map_err(failed);
            }
            None => {}
        }
        if let Some((id, b"EDGE_CURVE", rest)) = record {
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
    Ok(Scan { faces, bad, documents, repaired: Some(Repaired { file, fixed, unfixed: bad - fixed }) })
}

#[derive(Clone, Copy)]
enum DocumentRef {
    Applied,
    Product,
}

/// The entity names, long and short, that OCCT's XCAF reader follows to another file.
fn document_ref(kind: &[u8]) -> Option<DocumentRef> {
    let is = |name: &str| kind.eq_ignore_ascii_case(name.as_bytes());
    if is("APPLIED_DOCUMENT_REFERENCE") || is("APDCRF") {
        Some(DocumentRef::Applied)
    } else if is("PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS") || is("PDWAD") {
        Some(DocumentRef::Product)
    } else {
        None
    }
}

fn is_usage(kind: &[u8]) -> bool {
    named(kind, "NEXT_ASSEMBLY_USAGE_OCCURRENCE", "NAUO")
}

fn named(kind: &[u8], long: &str, short: &str) -> bool {
    kind.eq_ignore_ascii_case(long.as_bytes()) || kind.eq_ignore_ascii_case(short.as_bytes())
}

/// For each record holding a mapped item, the representations that item places inside it.
fn mapped_nesting(
    path: &Path,
    mapped: &HashMap<Id, Id>,
    maps: &HashMap<Id, Id>,
) -> Result<HashMap<Id, Vec<Id>>, String> {
    let mut nests: HashMap<Id, Vec<Id>> = HashMap::new();
    for_each_record(path, |rec, cut| {
        if cut.is_some() {
            return Err(format!(
                "{UNCHECKED}a record too long to check whole sits in a file that places shapes through mapped items"
            ));
        }
        let Some((id, _, rest)) = head(rec) else { return Ok(()) };
        let placed = references(rest).filter_map(|r| maps.get(mapped.get(&r)?));
        let placed: Vec<Id> = placed.copied().collect();
        if !placed.is_empty() {
            nests.entry(id).or_default().extend(placed);
        }
        Ok(())
    })?;
    Ok(nests)
}

/// Every `#id` outside a quoted string.
fn references(s: &[u8]) -> impl Iterator<Item = Id> + '_ {
    let (mut i, mut quoted) = (0usize, false);
    std::iter::from_fn(move || {
        while i < s.len() {
            if s[i] == b'\'' {
                i += quote_at(s, i, &mut quoted);
                continue;
            }
            i += 1;
            if quoted || s[i - 1] != b'#' {
                continue;
            }
            let digits = s[i..].iter().take_while(|b| b.is_ascii_digit()).count();
            let id = std::str::from_utf8(&s[i..i + digits]).ok()?.parse().ok();
            i += digits;
            if id.is_some() {
                return id;
            }
        }
        None
    })
}

/// The relating (parent) and related (part) product definitions of a usage, its arguments 3 and 4.
fn usage_ends(a: &[&[u8]]) -> Option<(Id, Id)> {
    Some((reference(a.get(3)?)?, reference(a.get(4)?)?))
}

/// max_depth in xcaf.hxx, checked here too since OCCT's own transfer walks every level before that walk runs.
const MAX_DEPTH: usize = 256;

/// The most assembly levels above any part, or None when a product definition reaches itself through the parts
/// it holds, searched without recursion.
fn assembly_depth(holds: &HashMap<Id, Vec<Id>>) -> Option<usize> {
    // None while on the current path, then the levels below it once every part below it is known to end.
    let mut state: HashMap<Id, Option<usize>> = HashMap::new();
    let mut deepest = 0;
    for &root in holds.keys() {
        if state.contains_key(&root) {
            continue;
        }
        state.insert(root, None);
        let mut stack: Vec<(Id, usize)> = vec![(root, 0)];
        while let Some(top) = stack.last_mut() {
            let (node, i) = *top;
            let children = holds.get(&node).map_or(&[][..], Vec::as_slice);
            let Some(&child) = children.get(i) else {
                let below = children.iter().filter_map(|c| state.get(c).copied().flatten()).max();
                let levels = below.map_or(0, |b| b + 1);
                deepest = deepest.max(levels);
                state.insert(node, Some(levels));
                stack.pop();
                continue;
            };
            top.1 += 1;
            match state.get(&child) {
                Some(None) => return None,
                Some(Some(_)) => {}
                None => {
                    state.insert(child, None);
                    stack.push((child, 0));
                }
            }
        }
    }
    Some(deepest)
}

/// Every unquoted name followed by `(` in the parts of a complex entity, with the text from its `(` on.
fn complex_parts(s: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    let (mut i, mut quoted) = (0usize, false);
    std::iter::from_fn(move || {
        while i < s.len() {
            if s[i] == b'\'' {
                i += quote_at(s, i, &mut quoted);
                continue;
            }
            if quoted || !s[i].is_ascii_alphabetic() || (i > 0 && ident(s[i - 1])) {
                i += 1;
                continue;
            }
            let from = i;
            while i < s.len() && ident(s[i]) {
                i += 1;
            }
            let tail = trim_start(&s[i..]);
            if tail.starts_with(b"(") {
                return Some((&s[from..i], tail));
            }
        }
        None
    })
}

/// The first and last control point of each clamped B-spline curve asked for, through SURFACE_CURVE and SEAM_CURVE.
fn curve_ends(path: &Path, mut look: HashSet<Id>) -> Result<HashMap<Id, (Id, Id)>, String> {
    let mut found: HashMap<Id, (Id, Id)> = HashMap::new();
    let mut inner: HashMap<Id, Id> = HashMap::new();
    for _ in 0..3 {
        for_each_record(path, |rec, _| {
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
    for_each_record(path, |rec, _| {
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

const UNCHECKED: &str = "FundaCAD could not check this STEP file before reading it: ";

/// The bytes held of one record. Past this (a quote left open, or a huge list) the rest is read in pieces and only
/// searched for the names in WATCHED.
const MAX_RECORD: usize = 64 << 20;
const PIECE: u64 = 1 << 20;

/// The entities the checks above read, long and short names.
const WATCHED: [&str; 10] = [
    "APPLIED_DOCUMENT_REFERENCE",
    "APDCRF",
    "PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS",
    "PDWAD",
    "NEXT_ASSEMBLY_USAGE_OCCURRENCE",
    "NAUO",
    "MAPPED_ITEM",
    "MPPITM",
    "REPRESENTATION_MAP",
    "RPRMP",
];
/// Longer than any name in WATCHED, so a name split between two pieces is whole in the second.
const OVERLAP: usize = 64;

/// The place in the file of a record longer than MAX_RECORD, which is handed over cut to that length.
#[derive(Clone, Copy)]
struct Cut {
    at: u64,
    len: u64,
}

/// Every `;` ended record, a `;` inside a quoted string kept in its record. A record that is cut, or that the file
/// ends inside, is refused when its text names one of WATCHED, since what it holds cannot be read as records.
fn for_each_record(path: &Path, mut f: impl FnMut(&[u8], Option<Cut>) -> Result<(), String>) -> Result<(), String> {
    let io = |e: std::io::Error| format!("{UNCHECKED}{e}");
    let refused = || format!("{UNCHECKED}a record FundaCAD cannot read to its end names one of the entities it checks");
    let mut reader = BufReader::with_capacity(1 << 20, File::open(path).map_err(io)?);
    let (mut rec, mut piece): (Vec<u8>, Vec<u8>) = (Vec::new(), Vec::new());
    let (mut quoted, mut at, mut len) = (false, 0u64, 0u64);
    // Set once the record is cut: whether the next piece opens inside a name already too long to be watched.
    let mut spill: Option<bool> = None;
    loop {
        let buf = if spill.is_some() { &mut piece } else { &mut rec };
        let from = buf.len();
        let room = if spill.is_some() { PIECE } else { (MAX_RECORD + 1 - from) as u64 };
        let n = (&mut reader).take(room).read_until(b';', buf).map_err(io)?;
        let mut i = from;
        while i < buf.len() {
            i += if buf[i] == b'\'' { quote_at(buf, i, &mut quoted) } else { 1 };
        }
        len += n as u64;
        let eof = n == 0;
        let ended = !eof && !quoted && buf.last() == Some(&b';');
        if let Some(skip) = spill {
            if watched(&piece, skip, eof || ended) {
                return Err(refused());
            }
            let (keep, skip) = overlap(&piece, skip);
            piece.drain(..keep);
            spill = Some(skip);
        } else if eof {
            if rec.is_empty() {
                return Ok(());
            }
            if watched(&rec, false, true) {
                return Err(refused());
            }
        } else if !ended && rec.len() > MAX_RECORD {
            if watched(&rec, false, false) {
                return Err(refused());
            }
            let (keep, skip) = overlap(&rec, false);
            piece.extend_from_slice(&rec[keep..]);
            spill = Some(skip);
        }
        if !eof && !ended {
            continue;
        }
        f(&rec, spill.map(|_| Cut { at, len }))?;
        if eof {
            return Ok(());
        }
        (at, len, spill) = (at + len, 0, None);
        rec.clear();
        piece.clear();
    }
}

fn ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Whether `s` holds a name in WATCHED as a whole word, leaving out a word at its start when `skip_first` (it began
/// in an earlier piece) and a word at its end unless `to_end` (it may go on in the next piece).
fn watched(s: &[u8], skip_first: bool, to_end: bool) -> bool {
    let mut i = 0;
    while i < s.len() {
        if !ident(s[i]) {
            i += 1;
            continue;
        }
        let from = i;
        while i < s.len() && ident(s[i]) {
            i += 1;
        }
        if (from == 0 && skip_first) || (i == s.len() && !to_end) {
            continue;
        }
        if WATCHED.iter().any(|w| s[from..i].eq_ignore_ascii_case(w.as_bytes())) {
            return true;
        }
    }
    false
}

/// Where in `s` the next piece starts from, so a word cut at its end is read whole there, and whether that start is
/// inside a word too long to be watched.
fn overlap(s: &[u8], skip: bool) -> (usize, bool) {
    let from = s.len().saturating_sub(OVERLAP);
    match s[from..].iter().rposition(|&b| !ident(b)) {
        Some(p) => (from + p, false),
        None if from == 0 => (0, skip),
        None => (s.len(), true),
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
