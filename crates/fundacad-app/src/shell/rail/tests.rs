use super::Foot;

#[test]
fn the_foot_toggles_read_their_own_state_and_measure_is_no_toggle() {
    let isolate = Foot { isolate: true, section: false };
    assert_eq!(["Isolate", "Section View", "Measure"].map(|l| isolate.on(l)), [Some(true), Some(false), None]);
    let section = Foot { isolate: false, section: true };
    assert_eq!(["Isolate", "Section View", "Measure"].map(|l| section.on(l)), [Some(false), Some(true), None]);
    assert_eq!(Foot::default().on("Sketch"), None);
}
