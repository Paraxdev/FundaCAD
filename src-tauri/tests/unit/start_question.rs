use fundacad_lib::safe_mode::{Answer, NOT_SHOWN};
use fundacad_lib::start_question::exit_code;

#[test]
fn a_window_that_never_showed_is_no_answer() {
    assert_eq!(exit_code(None, false), NOT_SHOWN);
    assert_eq!(Answer::from_exit(Some(exit_code(None, false))), Err("its window did not show".to_string()));
}

#[test]
fn a_window_closed_after_it_showed_is_start_normally() {
    assert_eq!(Answer::from_exit(Some(exit_code(None, true))), Ok(Answer::Normal));
}

#[test]
fn a_choice_is_its_own_code() {
    for a in [Answer::Normal, Answer::Safe, Answer::Reset { plugins: false }, Answer::Reset { plugins: true }] {
        assert_eq!(Answer::from_exit(Some(exit_code(Some(a), true))), Ok(a));
    }
}
