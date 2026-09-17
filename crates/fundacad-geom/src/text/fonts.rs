//! System font discovery and family lookup, replacing OCCT's `Font_FontMgr`
//! as build123d drives it (build123d/text.py `FontManager`).
//!
//! Faces come from fontdb. Each one is registered under the names both
//! registrations of the Python engine give it: the kernel's own scan (the
//! typographic family plus any style words that are not an aspect) first, then
//! build123d's (the first name records in table order, variable font instances
//! included), which only fills aspects the first left empty. A lookup is by
//! lowercase name, then a few aliases, then Arial, then whatever sans serif
//! fontdb knows.

use std::collections::HashMap;
use std::sync::OnceLock;

use indexmap::IndexMap;
use ttf_parser::{name_id, Face, PlatformId, Tag};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aspect {
    Regular = 0,
    Bold = 1,
    Italic = 2,
    BoldItalic = 3,
}

impl Aspect {
    pub fn from_style(style: &str) -> Aspect {
        match style {
            "bold" => Aspect::Bold,
            "italic" => Aspect::Italic,
            "bolditalic" => Aspect::BoldItalic,
            _ => Aspect::Regular,
        }
    }
}

/// One face to draw with: a fontdb face and the variation it is drawn at.
#[derive(Debug, Clone)]
pub struct FaceRef {
    pub id: fontdb::ID,
    pub coords: Vec<(Tag, f32)>,
}

#[derive(Debug, Clone)]
struct SystemFont {
    name: String,
    aspects: [Option<FaceRef>; 4],
}

pub struct Library {
    pub db: fontdb::Database,
    fonts: IndexMap<String, SystemFont>,
}

/// The face a text entity draws with, and whether italic has to be made up.
pub struct Resolved<'a> {
    pub face: &'a FaceRef,
    pub synthetic_italic: bool,
}

static LIBRARY: OnceLock<Library> = OnceLock::new();

pub fn library() -> &'static Library {
    LIBRARY.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        Library::build(db)
    })
}

const ALIASES: &[(&str, &str)] = &[
    ("courier", "courier new"),
    ("times-roman", "times new roman"),
    ("times", "times new roman"),
    ("helvetica", "arial"),
    ("sans-serif", "arial"),
    ("serif", "times new roman"),
    ("monospace", "courier new"),
    ("singleline", "relief singleline cad"),
];

impl Library {
    pub fn build(db: fontdb::Database) -> Library {
        let mut faces: Vec<(String, fontdb::ID)> = db
            .faces()
            .map(|f| {
                let path = match &f.source {
                    fontdb::Source::File(p) => p.to_string_lossy().to_lowercase(),
                    fontdb::Source::SharedFile(p, _) => p.to_string_lossy().to_lowercase(),
                    fontdb::Source::Binary(_) => String::new(),
                };
                (format!("{path}\u{0}{:08}", f.index), f.id)
            })
            .collect();
        faces.sort();
        let mut kernel: Vec<(String, Aspect, FaceRef)> = Vec::new();
        let mut b123d: Vec<(String, Aspect, FaceRef)> = Vec::new();
        for (_, id) in &faces {
            db.with_face_data(*id, |data, index| {
                if let Ok(face) = Face::parse(data, index) {
                    kernel.extend(kernel_names(&face, *id));
                    b123d.extend(build123d_names(&face, *id));
                }
            });
        }
        let mut lib = Library {
            db,
            fonts: IndexMap::new(),
        };
        for (name, aspect, face) in kernel.into_iter().chain(b123d) {
            lib.register(name, aspect, face);
        }
        lib
    }

    fn register(&mut self, name: String, aspect: Aspect, face: FaceRef) {
        if name.is_empty() {
            return;
        }
        let entry = self
            .fonts
            .entry(name.to_lowercase())
            .or_insert_with(|| SystemFont {
                name,
                aspects: [None, None, None, None],
            });
        let slot = &mut entry.aspects[aspect as usize];
        if slot.is_none() {
            *slot = Some(face);
        }
    }

