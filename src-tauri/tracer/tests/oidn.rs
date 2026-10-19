//! The runtime loader of Open Image Denoise: a set that is missing a file or
//! does not match its digests is refused before anything is loaded, and an
//! archive is unpacked only when it matches its own digest.

use std::io::Write;
use std::path::PathBuf;

use fundacad_tracer::oidn::{self, sha256_hex, Api, Pinned, Release};

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-oidn-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn files(set: &[(&'static str, &'static [u8])]) -> &'static [Pinned] {
    let v: Vec<Pinned> = set.iter().map(|(name, bytes)| Pinned { member: leak(format!("bin/{name}")), file: leak(format!("bin/{name}")), sha256: leak(sha256_hex(bytes)) }).collect();
    Box::leak(v.into_boxed_slice())
}

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(bytes).unwrap();
    }
    z.finish().unwrap().into_inner()
}

const SET: &[(&str, &[u8])] = &[("a.dll", b"first library"), ("b.dll", b"second library")];

#[test]
fn a_missing_file_is_refused_without_loading() {
    let d = scratch("missing");
    std::fs::create_dir_all(d.join("bin")).unwrap();
    std::fs::write(d.join("bin/a.dll"), SET[0].1).unwrap();
    let err = Api::open(&d, files(SET)).err().expect("refused");
    assert!(err.contains("bin/b.dll is missing"), "{err}");
}

#[test]
fn a_file_with_another_digest_is_refused_without_loading() {
    let d = scratch("hash");
    std::fs::create_dir_all(d.join("bin")).unwrap();
    std::fs::write(d.join("bin/a.dll"), SET[0].1).unwrap();
    std::fs::write(d.join("bin/b.dll"), b"not the pinned library").unwrap();
    let err = Api::open(&d, files(SET)).err().expect("refused");
    assert!(err.contains("bin/b.dll does not match"), "{err}");
}

#[test]
fn the_platform_load_from_an_empty_folder_leaves_the_filter_with_a_note() {
    let d = scratch("empty");
    assert!(oidn::load(&d).is_err());
    assert!(oidn::api().is_none());
    assert!(oidn::note().is_some());
    assert_eq!(fundacad_tracer::denoise::active(), fundacad_tracer::Denoiser::Filter);
}

#[test]
fn an_archive_unpacks_only_its_pinned_set() {
    let archive = zip_of(&[("oidn-x/bin/a.dll", SET[0].1), ("oidn-x/bin/b.dll", SET[1].1), ("oidn-x/bin/oidnDenoise.exe", b"never")]);
    let rel = Release { url: "", sha256: leak(sha256_hex(&archive)), bytes: archive.len() as u64, installed: 0, zip: true, files: files(SET) };
    let dest = scratch("install").join("2.5.1");
    oidn::install(&archive, &rel, &dest).unwrap();
    assert!(oidn::verify(&dest, rel.files).is_ok());
    assert!(!dest.join("bin/oidnDenoise.exe").exists(), "nothing outside the CPU set is written");
}

#[test]
fn an_archive_with_another_digest_writes_nothing() {
    let archive = zip_of(&[("oidn-x/bin/a.dll", SET[0].1), ("oidn-x/bin/b.dll", SET[1].1)]);
    let rel = Release { url: "", sha256: leak(sha256_hex(b"other")), bytes: 0, installed: 0, zip: true, files: files(SET) };
    let dest = scratch("badzip").join("2.5.1");
    let err = oidn::install(&archive, &rel, &dest).err().expect("refused");
    assert!(err.contains("pinned release digest"), "{err}");
    assert!(!dest.exists());
}

#[test]
fn an_archive_missing_a_pinned_file_writes_nothing() {
    let archive = zip_of(&[("oidn-x/bin/a.dll", SET[0].1)]);
    let rel = Release { url: "", sha256: leak(sha256_hex(&archive)), bytes: 0, installed: 0, zip: true, files: files(SET) };
    let dest = scratch("short").join("2.5.1");
    assert!(oidn::install(&archive, &rel, &dest).is_err());
    assert!(!dest.exists() && !dest.with_extension("part").exists());
}

/// The real release, when FUNDACAD_OIDN_ARCHIVE names its downloaded archive:
/// installed, loaded and run on a noisy flat patch.
#[test]
fn the_official_release_installs_loads_and_denoises() {
    let Some(path) = std::env::var_os("FUNDACAD_OIDN_ARCHIVE") else {
        println!("skipped, FUNDACAD_OIDN_ARCHIVE is not set");
        return;
    };
    let rel = oidn::release().unwrap();
    let dest = scratch("real").join(oidn::VERSION);
    oidn::install(&std::fs::read(path).unwrap(), rel, &dest).unwrap();
    let api = Api::open(&dest, rel.files).unwrap();
    let (w, h) = (32, 24);
    let mut seed = 12345u32;
    let color: Vec<f32> = (0..w * h)
        .flat_map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            [0.2 + 0.6 * (seed >> 8) as f32 / (1u32 << 24) as f32; 3]
        })
        .collect();
    let input = fundacad_tracer::denoise::Input {
        width: w,
        height: h,
        color,
        albedo: vec![0.5; w * h * 3],
        normal: [0.0, 0.0, 1.0].repeat(w * h),
        depth: vec![5.0; w * h],
        samples: 4,
    };
    let out = api.denoise(&input, fundacad_tracer::Quality::Standard).unwrap();
    let rms = |v: &[f32]| (v.iter().map(|x| (x - 0.5) * (x - 0.5)).sum::<f32>() / v.len() as f32).sqrt();
    println!("rms off the mean {:.3} denoised to {:.3}", rms(&input.color), rms(&out));
    assert!(rms(&out) < rms(&input.color) * 0.5);
}
