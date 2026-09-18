//! A picture of the model, drawn without a browser. A port of
//! `crates/fundacad-mcp/tools/python-oracle/render.py`.
//!
//! An agent that can build geometry but cannot look at it is working blind, and
//! "looks right" is a question no list of numbers answers. The app's own
//! renderer is the authority on what a HUMAN sees, but reaching it means a vite
//! server, a browser binary and a GPU, for a picture. The rebuild reply already
//! carries triangles and edge polylines, so a z-buffered flat render is a page
//! of arithmetic, and it runs on a machine with no display at all.
//!
//! Deliberately NOT a pretty renderer: a shaded solid, a dark outline, an
//! orthographic camera and a fixed light, because what it has to answer is "is
//! there a hole where I asked for a hole". Flat shading is part of that, smooth
//! normals hide facet-sized mistakes and a facet-sized mistake in CAD is a
//! mistake.

use serde_json::Value;

pub type Vec3 = [f64; 3];
pub type Rgb = [u8; 3];

/// Where the light is, in VIEW space (x right, y up, z toward the viewer). Just
/// off the camera axis: dead-on is flat and unreadable, far off leaves half the
/// model in the dark.
pub const LIGHT_RAW: Vec3 = [0.35, 0.45, 1.0];

/// Never fully black. An unlit face still has to show its silhouette against
/// the background and its edges against itself.
pub const AMBIENT: f64 = 0.28;

pub const BACKGROUND: Rgb = [24, 27, 32];
pub const EDGE_COLOR: Rgb = [16, 18, 22];

/// One colour per body, cycled. Distinct in hue rather than in brightness,
/// because brightness is what the shading is already saying.
pub const BODY_COLORS: &[Rgb] = &[
    [158, 176, 196],
    [196, 158, 158],
    [158, 196, 168],
    [196, 188, 148],
    [176, 158, 196],
    [148, 188, 196],
];

/// What a highlighted face is painted. Chosen to survive the shading multiply
/// and to be a hue no body colour uses.
pub const HIGHLIGHT_COLOR: Rgb = [255, 150, 40];

/// How much darker the INSIDE of a surface is drawn. Only ever seen through a
/// section, and the whole value of a section is telling inside from outside.
pub const INSIDE: f64 = 0.55;

/// Named directions to look FROM, in world space. Z-up, Y into the screen on
/// the front view, the same convention the app's view cube uses.
pub const NAMED_VIEWS: &[(&str, Vec3)] = &[
    ("iso", [1.0, -1.0, 0.8]),
    ("front", [0.0, -1.0, 0.0]),
    ("back", [0.0, 1.0, 0.0]),
    ("left", [-1.0, 0.0, 0.0]),
    ("right", [1.0, 0.0, 0.0]),
    ("top", [0.0, 0.0, 1.0]),
    ("bottom", [0.0, 0.0, -1.0]),
];

/// Which way a named section axis points. `at` is then a coordinate on it.
pub const SECTION_AXES: &[(&str, Vec3)] = &[
    ("x", [1.0, 0.0, 0.0]),
    ("y", [0.0, 1.0, 0.0]),
    ("z", [0.0, 0.0, 1.0]),
];

/// Which side of the section plane survives, as true for the high side.
///
/// Generous on purpose, and CLOSED on purpose. The vocabulary used to be
/// "above"/"over"/"+" against everything else, so `keep: "max"`, which is what
/// `at`/`min`/`max` elsewhere invites, quietly meant "below" and the caller was
/// told "keeping max" over a picture that kept the other half.
pub const KEEP_WORDS: &[(&str, bool)] = &[
    ("below", false),
    ("under", false),
    ("min", false),
    ("low", false),
    ("bottom", false),
    ("near", false),
    ("-", false),
    ("above", true),
    ("over", true),
    ("max", true),
    ("high", true),
    ("top", true),
    ("far", true),
    ("+", true),
];

