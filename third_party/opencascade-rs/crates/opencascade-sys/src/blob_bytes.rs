pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/blob_bytes.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn blob_bytes_write_v3(shape: &TopoDS_Shape) -> Result<Vec<u8>>;
        pub fn blob_bytes_read(data: &[u8]) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
