use fundacad_engine::sysmem::*;

const MIB: u64 = 1024 * 1024;

#[test]
fn this_machine_reports_some_memory() {
    let got = available_bytes().expect("a probe on a supported platform");
    assert!(got > 16 * MIB, "{got}");
}

#[test]
fn describe_matches_sysmem_py() {
    assert_eq!(describe(512), "512 B");
    assert_eq!(describe(2048), "2 KiB");
    assert_eq!(describe(5 * MIB), "5 MiB");
    assert_eq!(describe(1932735283), "1.8 GiB");
}

#[test]
fn an_import_that_fits_proceeds_and_one_that_does_not_is_named() {
    assert!(refuse_if_memory_is_short(100 * MIB, Some(64 * 1024 * MIB)).is_ok());
    let err = refuse_if_memory_is_short(356 * MIB, Some(2 * 1024 * MIB)).unwrap_err();
    assert!(err.starts_with("not enough memory to import this file"), "{err}");
    assert!(err.contains("3.5 GiB") && err.contains("2.0 GiB"), "{err}");
}

#[test]
fn the_headroom_is_part_of_the_refusal() {
    let size = 100 * MIB;
    let need = size * IMPORT_RSS_PER_FILE_BYTE;
    assert!(refuse_if_memory_is_short(size, Some(need)).is_err());
    assert!(refuse_if_memory_is_short(size, Some(need + need / 4)).is_ok());
}

#[test]
fn an_empty_file_is_never_refused() {
    assert!(refuse_if_memory_is_short(0, Some(0)).is_ok());
}
