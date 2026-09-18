//! The scoring constants of `by:"match"` and `by:"nearest"`, sidecar/geom_select.py
//! `_DEFAULTS` overridden by selector_tuning.json.
//!
//! The shipped JSON is compiled in and is what the app runs with: its TIE_BAND
//! (0.05) is not the code default (0.15). An eval hands a different file to
//! `configure`, as `eval_selector_survival.py --config` does.

use std::sync::OnceLock;

use serde_json::Value;

const SHIPPED: &str = include_str!("selector_tuning.json");

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tuning {
    pub ang_tol: f64,
    pub pos_drift: f64,
    pub rel_drift: f64,
    pub len_rel_tol: f64,
    pub area_rel_tol: f64,
    pub tie_band: f64,
    pub nearest_tie_band: f64,
    pub accept_max: f64,
    pub w_pos: f64,
    pub w_dir: f64,
    pub w_len: f64,
    pub w_rad: f64,
    pub w_area: f64,
    pub w_type: f64,
    pub w_rank: f64,
}

impl Default for Tuning {
    /// The code defaults, what applies when no tuning file is found.
    fn default() -> Self {
        Tuning {
            ang_tol: 0.02,
            pos_drift: 0.5,
            rel_drift: 1e-3,
            len_rel_tol: 0.02,
            area_rel_tol: 0.05,
            tie_band: 0.15,
            nearest_tie_band: 0.02,
            accept_max: 2.5,
            w_pos: 3.0,
            w_dir: 2.0,
            w_len: 1.0,
            w_rad: 2.0,
            w_area: 1.0,
            w_type: 4.0,
            w_rank: 2.0,
        }
    }
}

impl Tuning {
    /// The tuning the app ships, the defaults under selector_tuning.json.
    pub fn shipped() -> &'static Tuning {
        static SHIPPED_TUNING: OnceLock<Tuning> = OnceLock::new();
        SHIPPED_TUNING.get_or_init(|| {
            let mut t = Tuning::default();
            if let Ok(v) = serde_json::from_str::<Value>(SHIPPED) {
                t.configure(&v);
            }
            t
        })
    }

    /// `configure(src)`: known keys holding numbers override, anything else is ignored.
    pub fn configure(&mut self, src: &Value) {
        let fields: [(&str, &mut f64); 15] = [
            ("ANG_TOL", &mut self.ang_tol),
            ("POS_DRIFT", &mut self.pos_drift),
            ("REL_DRIFT", &mut self.rel_drift),
            ("LEN_REL_TOL", &mut self.len_rel_tol),
            ("AREA_REL_TOL", &mut self.area_rel_tol),
            ("TIE_BAND", &mut self.tie_band),
            ("NEAREST_TIE_BAND", &mut self.nearest_tie_band),
            ("ACCEPT_MAX", &mut self.accept_max),
            ("W_POS", &mut self.w_pos),
            ("W_DIR", &mut self.w_dir),
            ("W_LEN", &mut self.w_len),
            ("W_RAD", &mut self.w_rad),
            ("W_AREA", &mut self.w_area),
            ("W_TYPE", &mut self.w_type),
            ("W_RANK", &mut self.w_rank),
        ];
        for (key, slot) in fields {
            if let Some(v) = src.get(key).and_then(Value::as_f64) {
                *slot = v;
            }
        }
    }

    /// `POS_DRIFT + REL_DRIFT * _bbox_diag(part)`.
    pub fn pos_tol(&self, bbox_diagonal: f64) -> f64 {
        self.pos_drift + self.rel_drift * bbox_diagonal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_file_overrides_the_tie_band() {
        let t = Tuning::shipped();
        assert_eq!(Tuning::default().tie_band, 0.15);
        assert_eq!(t.tie_band, 0.05);
        assert_eq!(t.nearest_tie_band, 0.02);
        assert_eq!(t.w_rank, 2.0);
    }

    #[test]
    fn configure_keeps_missing_keys_and_ignores_unknown_ones() {
        let mut t = Tuning::default();
        t.configure(&serde_json::json!({"W_POS": 7, "BOGUS": 1, "TIE_BAND": "x"}));
        assert_eq!(t.w_pos, 7.0);
        assert_eq!(t.tie_band, 0.15);
    }
}
