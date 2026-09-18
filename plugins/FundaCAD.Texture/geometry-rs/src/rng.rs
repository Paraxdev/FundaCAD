//! `np.random.default_rng(seed).permutation(256)`, bit for bit: numpy's
//! SeedSequence hashing the seed into PCG64's state, and Generator.shuffle's
//! Fisher-Yates walk with masked rejection sampling of 32 bit draws. The noise
//! kinds' gradient table is this permutation, so every noise texture depends
//! on reproducing it exactly.

const INIT_A: u32 = 0x43b0_d7e5;
const MULT_A: u32 = 0x931e_8875;
const INIT_B: u32 = 0x8b51_f9dd;
const MULT_B: u32 = 0x58f3_8ded;
const MIX_MULT_L: u32 = 0xca01_f9dd;
const MIX_MULT_R: u32 = 0x4973_f715;
const XSHIFT: u32 = 16;
const POOL: usize = 4;

struct Hasher(u32);

impl Hasher {
    fn mix(&mut self, mut value: u32, mult: u32) -> u32 {
        value ^= self.0;
        self.0 = self.0.wrapping_mul(mult);
        value = value.wrapping_mul(self.0);
        value ^ (value >> XSHIFT)
    }
}

fn mix(x: u32, y: u32) -> u32 {
    let r = MIX_MULT_L.wrapping_mul(x).wrapping_sub(MIX_MULT_R.wrapping_mul(y));
    r ^ (r >> XSHIFT)
}

/// SeedSequence(seed).generate_state(8, uint32), for a non-negative seed.
fn seed_state(seed: u64) -> [u32; 8] {
    let mut entropy: Vec<u32> = Vec::new();
    let mut s = seed;
    loop {
        entropy.push(s as u32);
        s >>= 32;
        if s == 0 {
            break;
        }
    }
    let mut h = Hasher(INIT_A);
    let mut pool = [0u32; POOL];
    for (i, slot) in pool.iter_mut().enumerate() {
        *slot = h.mix(entropy.get(i).copied().unwrap_or(0), MULT_A);
    }
    for src in 0..POOL {
        for dst in 0..POOL {
            if src != dst {
                let hashed = h.mix(pool[src], MULT_A);
                pool[dst] = mix(pool[dst], hashed);
            }
        }
    }
    for &e in entropy.iter().skip(POOL) {
        for slot in pool.iter_mut() {
            let hashed = h.mix(e, MULT_A);
            *slot = mix(*slot, hashed);
        }
    }
    let mut g = Hasher(INIT_B);
    let mut out = [0u32; 8];
    for (i, o) in out.iter_mut().enumerate() {
        *o = g.mix(pool[i % POOL], MULT_B);
    }
    out
}

const PCG_MULT: u128 = 0x2360_ED05_1FC6_5DA4_4385_DF64_9FCC_F645;

pub struct Pcg64 {
    state: u128,
    inc: u128,
    half: Option<u32>,
}

impl Pcg64 {
    pub fn new(seed: u64) -> Pcg64 {
        let w = seed_state(seed);
        let word = |i: usize| u64::from(w[i]) | (u64::from(w[i + 1]) << 32);
        let initstate = (u128::from(word(0)) << 64) | u128::from(word(2));
        let initseq = (u128::from(word(4)) << 64) | u128::from(word(6));
        let mut r = Pcg64 {
            state: 0,
            inc: (initseq << 1) | 1,
            half: None,
        };
        r.step();
        r.state = r.state.wrapping_add(initstate);
        r.step();
        r
    }

    fn step(&mut self) {
        self.state = self.state.wrapping_mul(PCG_MULT).wrapping_add(self.inc);
    }

    pub fn next64(&mut self) -> u64 {
        self.step();
        let s = self.state;
        let x = ((s >> 64) as u64) ^ (s as u64);
        x.rotate_right((s >> 122) as u32)
    }

    pub fn next32(&mut self) -> u32 {
        if let Some(h) = self.half.take() {
            return h;
        }
        let n = self.next64();
        self.half = Some((n >> 32) as u32);
        n as u32
    }

    /// `random_interval(max)`: uniform in [0, max] by masked rejection.
    fn interval(&mut self, max: u64) -> u64 {
        if max == 0 {
            return 0;
        }
        let mut mask = max;
        for s in [1, 2, 4, 8, 16, 32] {
            mask |= mask >> s;
        }
        if max <= u64::from(u32::MAX) {
            loop {
                let v = u64::from(self.next32()) & mask;
                if v <= max {
                    return v;
                }
            }
        }
        loop {
            let v = self.next64() & mask;
            if v <= max {
                return v;
            }
        }
    }
}

/// `np.random.default_rng(seed).permutation(n)`.
pub fn permutation(seed: u64, n: usize) -> Vec<i64> {
    let mut r = Pcg64::new(seed);
    let mut a: Vec<i64> = (0..n as i64).collect();
    for i in (1..n).rev() {
        let j = r.interval(i as u64) as usize;
        a.swap(i, j);
    }
    a
}
