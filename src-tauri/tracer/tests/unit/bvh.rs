use fundacad_tracer::bvh::{build, Bvh, STACK};

/// Every triangle in exactly one leaf, inside the leaf's box.
fn check_leaves(pos: &[[f32; 3]], idx: &[u32], t: &Bvh) {
    let mut seen = vec![0; idx.len() / 3];
    let mut stack = vec![0usize];
    while let Some(n) = stack.pop() {
        let (a, b) = (t.nodes[n * 2], t.nodes[n * 2 + 1]);
        let (first, count) = (a[3].to_bits() as usize, b[3].to_bits() as usize);
        if count == 0 {
            stack.extend([first, first + 1]);
            continue;
        }
        for &tri in &t.order[first..first + count] {
            seen[tri as usize] += 1;
            for k in 0..3 {
                let p = pos[idx[tri as usize * 3 + k] as usize];
                for ax in 0..3 {
                    assert!(p[ax] >= a[ax] && p[ax] <= b[ax]);
                }
            }
        }
    }
    assert!(seen.iter().all(|c| *c == 1));
}

#[test]
fn every_triangle_lands_in_exactly_one_leaf_inside_its_box() {
    let mut pos = vec![];
    let mut idx = vec![];
    for i in 0..200u32 {
        let x = (i % 20) as f32;
        let y = (i / 20) as f32;
        let b = pos.len() as u32;
        pos.extend([[x, y, 0.0], [x + 1.0, y, 0.1], [x, y + 1.0, 0.2]]);
        idx.extend([b, b + 1, b + 2]);
    }
    check_leaves(&pos, &idx, &build(&pos, &idx));
}

/// A rod 100 long and 0.02 across, its rings graded towards x = 0 by
/// `r` per ring, as a mesher refining towards an edge leaves it.
fn graded_rod(r: f32, rings: u32) -> (Vec<[f32; 3]>, Vec<u32>) {
    let seg = 8u32;
    let mut pos = vec![];
    let mut idx = vec![];
    for k in 0..rings {
        let x = -100.0 * r.powi(k as i32);
        for s in 0..seg {
            let a = std::f32::consts::TAU * s as f32 / seg as f32;
            pos.push([x, 0.01 * a.cos(), 0.01 * a.sin()]);
        }
    }
    for k in 0..rings - 1 {
        for s in 0..seg {
            let (a, b) = (k * seg + s, k * seg + (s + 1) % seg);
            idx.extend([a, b, a + seg, b, b + seg, a + seg]);
        }
    }
    (pos, idx)
}

#[test]
fn a_graded_rod_fits_the_shader_stack() {
    let (pos, idx) = graded_rod(0.9, 600);
    let t = build(&pos, &idx);
    check_leaves(&pos, &idx, &t);
    // sw.wgsl keeps the left child on the stack under each right step and
    // pushes two at an inner node.
    let mut worst = 0;
    let mut stack = vec![(0usize, 0u32)];
    while let Some((n, right)) = stack.pop() {
        let (a, b) = (t.nodes[n * 2], t.nodes[n * 2 + 1]);
        if b[3].to_bits() == 0 {
            worst = worst.max(right);
            let first = a[3].to_bits() as usize;
            stack.extend([(first, right), (first + 1, right + 1)]);
        }
    }
    assert!(worst + 2 <= STACK, "an inner node {worst} right steps down overflows a stack of {STACK}");
}
