//! A traced picture at its own size beside the viewport's accumulation.
//! Without an adapter (GitHub's Windows runners) each test says so and passes.

mod common;

use std::time::Duration;

use fundacad_tracer::denoise::Quality;
use fundacad_tracer::{Tracer, TracerOptions};

const VIEW: (u32, u32) = (96, 64);
const PIC: (u32, u32) = (192, 128);
const SPP: u32 = 8;

fn tracers() -> Vec<Tracer> {
    let mut out = Vec::new();
    for software in [true, false] {
        match Tracer::new(TracerOptions { software, ..Default::default() }) {
            Ok(t) if software || t.path() == fundacad_tracer::Path::RayQuery => out.push(t),
            Ok(_) => {}
            Err(e) => eprintln!("skipped, no GPU adapter: {e}"),
        }
    }
    out
}

fn max_diff(a: &[u8], b: &[u8]) -> u8 {
    a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0)
}

#[test]
fn a_picture_equals_the_viewport_resolve_at_its_size_and_spp() {
    for mut t in tracers() {
        t.set_cap(SPP);
        common::build(&mut t, "golden", Some(PIC));
        t.render_samples(SPP);
        let want = t.resolve();

        common::build(&mut t, "golden", Some(VIEW));
        t.set_cap(64);
        t.render_samples(3);
        let got = t.picture(PIC.0, PIC.1, SPP, Quality::Off).expect("the picture was refused");
        assert_eq!(got.len(), want.len());
        let d = max_diff(&got, &want);
        eprintln!("{:?}: picture against the viewport resolve, max diff {d}", t.path());
        assert!(d <= 1, "{:?}: the picture differs from the viewport by {d}", t.path());

        assert_eq!(t.size(), VIEW, "the picture left the viewport at another size");
        assert_eq!(t.samples(), 3, "the picture took the viewport's samples");
        t.frame(VIEW.0, VIEW.1, Duration::from_millis(50));
        assert!(t.samples() > 3, "the viewport stopped tracing after the picture");
        assert_eq!(t.fault(), None);
    }
}

#[test]
fn a_denoised_picture_blooms_and_keeps_its_size() {
    for mut t in tracers() {
        common::build(&mut t, "golden", Some(VIEW));
        t.set_bloom(Some(fundacad_tracer::Bloom { strength: 0.5, radius: 0.4, threshold: 0.2, side: 64 }));
        let mut p = t.begin_picture(PIC.0, PIC.1, SPP, Quality::High).unwrap();
        while !t.trace_picture(&mut p, Duration::from_millis(20)) {}
        assert_eq!(p.samples(), SPP);
        p.denoise();
        assert!(p.denoised_by().is_some(), "the picture was not denoised");
        let px = t.finish_picture(p);
        assert_eq!(px.len(), (PIC.0 * PIC.1 * 4) as usize);
        assert!(px.chunks(4).any(|c| c[0] != c[1]), "a grey picture of a red ball");
        assert_eq!(t.size(), VIEW);
        assert_eq!(t.fault(), None);
    }
}

#[test]
fn a_camera_change_mid_picture_goes_to_the_viewport() {
    for mut t in tracers() {
        common::build(&mut t, "golden", Some(VIEW));
        let mut p = t.begin_picture(PIC.0, PIC.1, 64, Quality::Off).unwrap();
        t.trace_picture(&mut p, Duration::from_millis(1));
        let before = p.samples();
        t.set_camera(fundacad_tracer::Camera { eye: [9.0, 0.0, 1.0], target: [0.0; 3], up: [0.0, 0.0, 1.0], fov: 30.0 });
        t.trace_picture(&mut p, Duration::from_millis(1));
        assert!(p.samples() >= before, "the picture restarted for a camera the viewport took");
        t.finish_picture(p);
    }
}

#[test]
fn a_small_buffer_limit_refuses_the_picture_with_a_reason() {
    for mut t in tracers() {
        common::build(&mut t, "golden", Some(VIEW));
        t.render_samples(2);
        assert!(t.buffer_limit() >= 128 << 20, "{} binds {} bytes", t.adapter(), t.buffer_limit());
        t.limit_buffers_for_test(64 << 20);
        let why = t.picture(3840, 2160, 4, Quality::Off).expect_err("a 4K picture fit 64 MiB bindings");
        eprintln!("{why}");
        assert!(why.contains("binds at most 64 MiB"), "{why}");
        assert!(t.picture(1280, 720, 1, Quality::Off).is_ok());
        assert_eq!((t.size(), t.samples()), (VIEW, 2));
    }
}

#[test]
fn a_picture_encodes_as_a_png_of_its_size() {
    let px: Vec<u8> = (0..6 * 4 * 4).map(|i| i as u8).collect();
    let png = fundacad_tracer::encode_png(6, 4, &px).unwrap();
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    assert_eq!((info.width, info.height), (6, 4));
    assert_eq!(&buf[..info.buffer_size()], &px[..]);
}
