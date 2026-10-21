mod common;

use fundacad_tracer::{Camera, Ground, GroundMode, Lights, Look, Path, Tracer, TracerOptions};

fn tracers() -> Vec<Tracer> {
    let mut out = Vec::new();
    for software in [true, false] {
        match common::tracer(TracerOptions { software, ..Default::default() }) {
            Ok(t) if software || t.path() == Path::RayQuery => out.push(t),
            Ok(_) => {}
            Err(e) => eprintln!("skipped, no GPU adapter: {e}"),
        }
    }
    out
}

const W: u32 = 160;
const H: u32 = 120;
const BG: f32 = 0.5;
const CAMERA: Camera = Camera { eye: [-6.0, 8.0, 6.0], target: [0.0, 0.0, 0.5], up: [0.0, 0.0, 1.0], fov: 35.0, ortho: None, lens: None };

/// The rig of a page: a strong key from above and a weak low fill, 1 degree discs.
fn page_look(ground: &str) -> Look {
    serde_json::from_str(&format!(
        r#"{{"background":[0.5,0.5,0.5],"skyTop":[0.3,0.3,0.3],"skyBottom":[0.3,0.3,0.3],"bounces":4,
        "lights":[{{"direction":[0.3,-0.4,1],"color":[2,2,2],"angularRadius":1}},{{"direction":[-50,40,20],"color":[0.6,0.6,0.6],"angularRadius":1}}]{ground}}}"#
    ))
    .unwrap()
}

const CATCHER: &str = r#","ground":{"mode":"shadow","z":0,"centre":[0,0],"extent":3.2,"albedo":0.5}"#;

/// A 2 x 2 x 2 matte box standing on z = 0 at `at`.
fn render(t: &mut Tracer, look: Look, at: [f32; 3], spp: u32) -> Vec<[f32; 3]> {
    render_bodies(t, look, &[("box", at)], spp)
}

/// Matte bodies by mesh key: "box" the 2 x 2 x 2 box, "slab" an 8 x 8 slab 0.2 thick.
fn render_bodies(t: &mut Tracer, look: Look, bodies: &[(&str, [f32; 3])], spp: u32) -> Vec<[f32; 3]> {
    t.resize(W, H);
    t.set_look(look);
    let descs = bodies.iter().enumerate().map(|(i, (key, at))| common::place(&format!("b{i}"), key, 1.0, *at, common::matte([0.8; 3]))).collect();
    for key in t.set_bodies(descs) {
        let mesh = if key == "slab" { common::cuboid(4.0, 4.0, 0.1) } else { common::cuboid(1.0, 1.0, 1.0) };
        t.add_mesh(&key, mesh);
    }
    t.apply();
    t.set_camera(CAMERA);
    t.set_cap(spp);
    t.render_samples(spp);
    t.read_hdr()
}

fn pixel(p: [f32; 3]) -> usize {
    let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let norm = |a: [f32; 3]| a.map(|x| x / dot(a, a).sqrt());
    let c = CAMERA;
    let f = norm(sub(c.target, c.eye));
    let r = norm(cross(f, c.up));
    let u = cross(r, f);
    let d = sub(p, c.eye);
    let th = (c.fov.to_radians() * 0.5).tan();
    let px = dot(d, r) / dot(d, f) / (th * W as f32 / H as f32);
    let py = dot(d, u) / dot(d, f) / th;
    let (x, y) = ((px + 1.0) * 0.5 * W as f32, (1.0 - py) * 0.5 * H as f32);
    assert!(x >= 0.0 && y >= 0.0 && x < W as f32 && y < H as f32, "{p:?} is off screen");
    y as usize * W as usize + x as usize
}

fn worst(img: &[[f32; 3]], v: f32) -> f32 {
    img.iter().flatten().map(|x| (x - v).abs()).fold(0.0, f32::max)
}

