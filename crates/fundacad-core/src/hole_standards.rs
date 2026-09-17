//! Standard hole sizes, the tables of src/features/holeStandards.ts and
//! sidecar/hole_feature.py `standard_dims`.

pub const SIZES: [&str; 8] = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10"];

pub const FITS: [&str; 3] = ["close", "normal", "loose"];

pub const HOLE_TYPES: [&str; 4] = ["simple", "counterbore", "countersink", "insert"];

pub const DRILL_POINT_DEG: f64 = 118.0;

pub const INSERT_LEAD_IN: f64 = 0.5;

/// ISO 273 clearance holes: close, normal, loose.
pub fn clearance(size: &str) -> Option<[f64; 3]> {
    Some(match size {
        "M2" => [2.2, 2.4, 2.6],
        "M2.5" => [2.7, 2.9, 3.1],
        "M3" => [3.2, 3.4, 3.6],
        "M4" => [4.3, 4.5, 4.8],
        "M5" => [5.3, 5.5, 5.8],
        "M6" => [6.4, 6.6, 7.0],
        "M8" => [8.4, 9.0, 10.0],
        "M10" => [10.5, 11.0, 12.0],
        _ => return None,
    })
}

/// Tap drill for the coarse pitch.
pub fn tap_drill(size: &str) -> Option<f64> {
    Some(match size {
        "M2" => 1.6,
        "M2.5" => 2.05,
        "M3" => 2.5,
        "M4" => 3.3,
        "M5" => 4.2,
        "M6" => 5.0,
        "M8" => 6.8,
        "M10" => 8.5,
        _ => return None,
    })
}

/// ISO 4762 socket head cap screw: counterbore diameter and depth.
pub fn counterbore(size: &str) -> Option<[f64; 2]> {
    Some(match size {
        "M2" => [4.4, 2.4],
        "M2.5" => [5.5, 2.9],
        "M3" => [6.5, 3.4],
        "M4" => [8.0, 4.4],
        "M5" => [10.0, 5.4],
        "M6" => [11.0, 6.4],
        "M8" => [15.0, 8.6],
        "M10" => [18.0, 10.6],
        _ => return None,
    })
}

/// ISO 10642 90 degree countersunk head: countersink diameter at the face.
pub fn countersink(size: &str) -> Option<f64> {
    Some(match size {
        "M2" => 4.4,
        "M2.5" => 5.5,
        "M3" => 6.9,
        "M4" => 9.2,
        "M5" => 11.5,
        "M6" => 13.7,
        "M8" => 18.3,
        "M10" => 22.7,
        _ => return None,
    })
}

/// Brass heat-set inserts: bore diameter and depth.
pub fn insert(size: &str) -> Option<[f64; 2]> {
    Some(match size {
        "M2" => [3.2, 4.0],
        "M2.5" => [3.6, 5.0],
        "M3" => [4.0, 6.0],
        "M4" => [5.6, 9.0],
        "M5" => [6.4, 10.0],
        _ => return None,
    })
}

/// The dimensions a hole type and size default to; `None` where the standard
/// defines nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HoleDims {
    pub diameter: Option<f64>,
    pub depth: Option<f64>,
    pub cb_diameter: Option<f64>,
    pub cb_depth: Option<f64>,
    pub cs_diameter: Option<f64>,
    pub cs_angle: Option<f64>,
    pub lead_in: Option<f64>,
}

/// `standard_dims` as the engine reads it: an unknown fit is the normal one,
/// where the app's picker falls back to close.
pub fn standard_dims(
    hole_type: &str,
    standard: Option<&str>,
    size: Option<&str>,
    fit: Option<&str>,
) -> HoleDims {
    let mut out = HoleDims::default();
    let size = size.unwrap_or("");
    if hole_type == "insert" {
        if let Some([d, h]) = insert(size) {
            out.diameter = Some(d);
            out.depth = Some(h);
        }
        out.lead_in = Some(INSERT_LEAD_IN);
        return out;
    }
    if standard == Some("tap") && tap_drill(size).is_some() {
        out.diameter = tap_drill(size);
    } else if matches!(standard, None | Some("clearance")) {
        if let Some(c) = clearance(size) {
            let i = fit.and_then(|f| FITS.iter().position(|x| *x == f)).unwrap_or(1);
            out.diameter = Some(c[i]);
        }
    }
    if hole_type == "counterbore" {
        if let Some([d, h]) = counterbore(size) {
            out.cb_diameter = Some(d);
            out.cb_depth = Some(h);
        }
    }
    if hole_type == "countersink" {
        if let Some(d) = countersink(size) {
            out.cs_diameter = Some(d);
            out.cs_angle = Some(90.0);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standards_fill_what_they_define() {
        let m3 = standard_dims("counterbore", None, Some("M3"), None);
        assert_eq!(m3.diameter, Some(3.4));
        assert_eq!((m3.cb_diameter, m3.cb_depth), (Some(6.5), Some(3.4)));
        assert_eq!(standard_dims("simple", Some("tap"), Some("M5"), None).diameter, Some(4.2));
        assert_eq!(standard_dims("simple", None, Some("M8"), Some("loose")).diameter, Some(10.0));
        assert_eq!(standard_dims("simple", None, Some("M8"), Some("snug")).diameter, Some(9.0));
        assert_eq!(standard_dims("simple", Some("custom"), Some("M8"), None).diameter, None);
        let ins = standard_dims("insert", None, Some("M8"), None);
        assert_eq!((ins.diameter, ins.lead_in), (None, Some(INSERT_LEAD_IN)));
        let cs = standard_dims("countersink", None, Some("M4"), Some("close"));
        assert_eq!((cs.diameter, cs.cs_diameter, cs.cs_angle), (Some(4.3), Some(9.2), Some(90.0)));
    }
}
