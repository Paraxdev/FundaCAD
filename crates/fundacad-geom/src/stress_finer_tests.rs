use super::*;

const VOLUME: f64 = 8000.0;
const CEILING: usize = 30_000;

fn offer(wall: Option<f64>, ceiling: usize, memory: u64) -> Option<(usize, u64)> {
    let wall = wall.map(|thickness| ThinWall { thickness, at: [0.0; 3], face: 0 });
    Finer::within(VOLUME, ceiling, wall, memory).map(|f| (f.elements, f.seconds))
}

fn thin(elements: usize) -> Option<(usize, u64)> {
    Some((elements, adapt::release_seconds(elements).ceil() as u64))
}

fn solid(elements: usize) -> Option<(usize, u64)> {
    Some((elements, adapt::release_compact_seconds(elements).ceil() as u64))
}

fn silent_ceiling() -> usize {
    let limits = StressLimits::default();
    limits.auto_elements.min(adapt::release_elements_within(limits.retry_seconds))
}

#[test]
fn a_lost_face_with_no_wall_is_priced_as_a_solid_part_up_to_about_twice_the_elements() {
    let twice = (TETS_PER_SIZE_CUBED * VOLUME / (size_floor(VOLUME, CEILING) * FINER_STEP).powi(3)).ceil() as usize;
    assert!((55_000..65_000).contains(&twice), "{twice}");
    assert_eq!(offer(None, CEILING, solve::FINER_MEMORY_CAP), solid(twice));
    assert_eq!(offer(None, CEILING, 2_400_000_000), solid(adapt::elements_in_compact_memory(2_400_000_000)));
    assert_eq!(offer(None, CEILING, 900_000_000), None);
}

#[test]
fn a_lost_face_with_no_wall_past_the_silent_retry_gets_no_button() {
    assert!(adapt::elements_in_compact_memory(solve::FINER_MEMORY_CAP) < silent_ceiling());
    assert_eq!(offer(None, silent_ceiling(), solve::FINER_MEMORY_CAP), None);
}

#[test]
fn a_lost_face_on_a_known_wall_is_priced_as_a_thin_walled_part() {
    let holds = adapt::elements_in_memory(solve::FINER_MEMORY_CAP);
    assert_eq!(offer(Some(50.0), silent_ceiling(), solve::FINER_MEMORY_CAP), thin(holds));
}

#[test]
fn a_wall_is_offered_its_own_elements_only_when_the_memory_holds_them() {
    let at = |t: f64| (TETS_PER_SIZE_CUBED * VOLUME / (t * WALL_SHARE * RETRY_SHRINK).powi(3)).ceil() as usize;
    assert_eq!(offer(Some(1.3), CEILING, solve::FINER_MEMORY_CAP), thin(at(1.3)));
    assert_eq!(offer(Some(1.3), CEILING, 500_000_000), None);
    assert_eq!(offer(Some(0.5), CEILING, solve::FINER_MEMORY_CAP), None);
}

#[test]
fn the_finer_ceiling_sits_just_past_what_its_memory_holds_of_a_thin_part() {
    let holds = adapt::elements_in_memory(solve::FINER_MEMORY_CAP);
    assert!(holds < FINER_MAX_ELEMENTS && FINER_MAX_ELEMENTS < holds + holds / 5, "{holds}");
}
