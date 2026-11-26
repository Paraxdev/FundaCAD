use super::*;

fn line(code: &str, key: &str, args: &[(&str, Arg)]) -> String {
    Catalog::new(code, None).text(key, args)
}

#[test]
fn each_shipped_language_reads_its_own_lines() {
    let cases = [
        ("en", "New", "File", "Exported 3 files"),
        ("de", "Neu", "Datei", "3 Dateien exportiert"),
        ("es", "Nuevo", "Archivo", "3 archivos exportados"),
        ("fr", "Nouveau", "Fichier", "3 fichiers exportés"),
        ("ja", "新規", "ファイル", "3 個のファイルをエクスポートしました"),
        ("zh-CN", "新建", "文件", "已导出 3 个文件"),
    ];
    for (code, new, file, done) in cases {
        assert_eq!(line(code, "command.new", &[]), new, "{code}");
        assert_eq!(line(code, "menu.file", &[]), file, "{code}");
        assert_eq!(line(code, "export.done", &[("n", 3.into())]), done, "{code}");
    }
}

#[test]
fn plurals_and_selects_follow_the_language() {
    assert_eq!(line("en", "export.done", &[("n", 1.into())]), "Exported 1 file");
    assert_eq!(line("de", "export.done", &[("n", 1.into())]), "1 Datei exportiert");
    assert_eq!(line("fr", "export.done", &[("n", 0.into())]), "0 fichier exporté");
    assert_eq!(line("de", "view.command", &[("view", "top".into())]), "Draufsicht");
    assert_eq!(line("ja", "view.command", &[("view", "iso".into())]), "等角図");
    assert_eq!(line("en", "analysis.colors.toggled", &[("on", true.into())]), "Component colors on");
}

#[test]
fn numbers_take_the_decimal_comma_of_the_language() {
    let args = [("threshold", Arg::from(42.5)), ("dir", Arg::from("+Z"))];
    assert!(line("en", "analysis.draft.on", &args).contains("below 42.5°"));
    assert!(line("de", "analysis.draft.on", &args).contains("unter 42,5°"));
    assert!(line("ja", "analysis.draft.on", &args).contains("42.5°"));
    assert_eq!(Catalog::new("fr", None).decimal_mark(), ',');
    assert_eq!(Catalog::new("zh-CN", None).decimal_mark(), '.');
}

#[test]
fn a_missing_line_falls_back_to_english_then_to_the_key() {
    let own = r#"{"command.new": "Nowy"}"#;
    let pl = Catalog::new("pl", Some(own));
    assert_eq!(pl.text("command.new", &[]), "Nowy");
    assert_eq!(pl.text("command.save", &[]), "Save");
    assert_eq!(pl.text("no.such.key", &[]), "no.such.key");
    assert_eq!(pl.decimal_mark(), ',');
}

