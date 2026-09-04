"""Which faces of a shape touch which, asked once instead of five times.

Four places in the sidecar wanted the same thing — walk from a face to the
faces that share an edge with it — and each built it by hand: the same two OCP
import blocks, the same pair of indexed maps, the same explorer loop. They
differed only in what they wanted back (a set of neighbour indices, the shared
edge as well, a filtered set, or the connected components), which is exactly
what `walk` yields and the two methods over it return.

"Share an edge" means the same TShape, not merely coincident geometry: this is
the kernel's own ancestor map, so it is exact where hashing vertex coordinates
would only be close. Two bodies touching face to face are NOT adjacent here,
which is the property `_refacet_clean` and `_drop_debris` both depend on.

A LEAF module: it knows about shapes and nothing about features, documents or
the rebuild, so anything in the sidecar may import it.
"""

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import Face


def _list_shapes(lst):
    """Elements of an OCP shape list WITHOUT draining its Python iterator.

    Exhausting a pybind11-bound OCCT collection costs ~101 us of FIXED cost when
    StopIteration fires, independent of length, while Extent() is 0.18 us and
    First()/Last() are 0.55 us together. In a per-EDGE loop that dominates
    everything else: the same pattern in tessellate.edge_polylines_by_body was
    11x on the reference assembly, and here it measured 3.2-3.4x on
    _refacet_clean and 1.66x end-to-end on a 64k-triangle mesh import.

    First() on an EMPTY list raises Standard_NoSuchObject, so the count is
    checked before either accessor is touched. An edge has one or two adjacent
    faces in all but non-manifold geometry, so the drain only happens in the >2
    case. Returns a tuple so callers can iterate it as often as they like for
    free. (tessellate.py carries its own copy — see the note in its version.)"""
    n = lst.Extent()
    if n == 0:
        return ()
    if n == 1:
        return (lst.First(),)
    if n == 2:
        return (lst.First(), lst.Last())
    return tuple(lst)  # non-manifold: rare, and correctness beats the microseconds


class FaceAdjacency:
    """Face-index <-> face, and face -> edge-adjacent faces, for one shape.

    Indices are OCCT's, 1-based and dense over `extent`; they are the currency
    every caller here already used, because they are cheap to put in a set where
    a TopoDS_Face is not. Accepts either a build123d shape or a raw TopoDS_Shape
    (the sewing pass has only the latter).

    Nothing is computed up front but the two maps: `face()` wraps lazily and
    caches, because the callers that region-grow touch every face and the ones
    that walk a ring touch a handful."""

    def __init__(self, shape):
        from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
        from OCP.TopExp import TopExp
        from OCP.TopTools import (
            TopTools_IndexedDataMapOfShapeListOfShape,
            TopTools_IndexedMapOfShape,
        )

        raw = getattr(shape, "wrapped", shape)
        self._fmap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(raw, TopAbs_FACE, self._fmap)
        self._emap = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(raw, TopAbs_EDGE, TopAbs_FACE, self._emap)
        self._wrapped = {}

    @property
    def extent(self):
        """how many faces; valid indices are 1..extent"""
        return self._fmap.Extent()

    def indices(self):
        return range(1, self._fmap.Extent() + 1)

    def key(self, i):
        """the raw TopoDS_Face at index `i`, downcast so OCCT will take it"""
        from OCP.TopoDS import TopoDS

        return TopoDS.Face_s(self._fmap.FindKey(i))

    def face(self, i):
        """the build123d Face at index `i`, wrapped once and kept"""
        f = self._wrapped.get(i)
        if f is None:
            from OCP.TopoDS import TopoDS

            f = Face(TopoDS.Face_s(self._fmap.FindKey(i)))
            self._wrapped[i] = f
        return f

    def index_of(self, face):
        """the index of a face of THIS shape, or 0 when it is not one of them"""
        return self._fmap.FindIndex(getattr(face, "wrapped", face))

    def walk(self, i):
        """yield (other_face_index, shared_edge) over face `i`'s edges.

        The same neighbour comes back once per shared edge, which is what the
        callers that need the edge want; `neighbors` dedupes for the ones that
        don't. A seam edge lists its own face and is skipped."""
        from OCP.TopAbs import TopAbs_EDGE
        from OCP.TopExp import TopExp_Explorer

        exp = TopExp_Explorer(self._fmap.FindKey(i), TopAbs_EDGE)
        while exp.More():
            edge = exp.Current()
            if self._emap.Contains(edge):
                for other in _list_shapes(self._emap.FindFromKey(edge)):
                    j = self._fmap.FindIndex(other)
                    if j != i:
                        yield j, edge
            exp.Next()

    def neighbors(self, i):
        """the set of face indices sharing an edge with face `i`"""
        return {j for j, _ in self.walk(i)}

    def components(self):
        """the edge-connected groups of face indices, as a list of lists.

        Sewing several disjoint bodies yields ONE shell holding several
        unconnected face groups, and building a solid from that is garbage; this
        is how they are told apart again."""
        unvisited = set(self.indices())
        out = []
        while unvisited:
            seed = unvisited.pop()
            group, queue = [seed], [seed]
            while queue:
                for j, _ in self.walk(queue.pop()):
                    if j in unvisited:
                        unvisited.discard(j)
                        group.append(j)
                        queue.append(j)
            out.append(group)
        return out
