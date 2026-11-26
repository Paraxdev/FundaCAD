# planegcs in FundaCAD

FreeCAD's PlaneGCS solver, LGPL-2.1-or-later (see `LICENSE`). It is compiled by
`crates/fundacad-sketch/build.rs` and driven through `crates/fundacad-sketch/cpp/gcs_shim.cpp`.

| | |
|---|---|
| Source | https://github.com/Salusoft89/planegcs, commit 9d26baef |
| FreeCAD revision it carries | 5f8eac49f31626354ee69bf40616bac801ca5560, `src/Mod/Sketcher/App/planegcs` |
| Files | `Constraints`, `GCS`, `Geo`, `SubSystem`, `qp_eq` (.cpp and .h), `Util.h` |
| Line endings | converted from CRLF to LF |

## Changes

The changes drop the Boost dependency. Solving behaviour is unchanged.

1. `Geo.h`: removed `#include <boost/math/constants/constants.hpp>` (nothing used it) and added `#include <cmath>`, which the Boost header had supplied.
2. `Constraints.cpp`: removed `#include <boost/graph/graph_concepts.hpp>`, and `#include <cassert>` is now unconditional, no longer only under `DEBUG_DERIVS`.
3. `GCS.cpp`: replaced the `Console.h`, `FCConfig.h` and Boost graph includes with `fc_console.h` and `fc_components.h`. The redundancy split's `boost::adjacency_list` and `boost::connected_components` became `fc::Components`.
4. New `fc_console.h`: a no-op `Console::Log`. GCS logs only in its debug modes.
5. New `fc_components.h`: union-find connected components. Components are numbered in order of their lowest vertex, the order boost's depth-first search assigns, so the subsystem split matches FreeCAD's.

## Updating

Copy the files listed above from a newer planegcs or FreeCAD, convert them to LF, and apply the changes again.
