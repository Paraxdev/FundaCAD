//! A 10 mm cube centred on the origin with its BREP text edited into a body
//! that is not a closed solid facing outward, brought in the way a stored
//! import is, as body1 "Casing".

use base64::Engine;
use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

/// The lines that list what the cube's shell, solid and placing compound hold:
/// the shell its faces as "-26 0 +16 0 ... *", the solid its shell as "+3 0 *",
/// the compound the solid as "+2 1 *".
pub struct Records {
    shell: usize,
    solid: usize,
    compound: usize,
}

pub type Edit = fn(&mut Vec<String>, &Records);

pub fn cube_brep(edit: Edit) -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let nth = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fundacad-unsound-{}-{nth}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("cube.brep");
    kernel::make_box(10.0, 10.0, 10.0).expect("cube").write_brep_text(&path).expect("written");
    let text = std::fs::read_to_string(&path).expect("read");
    let _ = std::fs::remove_dir_all(&dir);
    // The writer heads the file with a DBRep line the importer does not take.
    let mut lines: Vec<String> =
        text.lines().skip_while(|l| !l.starts_with("CASCADE")).map(str::to_owned).collect();
    let record = |lines: &[String], tag: &str| {
        let at = lines.iter().position(|l| l == tag).unwrap_or_else(|| panic!("no {tag} record"));
        at + lines[at + 1..].iter().position(|l| l.ends_with('*')).expect("its parts") + 1
    };
    let at = Records { shell: record(&lines, "Sh"), solid: record(&lines, "So"), compound: record(&lines, "Co") };
    edit(&mut lines, &at);
    base64::engine::general_purpose::STANDARD.encode(lines.join("\n") + "\n")
}

pub fn sound(_: &mut Vec<String>, _: &Records) {}

pub fn inside_out(lines: &mut Vec<String>, at: &Records) {
    lines[at.solid] = lines[at.solid].replacen('+', "-", 1);
}

pub fn one_face_turned(lines: &mut Vec<String>, at: &Records) {
    let turned = if lines[at.shell].starts_with('-') { "+" } else { "-" };
    lines[at.shell] = format!("{turned}{}", &lines[at.shell][1..]);
}

fn faces_turned(lines: &mut [String], at: &Records, n: usize) {
    let parts: Vec<String> = lines[at.shell]
        .split(' ')
        .enumerate()
        .map(|(i, p)| match (i % 2 == 0 && i / 2 < n, p.strip_prefix('-'), p.strip_prefix('+')) {
            (true, Some(rest), _) => format!("+{rest}"),
            (true, _, Some(rest)) => format!("-{rest}"),
            _ => p.to_owned(),
        })
        .collect();
    lines[at.shell] = parts.join(" ");
}

/// How the STEP reader leaves a solid it turned outward: the shell held
/// reversed and every face in it turned, so it faces out.
pub fn shell_reversed_faces_turned(lines: &mut Vec<String>, at: &Records) {
    inside_out(lines, at);
    faces_turned(lines, at, 6);
}

/// The shell held reversed with four of its six faces turned, so its volume
/// comes out positive while two faces still point in.
pub fn shell_reversed_four_faces_turned(lines: &mut Vec<String>, at: &Records) {
    inside_out(lines, at);
    faces_turned(lines, at, 4);
}

/// Each edge of that face then bounds three.
pub fn one_face_twice(lines: &mut Vec<String>, at: &Records) {
    let first: Vec<&str> = lines[at.shell].split(' ').take(2).collect();
    lines[at.shell] = format!("{} {}", first.join(" "), lines[at.shell]);
}

pub fn one_face_missing(lines: &mut Vec<String>, at: &Records) {
    lines[at.shell] = lines[at.shell].split(' ').skip(2).collect::<Vec<_>>().join(" ");
}

/// The compound holds the shell where it held the solid.
pub fn shell_alone(lines: &mut Vec<String>, at: &Records) {
    let shell = lines[at.solid].split(' ').next().expect("the shell's number").to_owned();
    let solid = lines[at.compound].split(' ').next().expect("the solid's number").to_owned();
    lines[at.compound] = lines[at.compound].replacen(&solid, &shell, 1);
}

pub fn casing(edit: Edit) -> Value {
    json!({"id": "imp", "type": "import", "name": "Casing", "format": "step", "brep": cube_brep(edit)})
}

pub fn build(features: Value) -> Rebuild {
    let doc = json!({"parameters": {}, "features": features});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(r.bodies[0].name, "Casing");
    r
}
