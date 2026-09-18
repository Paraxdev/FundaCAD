"""Write vectors.json: the Python half's height fields and noise permutations on
fixed inputs, which the Rust crate's unit tests hold its own against.

Run from sidecar/ with the sidecar venv:
  python ../plugins/FundaCAD.Texture/geometry-rs/tests/make_vectors.py
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "geometry"))

import texture_height as th  # noqa: E402

KINDS = ["knurl", "hex", "waves", "ribs", "voronoi", "noise", "stripes", "grid", "dots", "brick",
         "basket", "carbon", "isogrid", "grip", "leather"]


def main():
    rng = np.random.default_rng(20260918)
    u = rng.uniform(-20, 20, 60)
    v = rng.uniform(-20, 20, 60)
    # points exactly on pattern lines as well, where floor and mod decide
    u = np.concatenate([u, np.arange(-6, 6, 0.25)])
    v = np.concatenate([v, np.arange(-6, 6, 0.25)[::-1]])
    fields = []
    for kind in KINDS:
        for profile in ("facet", "round"):
            for sharp, angle, scale, seed in ((0.5, 0.0, 2.0, 0), (0.15, 30.0, 1.3, 5), (0.9, 90.0, 3.7, 42)):
                spec = {"kind": kind, "profile": profile, "sharpness": sharp, "angle": angle,
                        "scale": scale, "seed": seed, "octaves": 4}
                for smooth in (0.0, 0.6):
                    s = dict(spec, smooth=smooth) if smooth else spec
                    h = th.height_field_smoothed(kind, s, u, v)
                    fields.append({"spec": s, "h": [float(x) for x in h]})
    P = rng.uniform(-15, 15, (60, 3))
    W = np.abs(rng.standard_normal((60, 3)))
    W = W / W.sum(axis=1, keepdims=True)
    tri = []
    for kind in ("knurl", "noise", "hex"):
        spec = {"kind": kind, "scale": 2.5, "sharpness": 0.4, "angle": 15.0, "seed": 3}
        tri.append({"spec": spec, "offset": 0.7,
                    "h": [float(x) for x in th.triplanar_field(kind, spec, P, W, 0.7)]})
    perms = {str(s): [int(x) for x in np.random.default_rng(s).permutation(256)]
             for s in (0, 1, 2, 3, 7, 42, 12345, 2**32 + 5, 2**40 + 3)}
    hashes = [[i, j, s, t, float(th._hash01(np.array([i]), np.array([j]), s, t)[0])]
              for i, j, s, t in ((0, 0, 0, 1), (-5, 7, 3, 2), (123456, -98765, 42, 1), (2**31, 2**33, 99, 2))]
    out = {"u": [float(x) for x in u], "v": [float(x) for x in v], "fields": fields,
           "P": P.tolist(), "W": W.tolist(), "triplanar": tri, "permutations": perms, "hashes": hashes,
           "wave_phases": list(th._wave_phases())}
    with open(os.path.join(HERE, "vectors.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh)
    print(len(fields), "fields")


if __name__ == "__main__":
    main()