#[test]
fn a_page_sends_the_ground_and_an_unknown_mode_is_none() {
    let g = page_look(CATCHER).ground.expect("the ground parses");
    assert_eq!(g, Ground { mode: GroundMode::Shadow, z: 0.0, centre: [0.0, 0.0], extent: 3.2, albedo: 0.5 });
    let later = page_look(r#","ground":{"mode":"later","z":1,"centre":[0,0],"extent":2}"#).ground.unwrap();
    assert_eq!(later.mode, GroundMode::None);
    assert_eq!(page_look("").ground, None);
}

#[test]
fn the_plane_alone_is_the_background() {
    for mut t in tracers() {
        // Far below the plane: an empty scene never finishes a frame.
        let img = render(&mut t, page_look(CATCHER), [0.0, 0.0, -100.0], 16);
        assert_eq!(worst(&img, BG), 0.0, "{:?}: an open catcher is not exactly the background", t.path());
        t.set_environment(Some(common::studio_room()));
        let img = render(&mut t, page_look(CATCHER), [0.0, 0.0, -100.0], 16);
        assert_eq!(worst(&img, BG), 0.0, "{:?}: the room lit catcher is not exactly the background", t.path());
    }
}

#[test]
fn a_box_darkens_the_plane_where_the_contact_shadow_is() {
    for mut t in tracers() {
        let img = render(&mut t, page_look(CATCHER), [0.0, 0.0, 1.0], 64);
        let at = |p: [f32; 3]| img[pixel(p)][1] / BG;
        let (contact, key, side, open, outside) = (at([0.0, 1.1, 0.0]), at([0.0, 1.4, 0.0]), at([-1.1, 0.0, 0.0]), at([-1.55, -1.55, 0.0]), at([-2.5, -1.0, 0.0]));
        eprintln!("{:?}: contact {contact} key shadow {key} -x side {side} open {open} outside {outside}", t.path());
        assert!(contact < 0.8 && key < 0.8, "{:?}: no shadow at the box's foot, {contact} {key}", t.path());
        assert!((open - 1.0).abs() < 0.06, "{:?}: the open catcher is {open} of the background", t.path());
        assert_eq!(outside, 1.0, "{:?}: past the square the plane still shows", t.path());
    }
}

#[test]
fn the_room_alone_darkens_the_plane_at_the_box() {
    for mut t in tracers() {
        t.set_environment(Some(common::studio_room()));
        let mut look = page_look(CATCHER);
        look.lights = Some(Lights::new(&[]));
        let img = render(&mut t, look, [0.0, 0.0, 1.0], 64);
        let at = |p: [f32; 3]| img[pixel(p)][1] / BG;
        let (contact, open, outside) = (at([0.0, 1.1, 0.0]), at([-1.55, -1.55, 0.0]), at([-2.5, -1.0, 0.0]));
        eprintln!("{:?}: room alone, contact {contact} open {open} outside {outside}", t.path());
        assert!(contact < 0.8 && contact < open, "{:?}: the room casts no shadow at the box's foot, {contact} against {open}", t.path());
        assert_eq!(outside, 1.0, "{:?}: past the square the plane still shows", t.path());
    }
}

#[test]
fn ground_none_changes_nothing() {
    for mut t in tracers() {
        let plain = render(&mut t, page_look(""), [0.0, 0.0, 1.0], 16);
        let none = render(&mut t, page_look(r#","ground":{"mode":"none","z":0,"centre":[0,0],"extent":3.2}"#), [0.0, 0.0, 1.0], 16);
        assert!(plain == none, "{:?}: mode none changed the picture", t.path());
    }
}

#[test]
fn bounce_and_shadow_rays_pass_through() {
    for mut t in tracers() {
        let alone = render(&mut t, page_look(""), [0.0, 0.0, 1.0], 16);
        // Under the plane, where only the box's bounce rays reach it.
        let scene = [("box", [0.0, 0.0, 1.0]), ("slab", [0.0, 0.0, -0.6])];
        let plain = render_bodies(&mut t, page_look(""), &scene, 16);
        let ground = render_bodies(&mut t, page_look(CATCHER), &scene, 16);
        let body = |i: usize| {
            let (x, y) = ((i % W as usize) as i64, (i / W as usize) as i64);
            (-1..=1).all(|dy| {
                (-1..=1).all(|dx| {
                    let (u, v) = (x + dx, y + dy);
                    u >= 0 && v >= 0 && u < W as i64 && v < H as i64 && alone[(v * W as i64 + u) as usize] != [BG; 3]
                })
            })
        };
        let faces: Vec<usize> = (0..alone.len()).filter(|&i| body(i)).collect();
        assert!(faces.iter().any(|&i| plain[i] != alone[i]), "{:?}: the slab lights none of the box", t.path());
        assert!(faces.len() > 500, "{:?}: the box covers only {} pixels", t.path(), faces.len());
        let changed = faces.iter().filter(|&&i| plain[i] != ground[i]).count();
        assert_eq!(changed, 0, "{:?}: the catcher changed {changed} of {} box pixels", t.path(), faces.len());
    }
}

/// page_look's background and catcher with its own sky level and lights.
fn sky_look(sky: f32, lights: &str) -> Look {
    serde_json::from_str(&format!(
        r#"{{"background":[0.5,0.5,0.5],"skyTop":[{sky},{sky},{sky}],"skyBottom":[{sky},{sky},{sky}],"bounces":4,"lights":[{lights}]{CATCHER}}}"#
    ))
    .unwrap()
}

const PAGE_LIGHTS: &str = r#"{"direction":[0.3,-0.4,1],"color":[2,2,2],"angularRadius":1},{"direction":[-50,40,20],"color":[0.6,0.6,0.6],"angularRadius":1}"#;

/// The 3 x 3 pixels around p, green over the background.
fn around(img: &[[f32; 3]], p: [f32; 3]) -> f32 {
    let i = pixel(p) as i64;
    let w = W as i64;
    (-1..=1).flat_map(|dy| (-1..=1).map(move |dx| i + dy * w + dx)).map(|j| img[j as usize][1] / BG).sum::<f32>() / 9.0
}

#[test]
fn the_sky_gradient_lights_the_plane_too() {
    for mut t in tracers() {
        let open = render(&mut t, sky_look(1.0, PAGE_LIGHTS), [0.0, 0.0, -100.0], 16);
        assert_eq!(worst(&open, BG), 0.0, "{:?}: the sky lit catcher is not exactly the background", t.path());
        let dark = render(&mut t, sky_look(0.0, PAGE_LIGHTS), [0.0, 0.0, 1.0], 64);
        let lit = render(&mut t, sky_look(1.0, PAGE_LIGHTS), [0.0, 0.0, 1.0], 64);
        let sky = render(&mut t, sky_look(1.0, ""), [0.0, 0.0, 1.0], 64);
        // Inside the fade band's start, 0.75 of the half side.
        let (dark, lit, sky) = (around(&dark, [0.0, 1.15, 0.0]), around(&lit, [0.0, 1.15, 0.0]), around(&sky, [0.0, 1.1, 0.0]));
        eprintln!("{:?}: key shadow sky 0 {dark} sky 1 {lit}, contact of the sky alone {sky}", t.path());
        assert!(dark < 0.15, "{:?}: with no sky the key shadow is {dark}", t.path());
        assert!(lit > 0.3, "{:?}: the sky leaves the key shadow at {lit}", t.path());
        assert!(sky < 0.8, "{:?}: the sky alone casts no shadow at the box's foot, {sky}", t.path());
    }
}

#[test]
fn a_low_light_shadow_fades_before_the_catcher_edge() {
    for mut t in tracers() {
        let img = render(&mut t, sky_look(0.0, r#"{"direction":[0,-1,0.3],"color":[2,2,2],"angularRadius":1}"#), [0.0, 0.0, 1.0], 64);
        let at = |p: [f32; 3]| img[pixel(p)][1] / BG;
        let (shadow, rim, outside) = (at([0.0, 1.2, 0.0]), at([0.0, 1.58, 0.0]), at([0.0, 1.65, 0.0]));
        eprintln!("{:?}: low light shadow {shadow} at the rim {rim} past it {outside}", t.path());
        assert!(shadow < 0.8, "{:?}: no long shadow, {shadow}", t.path());
        assert!(rim > 0.95, "{:?}: the shadow ends in a seam at the edge, {rim} inside it", t.path());
        assert_eq!(outside, 1.0, "{:?}: past the square the plane still shows", t.path());
    }
}

#[test]
fn a_grazing_sun_is_not_lit_by_giving_up() {
    // A sun 1 degree up: about 1 in 50 map draws passes the cosine coin.
    let sun = [1.0f32.to_radians().cos(), 0.0, 1.0f32.to_radians().sin()];
    let cos_r = 0.6f32.to_radians().cos();
    let radiance = 20.0 / (2.0 * std::f32::consts::PI * (1.0 - cos_r));
    let hdr = common::env_of("grazing", (512, 256), fundacad_tracer::Up::Z, |d| {
        let c = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
        [if c > cos_r { radiance } else if d[2] > 0.0 { 0.02 } else { 0.0 }; 3]
    });
    for mut t in tracers() {
        t.set_environment(Some(hdr.clone()));
        // A wall between the sun and the origin.
        let img = render(&mut t, sky_look(0.0, ""), [3.0, 0.0, 1.0], 256);
        let shadow = around(&img, [0.0, 0.0, 0.0]);
        eprintln!("{:?}: grazing sun shadow {shadow}", t.path());
        // The sky's share of the light on an up face is about 0.15 and the wall takes some of it.
        assert!(shadow < 0.22, "{:?}: the sun shadow reads {shadow}, given up draws count as lit", t.path());
    }
}
