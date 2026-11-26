use fundacad_client::transfer::export::{ExportFormat, ExportSettings};

use super::TransferPrefs;

#[test]
fn stored_values_come_back_and_garbage_falls_to_the_defaults() {
    let export = ExportSettings { format: ExportFormat::Glb, ..Default::default() };
    let json = export.to_json();
    let p = TransferPrefs::from_stored(Some(&json), Some("D:/out".into()), Some("cm"));
    assert_eq!(p.export, export);
    assert_eq!(p.export_dir.as_deref(), Some("D:/out"));
    assert_eq!(p.import_unit, "cm");

    let p = TransferPrefs::from_stored(Some("not json"), Some("  ".into()), Some("furlong"));
    assert_eq!(p, TransferPrefs::from_stored(None, None, None));
    assert_eq!((p.export_dir, p.import_unit), (None, "m"));
}
