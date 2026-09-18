//! Plain single-object 3MF, replaces `write_plain_3mf` and `mesh_chunks` of
//! the Python engine's `mesh_writers.py`. The model part is streamed into the zip.

use std::io::{self, Seek, Write};
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::pyfmt::g6;

pub const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"#;

pub const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;

/// The `3D/3dmodel.model` part.
pub fn write_model(
    positions: &[f64],
    indices: &[u32],
    unit: &str,
    out: &mut impl Write,
) -> io::Result<()> {
    write!(
        out,
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model unit=\"{unit}\" xml:lang=\"en-US\" \
         xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\n \
         <metadata name=\"Application\">FundaCAD</metadata>\n <resources><object id=\"1\" type=\"model\">"
    )?;
    out.write_all(b"<mesh><vertices>")?;
    for p in positions.chunks_exact(3) {
        write!(
            out,
            "<vertex x=\"{}\" y=\"{}\" z=\"{}\"/>",
            g6(p[0]),
            g6(p[1]),
            g6(p[2])
        )?;
    }
    out.write_all(b"</vertices><triangles>")?;
    for t in indices.chunks_exact(3) {
        write!(
            out,
            "<triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>",
            t[0], t[1], t[2]
        )?;
    }
    out.write_all(b"</triangles></mesh>")?;
    out.write_all(
        b"</object></resources>\n <build><item objectid=\"1\" printable=\"1\"/></build>\n</model>",
    )
}

pub fn write(
    positions: &[f64],
    indices: &[u32],
    unit: &str,
    out: impl Write + Seek,
) -> zip::result::ZipResult<()> {
    let mut z = ZipWriter::new(out);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    z.start_file("[Content_Types].xml", opts)?;
    z.write_all(CONTENT_TYPES.as_bytes())?;
    z.start_file("_rels/.rels", opts)?;
    z.write_all(RELS.as_bytes())?;
    z.start_file("3D/3dmodel.model", opts.large_file(true))?;
    {
        let mut buf = io::BufWriter::with_capacity(1 << 16, &mut z);
        write_model(positions, indices, unit, &mut buf)?;
        buf.flush()?;
    }
    z.finish()?.flush()?;
    Ok(())
}

pub fn write_file(positions: &[f64], indices: &[u32], unit: &str, path: &Path) -> io::Result<()> {
    let file = std::fs::File::create(path)?;
    write(positions, indices, unit, file).map_err(io::Error::other)
}
