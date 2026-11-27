use super::Foot;

#[test]
fn the_foot_toggles_read_their_own_state_and_measure_is_no_toggle() {
    let isolate = Foot { isolate: true, section: false };
    assert_eq!(["Isolate", "Section View", "Measure"].map(|l| isolate.on(l)), [Some(true), Some(false), None]);
    let section = Foot { isolate: false, section: true };
    assert_eq!(["Isolate", "Section View", "Measure"].map(|l| section.on(l)), [Some(false), Some(true), None]);
    assert_eq!(Foot::default().on("Sketch"), None);
}

mod model {
    use super::super::model::*;

    fn press(g: &str, variants: bool) -> HoldEvent {
        HoldEvent::Press { group: g.into(), variants }
    }

    #[test]
    fn the_rail_mode_follows_sketch_then_tool_then_selection() {
        assert_eq!(mode(true, true, true), Mode::Sketch);
        assert_eq!(mode(false, true, true), Mode::Running);
        assert_eq!(mode(false, false, true), Mode::Selection);
        assert_eq!(mode(false, false, false), Mode::Model);
    }

    #[test]
    fn a_click_runs_the_face_and_a_hold_opens_then_picks() {
        let (s, e) = hold_step(&Hold::Idle, press("p", true));
        assert_eq!(e, Effect::None);
        assert_eq!(hold_step(&s, HoldEvent::Release { over: None }), (Hold::Idle, Effect::RunDefault("p".into())));
        let (open, e) = hold_step(&s, HoldEvent::Hold);
        assert_eq!(e, Effect::Open("p".into()));
        let over = Some(("p".into(), "primitive-sphere".into()));
        assert_eq!(
            hold_step(&open, HoldEvent::Release { over }),
            (Hold::Idle, Effect::Pick { group: "p".into(), action: "primitive-sphere".into() })
        );
        assert_eq!(hold_step(&open, HoldEvent::Release { over: None }), (Hold::Idle, Effect::Close));
    }

    #[test]
    fn a_cancel_drops_a_press_quietly_and_closes_an_open_flyout() {
        let (pressing, _) = hold_step(&Hold::Idle, press("p", true));
        assert_eq!(hold_step(&pressing, HoldEvent::Cancel), (Hold::Idle, Effect::None));
        let (open, _) = hold_step(&pressing, HoldEvent::Hold);
        assert_eq!(hold_step(&open, HoldEvent::Cancel), (Hold::Idle, Effect::Close));
    }

    #[test]
    fn a_category_never_opens_from_a_hold_and_a_press_on_the_open_one_closes() {
        let (s, _) = hold_step(&Hold::Idle, press("c", false));
        assert_eq!(hold_step(&s, HoldEvent::Hold).1, Effect::None);
        let open = Hold::Open { group: "c".into() };
        assert_eq!(hold_step(&open, press("c", false)), (Hold::Idle, Effect::Close));
        assert_eq!(hold_step(&open, press("d", true)).1, Effect::Close);
        assert_eq!(hold_step(&Hold::Idle, HoldEvent::ContextMenu { group: "p".into(), variants: true }).1, Effect::Open("p".into()));
        assert_eq!(hold_step(&Hold::Idle, HoldEvent::Release { over: None }), (Hold::Idle, Effect::None));
    }

    #[test]
    fn a_long_flyout_wraps_into_columns() {
        assert_eq!(flyout_rows(5, 900.), 5);
        assert_eq!(flyout_rows(30, 64. + 46. * 10.), 10);
        assert_eq!(flyout_rows(4, 10.), 1);
    }

    #[test]
    fn primitive_is_one_variants_family_inside_create() {
        let none = |_: &str| None;
        let rail = model_rail(&none);
        assert_eq!(rail[0].key().as_ref(), "sketch");
        let p = find(&rail, "fam:primitive").expect("primitive family");
        assert_eq!(p.style, Style::Variants);
        assert!(p.items.len() >= 4);
        assert_eq!(face_of(p, None).map(|t| t.action.as_ref()), Some("primitive-box"));
        assert_eq!(face_of(p, Some("primitive-torus")).map(|t| t.action.as_ref()), Some("primitive-torus"));
        assert_eq!(family_of(&rail, "primitive-sphere").map(|f| f.id.as_ref()), Some("fam:primitive"));
    }

    #[test]
    fn the_selection_offers_follow_its_winning_kind() {
        let edges = Counts { edge: 2, face: 1, ..Default::default() };
        assert_eq!(offers(edges), vec!["fillet", "chamfer"]);
        let bodies = Counts { body: 2, ..Default::default() };
        let o = offers(bodies);
        assert_eq!(&o[..2], &["fillet", "chamfer"]);
        assert!(o.contains(&"boolean-union"));
        assert!(!offers(Counts { body: 1, ..Default::default() }).contains(&"boolean-union"));
        assert!(offers(Counts::default()).is_empty());
        assert!(offers(Counts { face: 1, ..Default::default() }).contains(&"presspull"));
    }
}
