//! A heightmap image as Pillow's `Image.open(path).convert("L")` gives it, read
//! through the host's `files` interface and decoded in pure Rust (PNG, JPEG,
//! BMP, the formats the panel offers).
//!
//! Pillow's RGB to L is `(R*19595 + G*38470 + B*7471 + 0x8000) >> 16`, a 16 bit
//! grey is clipped to 255 and 16 bit colour keeps its high byte. PNG and BMP
//! decode to the same pixels; a JPEG's decoder (libjpeg-turbo there, zune-jpeg
//! here) may round a pixel one level apart.

use image::{DynamicImage, ImageFormat};

use crate::fundacad::plugin::files;
use crate::height::Gray;

fn l24(r: u32, g: u32, b: u32) -> f64 {
    f64::from((r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16)
}

fn decode(path: &str) -> Result<DynamicImage, String> {
    let bytes = files::read(path)?;
    let unknown = || format!("cannot identify image file {}", crate::py::repr_str(path));
    let format = image::guess_format(&bytes).map_err(|_| unknown())?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Bmp) {
        return Err(unknown());
    }
    image::load_from_memory_with_format(&bytes, format).map_err(|e| e.to_string())
}

/// Whether the image opens, for the feature's validation.
pub fn check(path: &str) -> Result<(), String> {
    decode(path).map(|_| ())
}

/// The image as L levels over 255, row 0 the top.
pub fn load(path: &str) -> Result<Gray, String> {
    let img = decode(path)?;
    let (w, h) = (img.width() as usize, img.height() as usize);
    let px: Vec<f64> = match &img {
        DynamicImage::ImageLuma8(b) => b.pixels().map(|p| f64::from(p.0[0])).collect(),
        DynamicImage::ImageLumaA8(b) => b.pixels().map(|p| f64::from(p.0[0])).collect(),
        DynamicImage::ImageLuma16(b) => b.pixels().map(|p| f64::from(p.0[0].min(255))).collect(),
        DynamicImage::ImageLumaA16(b) => b.pixels().map(|p| f64::from(p.0[0].min(255))).collect(),
        DynamicImage::ImageRgb8(b) => b
            .pixels()
            .map(|p| l24(u32::from(p.0[0]), u32::from(p.0[1]), u32::from(p.0[2])))
            .collect(),
        DynamicImage::ImageRgba8(b) => b
            .pixels()
            .map(|p| l24(u32::from(p.0[0]), u32::from(p.0[1]), u32::from(p.0[2])))
            .collect(),
        DynamicImage::ImageRgb16(b) => b
            .pixels()
            .map(|p| l24(u32::from(p.0[0] >> 8), u32::from(p.0[1] >> 8), u32::from(p.0[2] >> 8)))
            .collect(),
        DynamicImage::ImageRgba16(b) => b
            .pixels()
            .map(|p| l24(u32::from(p.0[0] >> 8), u32::from(p.0[1] >> 8), u32::from(p.0[2] >> 8)))
            .collect(),
        other => {
            let rgb = other.to_rgb8();
            rgb.pixels()
                .map(|p| l24(u32::from(p.0[0]), u32::from(p.0[1]), u32::from(p.0[2])))
                .collect()
        }
    };
    Ok(Gray {
        w,
        h,
        px: px.into_iter().map(|x| x / 255.0).collect(),
    })
}
