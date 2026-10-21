//! The app executable keeps Tauri's Common-Controls v6 dependency and opts
//! into the Segment Heap, since it is also the engine it spawns to mesh.

#[cfg(windows)]
#[test]
fn the_app_exe_embeds_the_common_controls_and_segment_heap_manifest() {
    let exe = std::fs::read(env!("CARGO_BIN_EXE_fundacad")).expect("read the app executable");
    let has = |needle: &str| exe.windows(needle.len()).any(|w| w == needle.as_bytes());
    assert!(has("Microsoft.Windows.Common-Controls"), "the app manifest lost the Common-Controls v6 dependency");
    assert!(
        has("<heapType xmlns=\"http://schemas.microsoft.com/SMI/2020/WindowsSettings\">SegmentHeap</heapType>"),
        "the app manifest does not ask for the Segment Heap"
    );
}
