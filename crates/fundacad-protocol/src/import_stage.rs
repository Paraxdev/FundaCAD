//! The stages an import names in its `importing` frames, in the order they run.
//! A format skips the stages it has no use for.

pub const READ: i64 = 0;
pub const TRANSFER: i64 = 1;
pub const WALK: i64 = 2;
pub const BUILD: i64 = 3;
pub const STORE: i64 = 4;

pub fn label(stage: i64) -> &'static str {
    match stage {
        READ => "Reading the file",
        TRANSFER => "Transferring shapes",
        WALK => "Colours, names and repairs",
        BUILD => "Building the parts",
        STORE => "Saving the geometry",
        _ => "Importing",
    }
}

/// `done` of `total` as a whole percentage, -1 when the stage has no fraction.
pub fn pct(done: i64, total: i64) -> i64 {
    if total <= 0 || done < 0 {
        return -1;
    }
    (done.min(total) * 100) / total
}
