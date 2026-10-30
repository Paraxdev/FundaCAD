use super::*;

const VOLUME: f64 = 8000.0;
const CEILING: usize = 30_000;

fn offered(wall: Option<f64>, finer_memory_cap: u64) -> Option<usize> {
    let wall = wall.map(|thickness| ThinWall { thickness, at: [0.0; 3], face: 0 });
    let limits = StressLimits { finer_memory_cap, ..Default::default() };
    Finer::past(VOLUME, CEILING, wall, &limits).map(|f| f.elements)
}

#[test]
fn a_lost_face_with_no_wall_is_offered_about_twice_the_elements_or_what_the_memory_holds() {
    let twice = (TETS_PER_SIZE_CUBED * VOLUME / (size_floor(VOLUME, CEILING) * FINER_STEP).powi(3)).ceil() as usize;
    assert!((55_000..65_000).contains(&twice), "{twice}");
    assert_eq!(offered(None, solve::FINER_MEMORY_CAP), Some(twice));
    assert_eq!(offered(None, 900_000_000), Some(adapt::elements_in_memory(900_000_000)));
    assert_eq!(offered(None, 300_000_000), None);
}

#[test]
fn a_wall_is_offered_its_own_elements_only_when_the_memory_holds_them() {
    let at = |t: f64| (TETS_PER_SIZE_CUBED * VOLUME / (t * WALL_SHARE * RETRY_SHRINK).powi(3)).ceil() as usize;
    assert_eq!(offered(Some(1.3), solve::FINER_MEMORY_CAP), Some(at(1.3)));
    assert_eq!(offered(Some(1.3), 500_000_000), None);
    assert_eq!(offered(Some(0.5), solve::FINER_MEMORY_CAP), None);
}

#[test]
fn the_finer_ceiling_sits_just_past_what_its_memory_holds_of_a_thin_part() {
    let holds = adapt::elements_in_memory(solve::FINER_MEMORY_CAP);
    assert!(holds < FINER_MAX_ELEMENTS && FINER_MAX_ELEMENTS < holds + holds / 5, "{holds}");
}