    /// `GetAvailableFontsNames`, sorted and deduplicated.
    pub fn families(&self) -> Vec<String> {
        let mut names: Vec<String> = self.fonts.values().map(|f| f.name.clone()).collect();
        names.sort();
        names.dedup();
        names
    }

    fn find(&self, name: &str) -> Option<&SystemFont> {
        let key = name.to_lowercase();
        if let Some(f) = self.fonts.get(&key) {
            return Some(f);
        }
        if let Some((_, to)) = ALIASES.iter().find(|(from, _)| *from == key) {
            if let Some(f) = self.fonts.get(*to) {
                return Some(f);
            }
        }
        if let Some(f) = self.fonts.get("arial") {
            return Some(f);
        }
        let id = self.db.query(&fontdb::Query {
            families: &[fontdb::Family::SansSerif],
            ..fontdb::Query::default()
        })?;
        let family = self.db.face(id)?.families.first()?.0.to_lowercase();
        self.fonts
            .get(&family)
            .or_else(|| self.fonts.values().next())
    }

    /// `FindFont` then `FontPathAny`: the aspect asked for, else regular with
    /// italic made up where one was asked for, else any aspect there is.
    pub fn resolve(&self, name: &str, aspect: Aspect) -> Option<Resolved<'_>> {
        let font = self.find(name)?;
        if let Some(face) = &font.aspects[aspect as usize] {
            return Some(Resolved {
                face,
                synthetic_italic: false,
            });
        }
        if let Some(face) = &font.aspects[Aspect::Regular as usize] {
            return Some(Resolved {
                face,
                synthetic_italic: matches!(aspect, Aspect::Italic | Aspect::BoldItalic),
            });
        }
        font.aspects.iter().flatten().next().map(|face| Resolved {
            face,
            synthetic_italic: false,
        })
    }
}

const MAC_ROMAN_HIGH: &str = "\u{c4}\u{c5}\u{c7}\u{c9}\u{d1}\u{d6}\u{dc}\u{e1}\u{e0}\u{e2}\u{e4}\u{e3}\u{e5}\u{e7}\u{e9}\u{e8}\u{ea}\u{eb}\u{ed}\u{ec}\u{ee}\u{ef}\u{f1}\u{f3}\u{f2}\u{f4}\u{f6}\u{f5}\u{fa}\u{f9}\u{fb}\u{fc}\u{2020}\u{b0}\u{a2}\u{a3}\u{a7}\u{2022}\u{b6}\u{df}\u{ae}\u{a9}\u{2122}\u{b4}\u{a8}\u{2260}\u{c6}\u{d8}\u{221e}\u{b1}\u{2264}\u{2265}\u{a5}\u{b5}\u{2202}\u{2211}\u{220f}\u{3c0}\u{222b}\u{aa}\u{ba}\u{3a9}\u{e6}\u{f8}\u{bf}\u{a1}\u{ac}\u{221a}\u{192}\u{2248}\u{2206}\u{ab}\u{bb}\u{2026}\u{a0}\u{c0}\u{c3}\u{d5}\u{152}\u{153}\u{2013}\u{2014}\u{201c}\u{201d}\u{2018}\u{2019}\u{f7}\u{25ca}\u{ff}\u{178}\u{2044}\u{20ac}\u{2039}\u{203a}\u{fb01}\u{fb02}\u{2021}\u{b7}\u{201a}\u{201e}\u{2030}\u{c2}\u{ca}\u{c1}\u{cb}\u{c8}\u{cd}\u{ce}\u{cf}\u{cc}\u{d3}\u{d4}\u{f8ff}\u{d2}\u{da}\u{db}\u{d9}\u{131}\u{2c6}\u{2dc}\u{af}\u{2d8}\u{2d9}\u{2da}\u{b8}\u{2dd}\u{2db}\u{2c7}";

