//! FundaCAD 1's ui/commandScore.ts: query characters in order, contiguous runs and a start match score higher, short
//! labels a little. 0 is no match. Both sides are expected lowercase.

pub fn score(query: &str, text: &str) -> f32 {
    if query.is_empty() {
        return 1.;
    }
    let text: Vec<char> = text.chars().collect();
    let mut at = 0;
    let mut total = 0.;
    let mut streak = 0.;
    for ch in query.chars() {
        let Some(found) = text.iter().skip(at).position(|&c| c == ch).map(|i| i + at) else { return 0. };
        if found == at {
            total += 2. + streak;
            streak += 1.;
        } else {
            total += 1.;
            streak = 0.;
        }
        if found == 0 {
            total += 3.;
        }
        at = found + 1;
    }
    total + (10. - text.len() as f32).max(0.) * 0.1
}
