use super::super::rail::Foot;
use super::{foot_act, FootAct};

#[test]
fn section_view_turns_off_when_on_and_opens_when_off() {
    assert_eq!(foot_act("Section View", Foot { isolate: true, section: true }), Some(FootAct::SectionOff));
    assert_eq!(foot_act("Section View", Foot { isolate: true, section: false }), Some(FootAct::Run("section")));
}

#[test]
fn isolate_and_measure_run_their_commands_whatever_the_toggles() {
    for foot in [Foot::default(), Foot { isolate: true, section: true }] {
        assert_eq!(foot_act("Isolate", foot), Some(FootAct::Run("isolate")));
        assert_eq!(foot_act("Measure", foot), Some(FootAct::Run("measure")));
        assert_eq!(foot_act("Sketch", foot), None);
    }
}
