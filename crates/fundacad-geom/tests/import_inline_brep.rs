//! The inline BREP of a stored import goes through a file on its way into the
//! kernel, and imports read at the same moment each have to get their own.

use std::sync::{Arc, Barrier};

use base64::Engine;
use fundacad_geom::features::import::brep_b64_to_shape;
use fundacad_geom::kernel;

const THREADS: usize = 4;
const ROUNDS: usize = 200;

fn cube_b64(side: f64) -> String {
    let dir = std::env::temp_dir().join(format!("fundacad-inline-brep-{}-{side}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("cube.brep");
    kernel::make_box(side, side, side).expect("cube").write_brep_text(&path).expect("written");
    let text = std::fs::read_to_string(&path).expect("read");
    let _ = std::fs::remove_dir_all(&dir);
    // The writer heads the file with a DBRep line the importer does not take.
    let body: Vec<&str> = text.lines().skip_while(|l| !l.starts_with("CASCADE")).collect();
    base64::engine::general_purpose::STANDARD.encode(body.join("\n") + "\n")
}

#[test]
fn imports_read_at_the_same_moment_each_get_their_own_body() {
    let start = Arc::new(Barrier::new(THREADS));
    let readers: Vec<_> = (1..=THREADS)
        .map(|n| {
            let side = n as f64;
            let b64 = cube_b64(side);
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                let mut wrong = Vec::new();
                for round in 0..ROUNDS {
                    start.wait();
                    match brep_b64_to_shape(&b64) {
                        Ok(shape) => {
                            let volume = kernel::volume(&shape);
                            if (volume - side.powi(3)).abs() > 1e-6 {
                                wrong.push(format!("round {round}: the {side} mm cube came back as {volume} mm3"));
                            }
                        }
                        Err(e) => wrong.push(format!("round {round}: the {side} mm cube was not read, {e:?}")),
                    }
                }
                wrong
            })
        })
        .collect();
    let wrong: Vec<String> = readers.into_iter().flat_map(|r| r.join().expect("reader")).collect();
    assert!(wrong.is_empty(), "{} of {} reads: {:?}", wrong.len(), THREADS * ROUNDS, &wrong[..wrong.len().min(6)]);
}