/// A name record as fontTools `toUnicode` decodes it, `None` where it raises.
fn decode(n: &ttf_parser::name::Name<'_>) -> Option<String> {
    match (n.platform_id, n.encoding_id) {
        (PlatformId::Unicode, _) | (PlatformId::Windows, 0 | 1 | 10) => {
            if n.name.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = n
                .name
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16(&units).ok()
        }
        (PlatformId::Macintosh, 0) => {
            let high: Vec<char> = MAC_ROMAN_HIGH.chars().collect();
            Some(
                n.name
                    .iter()
                    .map(|&b| {
                        if b < 0x80 {
                            char::from(b)
                        } else {
                            high[usize::from(b - 0x80)]
                        }
                    })
                    .collect(),
            )
        }
        _ => None,
    }
}

/// The first decodable record with this id, in table order.
fn first_name(face: &Face<'_>, id: u16) -> Option<String> {
    face.names()
        .into_iter()
        .filter(|n| n.name_id == id)
        .find_map(|n| decode(&n))
}

/// The English record FreeType prefers: Windows US English, any Windows, then
/// Mac Roman English.
fn english_name(face: &Face<'_>, id: u16) -> Option<String> {
    let names: Vec<_> = face.names().into_iter().filter(|n| n.name_id == id).collect();
    let pick = |f: &dyn Fn(&ttf_parser::name::Name<'_>) -> bool| {
        names.iter().filter(|n| f(n)).find_map(|n| decode(n))
    };
    pick(&|n| n.platform_id == PlatformId::Windows && n.language_id == 0x409)
        .or_else(|| pick(&|n| n.platform_id == PlatformId::Windows))
        .or_else(|| pick(&|n| n.platform_id == PlatformId::Macintosh && n.language_id == 0))
        .filter(|s| !s.is_empty())
}

struct Instance {
    subfamily: u16,
    coords: Vec<(Tag, f32)>,
}

fn be16(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*d.get(at)?, *d.get(at + 1)?]))
}

fn fixed(d: &[u8], at: usize) -> Option<f32> {
    let v = i32::from_be_bytes([*d.get(at)?, *d.get(at + 1)?, *d.get(at + 2)?, *d.get(at + 3)?]);
    #[allow(clippy::cast_precision_loss)]
    Some(v as f32 / 65536.0)
}

/// The named instances of a variable font's `fvar` table.
fn instances(face: &Face<'_>) -> Vec<Instance> {
    let Some(d) = face.raw_face().table(Tag::from_bytes(b"fvar")) else {
        return Vec::new();
    };
    let parse = || -> Option<Vec<Instance>> {
        let axes_at = usize::from(be16(d, 4)?);
        let axis_count = usize::from(be16(d, 8)?);
        let axis_size = usize::from(be16(d, 10)?);
        let count = usize::from(be16(d, 12)?);
        let size = usize::from(be16(d, 14)?);
        let mut tags = Vec::with_capacity(axis_count);
        for a in 0..axis_count {
            let at = axes_at + a * axis_size;
            tags.push(Tag::from_bytes(d.get(at..at + 4)?.try_into().ok()?));
        }
        let first = axes_at + axis_count * axis_size;
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let at = first + i * size;
            let subfamily = be16(d, at)?;
            let mut coords = Vec::with_capacity(axis_count);
            for (k, tag) in tags.iter().enumerate() {
                coords.push((*tag, fixed(d, at + 4 + k * 4)?));
            }
            out.push(Instance { subfamily, coords });
        }
        Some(out)
    };
    parse().unwrap_or_default()
}

const ASPECT_WORDS: [&str; 4] = ["Regular", "Bold", "Italic", "Oblique"];

