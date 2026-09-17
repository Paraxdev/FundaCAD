//! Binary and ASCII STL, replaces `write_stl` and `write_stl_ascii` of
//! `sidecar/mesh_writers.py`.

use std::io::{self, BufWriter, Write};
use std::path::Path;

use super::pyfmt::e6;

fn corner<T: Copy>(pos: &[T], i: u32) -> [T; 3] {
    let i = i as usize * 3;
    [pos[i], pos[i + 1], pos[i + 2]]
}

/// Binary STL. The facet normal is computed in single precision, as numpy
/// does on the float32 vertex array.
pub fn write_binary(positions: &[f64], indices: &[u32], mut out: impl Write) -> io::Result<()> {
    let pos: Vec<f32> = positions.iter().map(|&v| v as f32).collect();
    let ntri = indices.len() / 3;
    out.write_all(&[0u8; 80])?;
    out.write_all(&(ntri as u32).to_le_bytes())?;
    let mut rec = [0u8; 50];
    for t in indices.chunks_exact(3) {
        let (a, b, c) = (corner(&pos, t[0]), corner(&pos, t[1]), corner(&pos, t[2]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let len = if len < 1e-12 { 1.0 } else { len };
        let n = [n[0] / len, n[1] / len, n[2] / len];
        for (k, v) in n.iter().chain(&a).chain(&b).chain(&c).enumerate() {
            rec[k * 4..k * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        out.write_all(&rec)?;
    }
    out.flush()
}

pub fn write_ascii(
    positions: &[f64],
    indices: &[u32],
    name: &str,
    mut out: impl Write,
) -> io::Result<()> {
    writeln!(out, "solid {name}")?;
    for t in indices.chunks_exact(3) {
        let (a, b, c) = (
            corner(positions, t[0]),
            corner(positions, t[1]),
            corner(positions, t[2]),
        );
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let len = if len < 1e-12 { 1.0 } else { len };
        let n = [n[0] / len, n[1] / len, n[2] / len];
        let p = |v: [f64; 3]| format!("{} {} {}", e6(v[0]), e6(v[1]), e6(v[2]));
        write!(
            out,
            "facet normal {}\n outer loop\n  vertex {}\n  vertex {}\n  vertex {}\n endloop\nendfacet\n",
            p(n),
            p(a),
            p(b),
            p(c)
        )?;
    }
    writeln!(out, "endsolid {name}")?;
    out.flush()
}

pub fn write_binary_file(positions: &[f64], indices: &[u32], path: &Path) -> io::Result<()> {
    write_binary(positions, indices, BufWriter::new(std::fs::File::create(path)?))
}

pub fn write_ascii_file(positions: &[f64], indices: &[u32], path: &Path) -> io::Result<()> {
    write_ascii(
        positions,
        indices,
        "FundaCAD",
        BufWriter::new(std::fs::File::create(path)?),
    )
}
