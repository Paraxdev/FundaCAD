//! The engine executable opts into the Windows Segment Heap. Meshing a big
//! document on the default NT heap spends most of its kernel time faulting in
//! the 1 MiB blocks OCCT's BRepMesh allocates and frees per face, which keeps
//! the mesh threads from scaling.

#[cfg(windows)]
#[test]
fn the_engine_exe_embeds_a_manifest_asking_for_the_segment_heap() {
    let exe = std::fs::read(env!("CARGO_BIN_EXE_fundacad-engine")).expect("read the engine executable");
    let has = |needle: &str| exe.windows(needle.len()).any(|w| w == needle.as_bytes());
    assert!(has("urn:schemas-microsoft-com:asm.v1"), "the engine executable embeds no manifest");
    assert!(
        has("<heapType xmlns=\"http://schemas.microsoft.com/SMI/2020/WindowsSettings\">SegmentHeap</heapType>"),
        "the engine executable's manifest does not ask for the Segment Heap"
    );
}