/// build123d `_get_font_faces`: a subfamily's aspect and the name it leaves.
fn split_subfamily(family: &str, subfamily: &str) -> (String, Aspect) {
    let labels: Vec<&str> = subfamily.split_whitespace().collect();
    let has = |w: &str| labels.contains(&w);
    let italic = has("Italic") || has("Oblique");
    let (kept, aspect): (Vec<&str>, Aspect) = if has("Bold") {
        (
            labels
                .iter()
                .copied()
                .filter(|l| !matches!(*l, "Bold" | "Italic" | "Oblique"))
                .collect(),
            if italic {
                Aspect::BoldItalic
            } else {
                Aspect::Bold
            },
        )
    } else if italic {
        (
            labels
                .iter()
                .copied()
                .filter(|l| !matches!(*l, "Italic" | "Oblique"))
                .collect(),
            Aspect::Italic,
        )
    } else if has("Regular") {
        (Vec::new(), Aspect::Regular)
    } else {
        (labels, Aspect::Regular)
    };
    let sub = kept.join(" ");
    let name = if sub.is_empty() {
        family.to_owned()
    } else {
        format!("{family} {sub}")
    };
    (name.trim().to_owned(), aspect)
}

fn build123d_names(face: &Face<'_>, id: fontdb::ID) -> Vec<(String, Aspect, FaceRef)> {
    let family = first_name(face, name_id::TYPOGRAPHIC_FAMILY)
        .filter(|s| !s.is_empty())
        .or_else(|| first_name(face, name_id::FAMILY))
        .unwrap_or_default();
    let inst = instances(face);
    let subfamilies: Vec<String> = if face.raw_face().table(Tag::from_bytes(b"fvar")).is_some() {
        let ids: Vec<u16> = inst.iter().map(|i| i.subfamily).collect();
        face.names()
            .into_iter()
            .filter(|n| ids.contains(&n.name_id))
            .filter_map(|n| decode(&n))
            .collect()
    } else {
        vec![first_name(face, name_id::SUBFAMILY).unwrap_or_default()]
    };
    subfamilies
        .iter()
        .enumerate()
        .map(|(i, sub)| {
            let (name, aspect) = split_subfamily(&family, sub);
            // Note: build123d numbers the face `i << 16` by the name record's
            // position, which FreeType reads as named instance i, 0 the default.
            let coords = if i == 0 {
                Vec::new()
            } else {
                inst.get(i - 1).map(|x| x.coords.clone()).unwrap_or_default()
            };
            (name, aspect, FaceRef { id, coords })
        })
        .collect()
}

fn kernel_names(face: &Face<'_>, id: fontdb::ID) -> Vec<(String, Aspect, FaceRef)> {
    let typographic = english_name(face, name_id::TYPOGRAPHIC_FAMILY);
    let family = typographic
        .clone()
        .or_else(|| english_name(face, name_id::FAMILY))
        .unwrap_or_default();
    let default_style = if typographic.is_some() {
        english_name(face, name_id::TYPOGRAPHIC_SUBFAMILY)
            .or_else(|| english_name(face, name_id::SUBFAMILY))
    } else {
        english_name(face, name_id::SUBFAMILY)
    }
    .unwrap_or_default();
    let flags = match face.tables().os2 {
        Some(os2) => (os2.is_bold(), os2.style() != ttf_parser::Style::Normal),
        None => (face.is_bold(), face.is_italic()),
    };
    let one = |style: &str, coords: Vec<(Tag, f32)>| {
        let aspect = match flags {
            (true, true) => Aspect::BoldItalic,
            (true, false) => Aspect::Bold,
            (false, true) => Aspect::Italic,
            (false, false) if style == "Oblique" => Aspect::Italic,
            (false, false) => Aspect::Regular,
        };
        let extra: Vec<&str> = style
            .split_whitespace()
            .filter(|w| !ASPECT_WORDS.contains(w) && *w != "Book")
            .collect();
        let name = if extra.is_empty() {
            family.clone()
        } else {
            format!("{family} {}", extra.join(" "))
        };
        (name, aspect, FaceRef { id, coords })
    };
    let mut out = vec![one(&default_style, Vec::new())];
    for inst in instances(face) {
        if let Some(style) = english_name(face, inst.subfamily) {
            out.push(one(&style, inst.coords));
        }
    }
    out
}

/// Faces keyed by what a lookup is asked, for tests.
pub fn names_by_key(lib: &Library) -> HashMap<String, String> {
    lib.fonts
        .iter()
        .map(|(k, v)| (k.clone(), v.name.clone()))
        .collect()
}
