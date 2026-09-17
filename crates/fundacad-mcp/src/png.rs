//! The canvas as a PNG. Python reached for Pillow here; this is the `png`
//! crate, which is the same deflate and the same filters.
//!
//! Renders go back inline as base64, so the size is a context cost rather than
//! a disk one, which is why the encoder is asked for its best compression.

use crate::render::Canvas;

pub fn encode(canvas: &Canvas) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, canvas.w, canvas.h);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::High);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("the render could not be encoded: {e}"))?;
        writer
            .write_image_data(&canvas.color)
            .map_err(|e| format!("the render could not be encoded: {e}"))?;
    }
    Ok(out)
}
