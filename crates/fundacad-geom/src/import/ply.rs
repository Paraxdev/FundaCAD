//! Stanford PLY, ascii and both binary byte orders, every element read so an
//! unknown one is stepped over. Millimetres, as STL.

use super::mesh::{dominant_color, MeshObject};
use super::scan::{too_dense_for_a_scan, MAX_SCAN_TRIANGLES};

fn bad(why: &str) -> String {
    format!("couldn't read this PLY file, {why}")
}

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Ascii,
    Little,
    Big,
}

#[derive(Clone, Copy)]
enum Scalar {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl Scalar {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "char" | "int8" => Self::I8,
            "uchar" | "uint8" => Self::U8,
            "short" | "int16" => Self::I16,
            "ushort" | "uint16" => Self::U16,
            "int" | "int32" => Self::I32,
            "uint" | "uint32" => Self::U32,
            "float" | "float32" => Self::F32,
            "double" | "float64" => Self::F64,
            _ => return None,
        })
    }

    fn size(self) -> usize {
        match self {
            Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::F64 => 8,
        }
    }
}

struct Property {
    name: String,
    kind: Scalar,
    list: Option<Scalar>,
}

struct Element {
    name: String,
    count: usize,
    props: Vec<Property>,
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
    format: Format,
}

impl Reader<'_> {
    fn token(&mut self) -> Result<&str, String> {
        while self.at < self.data.len() && self.data[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
        let start = self.at;
        while self.at < self.data.len() && !self.data[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
        if start == self.at {
            return Err(bad("it ends before all its elements are read"));
        }
        std::str::from_utf8(&self.data[start..self.at]).map_err(|_| bad("a value is not a number"))
    }

    fn value(&mut self, kind: Scalar) -> Result<f64, String> {
        if self.format == Format::Ascii {
            let t = self.token()?;
            return t.parse::<f64>().map_err(|_| bad(&format!("'{t}' is not a number")));
        }
        let n = kind.size();
        let b = self.data.get(self.at..self.at + n).ok_or_else(|| bad("it ends before all its elements are read"))?;
        self.at += n;
        let mut a = [0u8; 8];
        a[..n].copy_from_slice(b);
        if self.format == Format::Big {
            a[..n].reverse();
        }
        Ok(match kind {
            Scalar::I8 => f64::from(a[0] as i8),
            Scalar::U8 => f64::from(a[0]),
            Scalar::I16 => f64::from(i16::from_le_bytes([a[0], a[1]])),
            Scalar::U16 => f64::from(u16::from_le_bytes([a[0], a[1]])),
            Scalar::I32 => f64::from(i32::from_le_bytes([a[0], a[1], a[2], a[3]])),
            Scalar::U32 => f64::from(u32::from_le_bytes([a[0], a[1], a[2], a[3]])),
            Scalar::F32 => f64::from(f32::from_le_bytes([a[0], a[1], a[2], a[3]])),
            Scalar::F64 => f64::from_le_bytes(a),
        })
    }
}

fn header(data: &[u8]) -> Result<(Format, Vec<Element>, usize), String> {
    let not_ply = || bad("it does not start with a PLY header");
    if !data.starts_with(b"ply") {
        return Err(not_ply());
    }
    let mut format = None;
    let mut elements: Vec<Element> = Vec::new();
    let mut at = 0;
    loop {
        let end = data[at..].iter().position(|&b| b == b'\n').ok_or_else(not_ply)? + at;
        let line = std::str::from_utf8(&data[at..end]).map_err(|_| not_ply())?.trim();
        at = end + 1;
        let w: Vec<&str> = line.split_whitespace().collect();
        match w.as_slice() {
            ["end_header"] => break,
            ["format", f, _] => {
                format = Some(match *f {
                    "ascii" => Format::Ascii,
                    "binary_little_endian" => Format::Little,
                    "binary_big_endian" => Format::Big,
                    _ => return Err(bad(&format!("the '{f}' encoding is not known"))),
                })
            }
            ["element", name, count] => elements.push(Element {
                name: (*name).into(),
                count: count.parse().map_err(|_| bad("an element count is not a number"))?,
                props: Vec::new(),
            }),
            ["property", "list", n, k, name] => {
                let e = elements.last_mut().ok_or_else(not_ply)?;
                let list = Scalar::parse(n).ok_or_else(|| bad(&format!("the type '{n}' is not known")))?;
                let kind = Scalar::parse(k).ok_or_else(|| bad(&format!("the type '{k}' is not known")))?;
                e.props.push(Property { name: (*name).into(), kind, list: Some(list) });
            }
            ["property", k, name] => {
                let e = elements.last_mut().ok_or_else(not_ply)?;
                let kind = Scalar::parse(k).ok_or_else(|| bad(&format!("the type '{k}' is not known")))?;
                e.props.push(Property { name: (*name).into(), kind, list: None });
            }
            _ => {}
        }
    }
    Ok((format.ok_or_else(not_ply)?, elements, at))
}

fn channel(props: &[Property], row: &[f64], names: [&str; 3]) -> Option<[u8; 3]> {
    let mut c = [0.0; 3];
    for (k, n) in names.iter().enumerate() {
        let i = props.iter().position(|p| p.name == *n)?;
        c[k] = row[i];
    }
    let float = props.iter().any(|p| names.contains(&p.name.as_str()) && matches!(p.kind, Scalar::F32 | Scalar::F64));
    let scale = if float { 255.0 } else { 1.0 };
    Some(c.map(|v| (v * scale).round_ties_even().clamp(0.0, 255.0) as u8))
}

fn color_of(props: &[Property], row: &[f64]) -> Option<[u8; 3]> {
    channel(props, row, ["red", "green", "blue"])
        .or_else(|| channel(props, row, ["diffuse_red", "diffuse_green", "diffuse_blue"]))
}

pub fn read_ply(data: &[u8]) -> Result<MeshObject, String> {
    let (format, elements, body) = header(data)?;
    let faces = elements.iter().find(|e| e.name == "face").map_or(0, |e| e.count);
    if faces as u64 > MAX_SCAN_TRIANGLES {
        return Err(too_dense_for_a_scan(faces as u64));
    }
    let left = data.len() - body;
    for e in &elements {
        // Every row takes at least one byte (binary) or two (ascii), so a
        // count past what is left is a lie and must not size an allocation.
        if e.count > left {
            return Err(bad(&format!("it claims {} {} elements, more than the file holds", e.count, e.name)));
        }
    }
    let mut r = Reader { data, at: body, format };
    let mut verts: Vec<[f64; 3]> = Vec::new();
    let mut vcolor: Vec<Option<[u8; 3]>> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();
    let mut tcolor: Vec<Option<[u8; 3]>> = Vec::new();
    for e in &elements {
        let is_vertex = e.name == "vertex";
        let is_face = e.name == "face";
        let xyz: Option<[usize; 3]> = is_vertex
            .then(|| {
                let at = |n: &str| e.props.iter().position(|p| p.name == n && p.list.is_none());
                Some([at("x")?, at("y")?, at("z")?])
            })
            .flatten();
        if is_vertex && xyz.is_none() {
            return Err(bad("its vertices have no x, y and z"));
        }
        let corners =
            e.props.iter().position(|p| p.list.is_some() && (p.name == "vertex_indices" || p.name == "vertex_index"));
        if is_vertex {
            verts.reserve(e.count);
        }
        let mut row = vec![0.0; e.props.len()];
        let mut list: Vec<f64> = Vec::new();
        for _ in 0..e.count {
            for (k, p) in e.props.iter().enumerate() {
                match p.list {
                    None => row[k] = r.value(p.kind)?,
                    Some(lk) => {
                        let n = r.value(lk)?;
                        if !(0.0..=1e6).contains(&n) {
                            return Err(bad("a list length is out of range"));
                        }
                        let keep = Some(k) == corners && is_face;
                        if keep {
                            list.clear();
                        }
                        for _ in 0..n as usize {
                            let v = r.value(p.kind)?;
                            if keep {
                                list.push(v);
                            }
                        }
                    }
                }
            }
            if let Some([x, y, z]) = xyz {
                verts.push([row[x], row[y], row[z]]);
                vcolor.push(color_of(&e.props, &row));
            } else if is_face && corners.is_some() {
                let own = color_of(&e.props, &row);
                for k in 1..list.len().saturating_sub(1) {
                    for v in [list[0], list[k], list[k + 1]] {
                        if v < 0.0 || v as usize >= verts.len() {
                            return Err(bad("a face references a vertex that does not exist"));
                        }
                        idx.push(v as u32);
                    }
                    tcolor.push(own.or_else(|| vcolor.get(list[0] as usize).copied().flatten()));
                }
            }
        }
    }
    if idx.is_empty() {
        return Err(bad("it has no faces"));
    }
    Ok(MeshObject {
        name: None,
        color: dominant_color(tcolor.into_iter()),
        pos: verts.into_iter().flatten().collect(),
        idx,
    })
}
