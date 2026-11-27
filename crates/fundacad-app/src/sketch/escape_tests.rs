use super::{action, Action, State};

#[test]
fn each_layer_peels_before_the_ones_under_it() {
    let all = State { dragging: true, pending: true, selection: true, armed: true };
    assert_eq!(action(all), Action::CancelDrag);
    assert_eq!(action(State { dragging: false, ..all }), Action::CancelPending);
    assert_eq!(action(State { selection: true, armed: true, ..State::default() }), Action::ClearSelection);
    assert_eq!(action(State { armed: true, ..State::default() }), Action::ArmSelect);
    assert_eq!(action(State::default()), Action::Close);
}
