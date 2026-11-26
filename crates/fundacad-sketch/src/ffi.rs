use std::ffi::c_void;

extern "C" {
    pub fn fc_gcs_new(values: *const f64, fixed: *const u8, n: i32) -> *mut c_void;
    pub fn fc_gcs_free(h: *mut c_void);
    pub fn fc_gcs_add(h: *mut c_void, op: i32, idx: *const i32, n: i32, flags: i32, tag: i32) -> i32;
    pub fn fc_gcs_solve(h: *mut c_void, algorithm: i32) -> i32;
    pub fn fc_gcs_apply(h: *mut c_void);
    pub fn fc_gcs_dof(h: *mut c_void) -> i32;
    pub fn fc_gcs_params(h: *mut c_void, out: *mut f64);
    pub fn fc_gcs_tags(h: *mut c_void, which: i32, out: *mut i32, cap: i32) -> i32;
}
