//! Bed Fit Check, FundaCAD.PrintToolbox's bedFit.ts: does the model's bounding box fit the bed as it sits.

#[cfg(test)]
mod tests;

pub struct Bed {
    pub id: &'static str,
    pub size: [f64; 3],
}

pub const PRESETS: &[Bed] = &[
    Bed { id: "180", size: [180., 180., 180.] },
    Bed { id: "220x250", size: [220., 220., 250.] },
    Bed { id: "256", size: [256., 256., 256.] },
    Bed { id: "300", size: [300., 300., 300.] },
    Bed { id: "350", size: [350., 350., 350.] },
];

pub const DEFAULT: &str = "256";

pub fn label(size: [f64; 3]) -> String {
    size.map(super::spell).join(" x ")
}

/// Whether `size` fits `bed` on all three axes, and the uniform scale that makes it fit, 1 when it does.
pub fn fit(size: [f64; 3], bed: [f64; 3]) -> (bool, f64) {
    let scale = (0..3).filter(|&i| size[i] > 0.0).map(|i| bed[i] / size[i]).fold(1.0, f64::min);
    let fits = (0..3).all(|i| size[i] <= bed[i] + 1e-9);
    (fits, scale)
}

/// The message the check gives. The percentage rounds down, so scaling by it does fit.
pub fn verdict(size: [f64; 3], bed: [f64; 3]) -> String {
    let (fits, scale) = fit(size, bed);
    let bed = label(bed);
    if fits {
        crate::i18n::tr!("inspect.bed.fits", bed = bed)
    } else {
        let pct = (scale * 100.0 + 1e-9).floor().max(0.0);
        crate::i18n::tr!("inspect.bed.tooBig", bed = bed, pct = super::spell(pct))
    }
}
