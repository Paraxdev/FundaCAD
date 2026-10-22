use fundacad_geom::printcheck::bvh::*;

/// A small deterministic generator, so the test needs no crate.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
    fn point(&mut self, size: f64) -> [f64; 3] {
        [self.next() * size, self.next() * size, self.next() * size]
    }
}

#[test]
fn the_tree_finds_what_trying_every_triangle_finds() {
    let mut r = Lcg(7);
    let tris: Vec<Tri> = (0..400)
        .map(|i| {
            let c = r.point(20.0);
            let p = [
                c,
                [c[0] + r.next() * 3.0, c[1] + r.next(), c[2]],
                [c[0], c[1] + r.next() * 3.0, c[2] + r.next() * 2.0],
            ];
            Tri { p, body: i % 3, tri: i }
        })
        .collect();
    let bvh = Bvh::new(tris.clone());
    for _ in 0..1000 {
        let o = r.point(20.0);
        let mut d = [r.next() - 0.5, r.next() - 0.5, r.next() - 0.5];
        let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        for x in &mut d {
            *x /= l;
        }
        let brute = tris
            .iter()
            .enumerate()
            .filter_map(|(k, t)| intersect(o, d, &t.p).filter(|&s| (0.0..=5.0).contains(&s)).map(|s| (s, k)))
            .min_by(|a, b| a.0.total_cmp(&b.0));
        let got = bvh.first_hit(o, d, 0.0, 5.0, usize::MAX, |_| true).map(|(h, k)| (h.t, k));
        assert_eq!(got, brute);
    }
}