#[test]
fn a_regional_own_file_falls_back_through_its_base() {
    let at = Catalog::new("de-AT", Some(r#"{"command.new": "Neu anlegen"}"#));
    assert_eq!(at.text("command.new", &[]), "Neu anlegen");
    assert_eq!(at.text("command.save", &[]), "Speichern");
}

#[test]
fn an_own_file_skips_lines_it_may_not_set() {
    let own = r#"{
        "command.new": "Nowy",
        "command.save": "<b>Zapisz</b>",
        "command.undo": 5,
        "command.redo": "Ponów {who}",
        "export.done": "{n, plural, on {x} other {y}}",
        "prefs.language.yours": "hacked",
        "nobody.knows": "x",
        "command.fit": "   "
    }"#;
    let c = Catalog::new("pl", Some(own));
    let status = c.status().unwrap();
    assert_eq!(status.lines, 1);
    let reasons: Vec<_> = status.skipped.iter().map(|(k, r)| (k.as_str(), *r)).collect();
    assert_eq!(
        reasons,
        [
            ("command.save", SkipReason::Markup),
            ("command.undo", SkipReason::NotText),
            ("command.redo", SkipReason::BadArgument),
            ("export.done", SkipReason::Syntax),
            ("prefs.language.yours", SkipReason::Locked),
            ("nobody.knows", SkipReason::UnknownKey),
            ("command.fit", SkipReason::Empty),
        ]
    );
    assert_eq!(c.text("command.save", &[]), "Save");
}

#[test]
fn an_own_file_that_is_not_flat_json_is_refused_whole() {
    let broken = Catalog::new("pl", Some("{\n  \"command.new\": \n}"));
    assert!(matches!(broken.status().unwrap().error, Some(FileError::NotJson { line: 3, .. })));
    let nested = Catalog::new("pl", Some(r#"{"a": {"b": "c"}}"#));
    assert_eq!(nested.status().unwrap().error, Some(FileError::NotFlat));
    let bom = Catalog::new("pl", Some("\u{feff}{\"command.new\": \"Nowy\"}"));
    assert_eq!(bom.text("command.new", &[]), "Nowy");
}

#[test]
fn pseudo_stretches_english_between_brackets() {
    assert_eq!(line(PSEUDO, "command.new", &[]), "[ÑÑééww]");
    assert_eq!(line(PSEUDO, "menu.file", &[]), "[Fíílééé]");
    assert_eq!(line(PSEUDO, "export.done", &[("n", 2.into())]), "[ÉÉxpöörtéédd 2 fíílééss]");
    assert_eq!(pseudo::pseudo_text("Box"), "[Bööxx]");
}

#[test]
fn every_shipped_line_parses() {
    // Note: FundaCAD 2 adds English lines ahead of their translations, a missing line falls back to English.
    let translated = parse_table(LOCALES[1].1);
    for (code, text) in LOCALES {
        let table = parse_table(text);
        for key in table.keys() {
            assert!(english_table().contains_key(key), "{code} {key} has an English line");
        }
        if code != "en" {
            assert_eq!(table.len(), translated.len(), "{code} has the same keys as {}", LOCALES[1].0);
        }
        for (key, src) in &table {
            assert!(format::parse(src).is_ok(), "{code} {key}: {src}");
        }
    }
}

#[test]
fn a_command_label_drops_its_ellipsis() {
    assert_eq!(Label::Command("command.open").text(), "Open");
    assert_eq!(Label::With("view.command", &[("view", "front")]).text(), "Front View");
    assert_eq!(Label::from("Parameters").text(), "Parameters");
}

#[test]
fn tr_fills_named_arguments() {
    assert_eq!(tr!("export.done", n = 2), "Exported 2 files");
    assert_eq!(tr!("menu.help.about", name = "FundaCAD 2"), "About FundaCAD 2");
}

#[test]
fn the_panel_lines_fill_their_arguments() {
    assert_eq!(tr!("step.label.rollBefore", step = "Fillet1"), "Roll back before Fillet1");
    assert_eq!(
        tr!("history.move.staysAfter", name = "Fillet1", other = "Pad"),
        "Fillet1 uses Pad, so it stays after it"
    );
    assert_eq!(
        tr!("feature.deletedUsers", head = "Deleted Pad", users = "Fillet1", n = 1),
        "Deleted Pad, Fillet1 used it"
    );
    assert_eq!(tr!("feature.deletedUsers", head = "Deleted Pad", users = "A, B", n = 2), "Deleted Pad, A, B used them");
    assert_eq!(
        tr!("export.failedFeatures", n = 2, first = "Pad"),
        "2 features failed, their bodies are missing from the file: Pad"
    );
    assert_eq!(tr!("import.doneFiles", n = 1), "Imported 1 file.");
    assert_eq!(tr!("import.busyMany", n = 3), "Importing 3 files");
    assert_eq!(tr!("insert.refreshed", n = 2), "Refreshed 2 linked bodies.");
    assert_eq!(tr!("items.vis.changed", show = "yes", n = 1), "Show 1 item");
    assert_eq!(tr!("items.vis.changed", show = "no", n = 3), "Hide 3 items");
    assert_eq!(tr!("tool.target.click", many = "yes", kind = "body"), "Click bodies to add or drop them");
    assert_eq!(tr!("tool.target.click", many = "no", kind = "face"), "Click the face to use");
    assert_eq!(tr!("history.chip.yourNote", note = "ask Ana"), "Your note: ask Ana");
}

#[test]
fn the_sketch_lines_fill_their_arguments() {
    assert_eq!(tr!("sketch.step.construction", on = "yes", name = "Line 1"), "Construction Line 1");
    assert_eq!(tr!("sketch.step.align", kind = "vertical", name = "Line 2"), "Vertical Line 2");
    assert_eq!(tr!("sketch.problem.notSize", value = -1.5), "-1.5 is not a size");
    assert_eq!(tr!("step.label.delete", n = 1, step = "Circle 1"), "Delete Circle 1");
    assert_eq!(tr!("date.short", day = "12", month = "nov", year = "2026"), "12 Nov 2026");
}

#[test]
fn the_tool_and_viewport_lines_fill_their_arguments() {
    assert_eq!(tr!("tool.target.pickFirst", many = "yes", kind = "body"), "Pick the bodies first");
    assert_eq!(tr!("tool.target.pickFirst", many = "no", kind = "edge"), "Pick the edge first");
    assert_eq!(tr!("sketch.status.dofLeft", n = 1), "1 degree of freedom left");
    assert_eq!(tr!("sketch.status.dofLeft", n = 4), "4 degrees of freedom left");
    assert_eq!(tr!("viewport.status.triangles", n = 1200), "1200 triangles");
    assert_eq!(tr!("viewport.status.push", grip = "Top", mm = 2.5), "drag to push Top (2.5 mm)");
}
