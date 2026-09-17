//! OpenCASCADE's thread pool and parallel defaults, see include/osd_smp.hxx.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/osd_smp.hxx");

        pub fn osd_smp_configure(threads: i32) -> i32;
    }
}