pub fn keep_word(word: &str) -> Option<bool> {
    KEEP_WORDS
        .iter()
        .find(|(w, _)| *w == word)
        .map(|(_, high)| *high)
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

fn scaled(a: Vec3, k: f64) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn unit(a: Vec3) -> Vec3 {
    let n = norm(a);
    if n < 1e-12 {
        a
    } else {
        scaled(a, 1.0 / n)
    }
}

/// The unit vector to look FROM, from either a name or a pair of angles.
///
/// Angles win when both are given, so a caller can nudge a named view without
/// working out the vector. Azimuth runs anticlockwise from +X in the XY plane
/// and elevation up from it, which is how every CAD turntable states it.
pub fn direction_for(view: Option<&str>, azimuth: Option<f64>, elevation: Option<f64>) -> Vec3 {
    let v = if azimuth.is_some() || elevation.is_some() {
        let az = azimuth.unwrap_or(0.0).to_radians();
        let el = elevation.unwrap_or(0.0).to_radians();
        [el.cos() * az.cos(), el.cos() * az.sin(), el.sin()]
    } else {
        let name = view.unwrap_or("iso").to_ascii_lowercase();
        NAMED_VIEWS
            .iter()
            .find(|(n, _)| *n == name)
            .map_or(NAMED_VIEWS[0].1, |(_, v)| *v)
    };
    if norm(v) > 1e-12 {
        unit(v)
    } else {
        scaled([1.0, -1.0, 0.8], 1.0 / 2.64f64.sqrt())
    }
}

/// The camera's (right, up, back) as rows that take world to view.
///
/// `back` is the direction the camera looks FROM, so a point's view-space z
/// grows toward the viewer and the depth test is a plain greater-than. World up
/// is +Z; looking straight down it, +Z is no longer a usable reference, so the
/// fallback is +Y, without which a top view collapses to one pixel.
pub fn view_basis(direction: Vec3) -> [Vec3; 3] {
    let back = unit(direction);
    let up_world = if dot(back, [0.0, 0.0, 1.0]).abs() > 0.999 {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    };
    let right = unit(cross(up_world, back));
    let up = cross(back, right);
    [right, up, back]
}

pub fn to_view(p: Vec3, basis: &[Vec3; 3]) -> Vec3 {
    [dot(p, basis[0]), dot(p, basis[1]), dot(p, basis[2])]
}

/// (centre_xy, pixels per mm) that puts every point on screen with a border. An
/// empty or degenerate set still has to produce a usable camera rather than a
/// division by zero, so a zero span falls back to one millimetre.
pub fn fit_scale(pts_view: &[Vec3], width: u32, height: u32, margin: f64) -> ([f64; 2], f64) {
    if pts_view.is_empty() {
        return ([0.0, 0.0], 1.0);
    }
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for p in pts_view {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let centre = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];
    let span = [(hi[0] - lo[0]).max(1e-9), (hi[1] - lo[1]).max(1e-9)];
    let usable = 1.0 - 2.0 * margin;
    let mut scale = (f64::from(width) * usable / span[0]).min(f64::from(height) * usable / span[1]);
    if !scale.is_finite() || scale <= 0.0 {
        scale = 1.0;
    }
    (centre, scale)
}

/// A view point to (x_px, y_px, depth). Screen y runs DOWN and world up runs
/// up, hence the negation: getting it wrong flips every render upside down and
/// nothing else about the image looks wrong.
pub fn project(v: Vec3, centre: [f64; 2], scale: f64, width: u32, height: u32) -> Vec3 {
    [
        (v[0] - centre[0]) * scale + f64::from(width) / 2.0,
        f64::from(height) / 2.0 - (v[1] - centre[1]) * scale,
        v[2],
    ]
}

/// An edge polyline as points, whatever shape it arrived in: the engine sends
/// `{"points": [...], "body": id}`, a test writes a bare list, and the points
/// themselves are sometimes flat and sometimes triples.
pub fn polyline_points(poly: &Value) -> Vec<Vec3> {
    let source = match poly {
        Value::Object(o) => o.get("points").cloned().unwrap_or(Value::Null),
        other => other.clone(),
    };
    let mut flat: Vec<f64> = Vec::new();
    flatten(&source, &mut flat);
    if flat.len() < 6 || flat.len() % 3 != 0 {
        return Vec::new();
    }
    flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

fn flatten(v: &Value, out: &mut Vec<f64>) {
    match v {
        Value::Array(items) => items.iter().for_each(|i| flatten(i, out)),
        other => {
            if let Some(f) = other.as_f64() {
                out.push(f);
            }
        }
    }
}

/// A section request, as (normal, offset), or None when there is no section.
///
/// `at` defaults to the middle of the model on that axis, which is what
/// somebody asking to cut it in half means and the only default that needs no
/// knowledge of where the part happens to sit.
pub fn section_plane(spec: &Value, bounds: Option<(Vec3, Vec3)>) -> Result<Option<(Vec3, f64)>, String> {
    if spec.is_null() || spec.as_object().is_some_and(serde_json::Map::is_empty) {
        return Ok(None);
    }
    let axis = spec.get("axis").cloned().unwrap_or(Value::String("x".into()));
    let n = match &axis {
        Value::String(name) => {
            let key = name.to_ascii_lowercase();
            SECTION_AXES
                .iter()
                .find(|(a, _)| *a == key)
                .map_or(SECTION_AXES[0].1, |(_, v)| *v)
        }
        Value::Array(items) => {
            let mut v = [0.0; 3];
            for (k, item) in items.iter().take(3).enumerate() {
                v[k] = item.as_f64().unwrap_or(0.0);
            }
            v
        }
        _ => SECTION_AXES[0].1,
    };
    if norm(n) < 1e-12 {
        return Ok(None);
    }
    let n = unit(n);
    let at = match spec.get("at").and_then(Value::as_f64) {
        Some(at) => at,
        None => match bounds {
            Some((lo, hi)) => dot(n, [
                (lo[0] + hi[0]) / 2.0,
                (lo[1] + hi[1]) / 2.0,
                (lo[2] + hi[2]) / 2.0,
            ]),
            None => 0.0,
        },
    };
    let keep_raw = match spec.get("keep") {
        None | Some(Value::Null) => "below".to_string(),
        Some(Value::String(s)) => s.trim().to_ascii_lowercase(),
        Some(other) => other.to_string().trim().to_ascii_lowercase(),
    };
    let Some(high) = keep_word(&keep_raw) else {
        let mut words: Vec<&str> = KEEP_WORDS.iter().map(|(w, _)| *w).collect();
        words.sort_unstable();
        return Err(format!(
            "section keep={} is not a side of the plane. Use one of: {}.",
            match spec.get("keep") {
                Some(Value::String(s)) => format!("'{s}'"),
                Some(other) => other.to_string(),
                None => "None".into(),
            },
            words.join(", ")
        ));
    };
    // The kept half is always "n . p <= d"; asking to keep the far side flips
    // the plane, which keeps the clipper down to one case.
    Ok(Some(if high {
        (scaled(n, -1.0), -at)
    } else {
        (n, at)
    }))
}

/// The part of a triangle on the kept side of a plane, as 0, 1 or 2 triangles.
///
/// Sutherland-Hodgman on three vertices. There is no cap: a sectioned solid
/// renders hollow, showing its own inside surfaces, which is what makes this
/// worth having, and a capped section would hide exactly that.
pub fn clip_triangle(p0: Vec3, p1: Vec3, p2: Vec3, normal: Vec3, offset: f64) -> Vec<[Vec3; 3]> {
    let pts = [p0, p1, p2];
    let s: Vec<f64> = pts.iter().map(|p| dot(normal, *p) - offset).collect();
    let keep: Vec<bool> = s.iter().map(|v| *v <= 0.0).collect();
    let n_keep = keep.iter().filter(|k| **k).count();
    if n_keep == 3 {
        return vec![[p0, p1, p2]];
    }
    if n_keep == 0 {
        return Vec::new();
    }
    let mut poly: Vec<Vec3> = Vec::new();
    for i in 0..3 {
        let j = (i + 1) % 3;
        if keep[i] {
            poly.push(pts[i]);
        }
        if keep[i] != keep[j] {
            let t = s[i] / (s[i] - s[j]);
            poly.push(add(pts[i], scaled(sub(pts[j], pts[i]), t)));
        }
    }
    if poly.len() < 3 {
        return Vec::new();
    }
    (1..poly.len() - 1)
        .map(|k| [poly[0], poly[k], poly[k + 1]])
        .collect()
}

/// The kept part of a line segment, or None.
pub fn clip_segment(a: Vec3, b: Vec3, normal: Vec3, offset: f64) -> Option<(Vec3, Vec3)> {
    let sa = dot(normal, a) - offset;
    let sb = dot(normal, b) - offset;
    if sa <= 0.0 && sb <= 0.0 {
        return Some((a, b));
    }
    if sa > 0.0 && sb > 0.0 {
        return None;
    }
    let t = sa / (sa - sb);
    let mid = add(a, scaled(sub(b, a), t));
    Some(if sa <= 0.0 { (a, mid) } else { (mid, b) })
}

/// Lambert against the light, with the normal flipped toward the viewer, and
/// the back of a surface drawn darker.
///
/// Flipping is not cheating: a body whose triangle winding disagrees with its
/// face normals would otherwise render half black, and the winding is not
/// something the caller controls. But the flip also erases the one thing a
/// cutaway is for, so the sign it threw away comes back as the INSIDE factor.
pub fn shade(base: Rgb, normal_view: Vec3) -> Rgb {
    let ln = norm(normal_view);
    if ln < 1e-12 {
        return base;
    }
    let mut n = scaled(normal_view, 1.0 / ln);
    let facing = if n[2] >= 0.0 { 1.0 } else { INSIDE };
    if n[2] < 0.0 {
        n = scaled(n, -1.0);
    }
    let light = unit(LIGHT_RAW);
    let k = facing * (AMBIENT + (1.0 - AMBIENT) * dot(n, light).max(0.0));
    [
        (f64::from(base[0]) * k).clamp(0.0, 255.0) as u8,
        (f64::from(base[1]) * k).clamp(0.0, 255.0) as u8,
        (f64::from(base[2]) * k).clamp(0.0, 255.0) as u8,
    ]
}

/// A colour buffer and a depth buffer, and the two things that write to them.
pub struct Canvas {
    pub w: u32,
    pub h: u32,
    pub color: Vec<u8>,
    pub depth: Vec<f64>,
}

impl Canvas {
    pub fn new(width: u32, height: u32, background: Rgb) -> Canvas {
        let n = (width as usize) * (height as usize);
        let mut color = Vec::with_capacity(n * 3);
        for _ in 0..n {
            color.extend_from_slice(&background);
        }
        Canvas {
            w: width,
            h: height,
            color,
            depth: vec![f64::NEG_INFINITY; n],
        }
    }

    pub fn pixel(&self, x: u32, y: u32) -> Rgb {
        let at = ((y as usize) * (self.w as usize) + x as usize) * 3;
        [self.color[at], self.color[at + 1], self.color[at + 2]]
    }

    fn put(&mut self, x: u32, y: u32, rgb: Rgb, z: f64) {
        let i = (y as usize) * (self.w as usize) + x as usize;
        self.depth[i] = z;
        self.color[i * 3..i * 3 + 3].copy_from_slice(&rgb);
    }

    /// One flat-shaded triangle, depth-tested per pixel, over its own pixel
    /// bounding box with barycentric coordinates. Back-facing and degenerate
    /// triangles are dropped by the sign test on the edge function, so a closed
    /// solid draws roughly half its triangles.
    pub fn triangle(&mut self, p0: Vec3, p1: Vec3, p2: Vec3, rgb: Rgb) {
        let xs = [p0[0], p1[0], p2[0]];
        let ys = [p0[1], p1[1], p2[1]];
        let lo_x = xs.iter().cloned().fold(f64::INFINITY, f64::min).floor();
        let hi_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max).ceil();
        let lo_y = ys.iter().cloned().fold(f64::INFINITY, f64::min).floor();
        let hi_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max).ceil();
        let x0 = lo_x.max(0.0) as u32;
        let x1 = ((hi_x + 1.0).min(f64::from(self.w))).max(0.0) as u32;
        let y0 = lo_y.max(0.0) as u32;
        let y1 = ((hi_y + 1.0).min(f64::from(self.h))).max(0.0) as u32;
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
        if area.abs() < 1e-12 {
            return;
        }
        for y in y0..y1 {
            let gy = f64::from(y) + 0.5;
            for x in x0..x1 {
                let gx = f64::from(x) + 0.5;
                let w0 = ((p1[0] - p0[0]) * (gy - p0[1]) - (gx - p0[0]) * (p1[1] - p0[1])) / area;
                let w1 = ((gx - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (gy - p0[1])) / area;
                if w0 < 0.0 || w1 < 0.0 || w0 + w1 > 1.0 {
                    continue;
                }
                let depth = p0[2] + w1 * (p1[2] - p0[2]) + w0 * (p2[2] - p0[2]);
                let i = (y as usize) * (self.w as usize) + x as usize;
                if depth > self.depth[i] {
                    self.put(x, y, rgb, depth);
                }
            }
        }
    }

    /// A one-pixel line, depth-tested with a bias toward the viewer.
    ///
    /// The bias is what makes an outline visible at all: an edge polyline lies
    /// exactly ON the two faces that meet there, so at equal depth it loses the
    /// test on one of them and the outline comes out dashed.
    pub fn line(&mut self, a: Vec3, b: Vec3, rgb: Rgb, bias: f64) {
        let steps = (b[0] - a[0]).abs().max((b[1] - a[1]).abs());
        if !steps.is_finite() {
            return;
        }
        let n = steps as i64 + 1;
        if n > 4 * i64::from(self.w + self.h) {
            return; // a line this long is off-screen garbage, not geometry
        }
        for k in 0..n {
            let t = if n > 1 {
                k as f64 / (n - 1) as f64
            } else {
                0.0
            };
            let x = (a[0] + (b[0] - a[0]) * t).round();
            let y = (a[1] + (b[1] - a[1]) * t).round();
            if x < 0.0 || y < 0.0 || x >= f64::from(self.w) || y >= f64::from(self.h) {
                continue;
            }
            let z = a[2] + (b[2] - a[2]) * t + bias;
            let (x, y) = (x as u32, y as u32);
            let i = (y as usize) * (self.w as usize) + x as usize;
            if z >= self.depth[i] {
                self.put(x, y, rgb, z);
            }
        }
    }
}

/// (min, max) over every vertex of every mesh, or None when there are none.
pub fn model_bounds(meshes: &[&Value]) -> Option<(Vec3, Vec3)> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    let mut any = false;
    for m in meshes {
        let pos = floats(m.get("positions"));
        for p in pos.chunks_exact(3) {
            any = true;
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
    }
    any.then_some((lo, hi))
}

fn floats(v: Option<&Value>) -> Vec<f64> {
    let mut out = Vec::new();
    if let Some(v) = v {
        flatten(v, &mut out);
    }
    out
}

/// What to draw, so `render` reads like the Python call it replaces.
#[derive(Default)]
pub struct ViewRequest {
    pub width: u32,
    pub height: u32,
    pub view: Option<String>,
    pub azimuth: Option<f64>,
    pub elevation: Option<f64>,
    /// {body id: face indices}, painted in HIGHLIGHT_COLOR instead of the body
    /// colour, still shaded. It is how a caller asks "which one is face 7".
    pub highlight: Option<(String, Vec<i64>)>,
    pub section: Value,
    /// Body ids to draw; everything else is left out.
    pub bodies: Option<Vec<String>>,
    /// {at, size}: a window that many millimetres across, replacing the
    /// automatic fit. A 1.5 mm thread on a 200 mm spool is four pixels of a
    /// fitted view.
    pub focus: Value,
    pub draw_edges: bool,
}

/// The image, as a canvas. `meshes` is one value per body in the shape the
/// engine's rebuild reply hands over, so nothing is reshaped on the way in.
///
/// The body COLOUR is keyed on a body's position in the full list, not in the
/// filtered one, so a body is the same colour whether or not its neighbours are
/// being drawn.
pub fn render(meshes: &[Value], req: &ViewRequest) -> Result<Canvas, String> {
    let mut canvas = Canvas::new(req.width, req.height, BACKGROUND);
    let basis = view_basis(direction_for(
        req.view.as_deref(),
        req.azimuth,
        req.elevation,
    ));
    let drawn: Vec<(usize, &Value)> = meshes
        .iter()
        .enumerate()
        .filter(|(_, m)| match &req.bodies {
            None => true,
            Some(want) => want.is_empty()
                || m.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| want.iter().any(|w| w == id)),
        })
        .collect();
    if drawn.is_empty() {
        return Ok(canvas);
    }

    let plane = if req.section.is_null() {
        None
    } else {
        let bounds = model_bounds(&drawn.iter().map(|(_, m)| *m).collect::<Vec<_>>());
        section_plane(&req.section, bounds)?
    };

    // Every triangle that will actually be drawn, in world space, with the
    // colour it wants. Built up front because the camera has to be fitted to
    // what SURVIVES the section, not to what was sent: a cutaway fitted to the
    // whole model wastes half the frame on empty space.
    let mut tris: Vec<([Vec3; 3], Rgb)> = Vec::new();
    let mut segs: Vec<(Vec3, Vec3)> = Vec::new();
    for (bi, m) in &drawn {
        let pos = floats(m.get("positions"));
        if pos.len() < 9 {
            continue;
        }
        let idx: Vec<usize> = floats(m.get("indices"))
            .into_iter()
            .map(|v| v as usize)
            .collect();
        let face_ids = floats(m.get("faceIds"));
        let id = m.get("id").and_then(Value::as_str).unwrap_or_default();
        let want = req
            .highlight
            .as_ref()
            .filter(|(body, _)| body == id)
            .map(|(_, faces)| faces);
        let base = BODY_COLORS[bi % BODY_COLORS.len()];
        let point = |i: usize| -> Vec3 { [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] };
        for (t, tri) in idx.chunks_exact(3).enumerate() {
            if tri.iter().any(|i| (i + 1) * 3 > pos.len()) {
                continue;
            }
            let mut colour = base;
            if let Some(want) = want {
                if t < face_ids.len() && want.iter().any(|f| *f as f64 == face_ids[t]) {
                    colour = HIGHLIGHT_COLOR;
                }
            }
            let (a, b, c) = (point(tri[0]), point(tri[1]), point(tri[2]));
            match plane {
                None => tris.push(([a, b, c], colour)),
                Some((n, d)) => {
                    for piece in clip_triangle(a, b, c, n, d) {
                        tris.push((piece, colour));
                    }
                }
            }
        }
        if req.draw_edges {
            for poly in m
                .get("edges")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
            {
                let pts = polyline_points(poly);
                for k in 0..pts.len().saturating_sub(1) {
                    match plane {
                        None => segs.push((pts[k], pts[k + 1])),
                        Some((n, d)) => {
                            if let Some(cut) = clip_segment(pts[k], pts[k + 1], n, d) {
                                segs.push(cut);
                            }
                        }
                    }
                }
            }
        }
    }

    let mut pool: Vec<Vec3> = Vec::with_capacity(tris.len() * 3 + segs.len() * 2);
    for (t, _) in &tris {
        pool.extend(t.iter().map(|p| to_view(*p, &basis)));
    }
    for (a, b) in &segs {
        pool.push(to_view(*a, &basis));
        pool.push(to_view(*b, &basis));
    }
    if pool.is_empty() {
        return Ok(canvas);
    }
    let (centre, scale) = match req.focus.get("at").filter(|v| !v.is_null()) {
        Some(at) => {
            let mut world = [0.0; 3];
            if let Some(items) = at.as_array() {
                for (k, v) in items.iter().take(3).enumerate() {
                    world[k] = v.as_f64().unwrap_or(0.0);
                }
            }
            let v = to_view(world, &basis);
            let size = req
                .focus
                .get("size")
                .and_then(Value::as_f64)
                .filter(|s| *s > 0.0)
                .unwrap_or(10.0);
            (
                [v[0], v[1]],
                f64::from(req.width.min(req.height)) / size.max(1e-6),
            )
        }
        None => fit_scale(&pool, req.width, req.height, 0.06),
    };
    // The outline bias is a fixed fraction of the model's own depth range, so
    // it is the same visual nudge on a 2 mm part and a 2 m one.
    let zs: Vec<f64> = pool.iter().map(|p| p[2]).collect();
    let span_z = zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
        - zs.iter().cloned().fold(f64::INFINITY, f64::min);
    let bias = if span_z == 0.0 { 1.0 } else { span_z } * 1e-3;

    for (tri, colour) in &tris {
        let v: Vec<Vec3> = tri.iter().map(|p| to_view(*p, &basis)).collect();
        let scr: Vec<Vec3> = v
            .iter()
            .map(|p| project(*p, centre, scale, req.width, req.height))
            .collect();
        let n = cross(sub(v[1], v[0]), sub(v[2], v[0]));
        canvas.triangle(scr[0], scr[1], scr[2], shade(*colour, n));
    }
    for (a, b) in &segs {
        let sa = project(to_view(*a, &basis), centre, scale, req.width, req.height);
        let sb = project(to_view(*b, &basis), centre, scale, req.width, req.height);
        canvas.line(sa, sb, EDGE_COLOR, bias);
    }
    Ok(canvas)
}
