// C entry points over planegcs's GCS::System, the native counterpart of the wasm GcsSystem binding FundaCAD 1 used.
#include <cstdint>
#include <vector>

#include "GCS.h"

using namespace GCS;

namespace
{
// All parameters live in one vector sized up front, so their addresses rise with their index. GCS keys maps and
// sets by parameter address, and FundaCAD 1 reset the wasm heap before each solve to get the same ordering.
struct Sys
{
    System gcs;
    std::vector<double> params;
    std::vector<uint8_t> fixed;
};

enum Op : int32_t
{
    P2pCoincident = 0,
    HorizontalL = 1,
    VerticalL = 2,
    Parallel = 3,
    PerpendicularLL = 4,
    EqualLength = 5,
    P2pDistance = 6,
    Difference = 7,
    P2lDistance = 8,
    CircleDiameter = 9,
    CircleRadius = 10,
    ArcRadius = 11,
    TangentLC = 12,
    TangentLA = 13,
    TangentCC = 14,
    TangentCA = 15,
    TangentAA = 16,
    L2lAngleLL = 17,
    EqualRadiusCC = 18,
    EqualRadiusCA = 19,
    EqualRadiusAA = 20,
    PointOnLine = 21,
    PointOnPerpBisector = 22,
    PointOnCircle = 23,
    PointOnArc = 24,
    P2pSymmetricPPL = 25,
    C2cDistance = 26,
    C2lDistance = 27,
    P2cDistance = 28,
    ArcRules = 29,
};

struct Reader
{
    Sys* s;
    const int32_t* idx;
    int32_t n;
    int32_t at = 0;
    bool ok = true;

    double* param()
    {
        if (at >= n) {
            ok = false;
            return nullptr;
        }
        int32_t i = idx[at++];
        if (i < 0 || std::size_t(i) >= s->params.size()) {
            ok = false;
            return nullptr;
        }
        return &s->params[std::size_t(i)];
    }
    Point point()
    {
        double* x = param();
        double* y = param();
        return Point(x, y);
    }
    Line line()
    {
        Line l;
        l.p1 = point();
        l.p2 = point();
        return l;
    }
    Circle circle()
    {
        Circle c;
        c.center = point();
        c.rad = param();
        return c;
    }
    // center, start, end, start angle, end angle, radius
    Arc arc()
    {
        Arc a;
        a.center = point();
        a.start = point();
        a.end = point();
        a.startAngle = param();
        a.endAngle = param();
        a.rad = param();
        return a;
    }
    // A round operand is a circle (3 indices) or an arc (9), planegcs's Arc derives from Circle.
    Circle round(bool isArc)
    {
        if (!isArc) {
            return circle();
        }
        Arc a = arc();
        Circle c;
        c.center = a.center;
        c.rad = a.rad;
        return c;
    }
};

int add(Sys* s, int32_t op, const int32_t* idx, int32_t n, int32_t flags, int32_t tag)
{
    Reader r {s, idx, n};
    System& g = s->gcs;
    bool round1Arc = (flags & 1) != 0;
    bool round2Arc = (flags & 2) != 0;
    switch (op) {
        case P2pCoincident: {
            Point a = r.point(), b = r.point();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintP2PCoincident(a, b, tag);
        }
        case HorizontalL: {
            Line l = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintHorizontal(l, tag);
        }
        case VerticalL: {
            Line l = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintVertical(l, tag);
        }
        case Parallel: {
            Line a = r.line(), b = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintParallel(a, b, tag);
        }
        case PerpendicularLL: {
            Line a = r.line(), b = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintPerpendicular(a, b, tag);
        }
        case EqualLength: {
            Line a = r.line(), b = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintEqualLength(a, b, tag);
        }
        case P2pDistance: {
            Point a = r.point(), b = r.point();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintP2PDistance(a, b, d, tag);
        }
        case Difference: {
            double* a = r.param();
            double* b = r.param();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintDifference(a, b, d, tag);
        }
        case P2lDistance: {
            Point p = r.point();
            Line l = r.line();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintP2LDistance(p, l, d, tag);
        }
        case CircleDiameter: {
            Circle c = r.circle();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintCircleDiameter(c, d, tag);
        }
        case CircleRadius: {
            Circle c = r.circle();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintCircleRadius(c, d, tag);
        }
        case ArcRadius: {
            Arc a = r.arc();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintArcRadius(a, d, tag);
        }
        case TangentLC: {
            Line l = r.line();
            Circle c = r.circle();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintTangent(l, c, tag);
        }
        case TangentLA: {
            Line l = r.line();
            Arc a = r.arc();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintTangent(l, a, tag);
        }
        case TangentCC: {
            Circle a = r.circle(), b = r.circle();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintTangent(a, b, tag);
        }
        case TangentCA: {
            Circle c = r.circle();
            Arc a = r.arc();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintTangent(c, a, tag);
        }
        case TangentAA: {
            Arc a = r.arc(), b = r.arc();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintTangent(a, b, tag);
        }
        case L2lAngleLL: {
            Line a = r.line(), b = r.line();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintL2LAngle(a, b, d, tag);
        }
        case EqualRadiusCC: {
            Circle a = r.circle(), b = r.circle();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintEqualRadius(a, b, tag);
        }
        case EqualRadiusCA: {
            Circle c = r.circle();
            Arc a = r.arc();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintEqualRadius(c, a, tag);
        }
        case EqualRadiusAA: {
            Arc a = r.arc(), b = r.arc();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintEqualRadius(a, b, tag);
        }
        case PointOnLine: {
            Point p = r.point();
            Line l = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintPointOnLine(p, l, tag);
        }
        case PointOnPerpBisector: {
            Point p = r.point();
            Line l = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintPointOnPerpBisector(p, l, tag);
        }
        case PointOnCircle: {
            Point p = r.point();
            Circle c = r.circle();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintPointOnCircle(p, c, tag);
        }
        case PointOnArc: {
            Point p = r.point();
            Arc a = r.arc();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintPointOnArc(p, a, tag);
        }
        case P2pSymmetricPPL: {
            Point a = r.point(), b = r.point();
            Line l = r.line();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintP2PSymmetric(a, b, l, tag);
        }
        case C2cDistance: {
            Circle a = r.round(round1Arc), b = r.round(round2Arc);
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintC2CDistance(a, b, d, tag);
        }
        case C2lDistance: {
            Circle c = r.round(round1Arc);
            Line l = r.line();
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintC2LDistance(c, l, d, tag);
        }
        case P2cDistance: {
            Point p = r.point();
            Circle c = r.round(round1Arc);
            double* d = r.param();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintP2CDistance(p, c, d, tag);
        }
        case ArcRules: {
            Arc a = r.arc();
            if (!r.ok) {
                return -1;
            }
            return g.addConstraintArcRules(a, tag);
        }
        default:
            return -1;
    }
}
}  // namespace

extern "C" {

void* fc_gcs_new(const double* values, const uint8_t* fixed, int32_t n)
{
    try {
        Sys* s = new Sys();
        s->params.assign(values, values + n);
        s->fixed.assign(fixed, fixed + n);
        return s;
    }
    catch (...) {
        return nullptr;
    }
}

void fc_gcs_free(void* h)
{
    delete static_cast<Sys*>(h);
}

// Returns the GCS constraint index, or -1 for bad operands or a C++ exception.
int32_t fc_gcs_add(void* h, int32_t op, const int32_t* idx, int32_t n, int32_t flags, int32_t tag)
{
    try {
        return add(static_cast<Sys*>(h), op, idx, n, flags, tag);
    }
    catch (...) {
        return -1;
    }
}

// The SolveStatus, or -1 when GCS threw.
int32_t fc_gcs_solve(void* h, int32_t algorithm)
{
    Sys* s = static_cast<Sys*>(h);
    try {
        VEC_pD unknowns;
        for (std::size_t i = 0; i < s->params.size(); i++) {
            if (!s->fixed[i]) {
                unknowns.push_back(&s->params[i]);
            }
        }
        return s->gcs.solve(unknowns, true, static_cast<Algorithm>(algorithm));
    }
    catch (...) {
        return -1;
    }
}

void fc_gcs_apply(void* h)
{
    try {
        static_cast<Sys*>(h)->gcs.applySolution();
    }
    catch (...) {
    }
}

int32_t fc_gcs_dof(void* h)
{
    return static_cast<Sys*>(h)->gcs.dofsNumber();
}

void fc_gcs_params(void* h, double* out)
{
    Sys* s = static_cast<Sys*>(h);
    for (std::size_t i = 0; i < s->params.size(); i++) {
        out[i] = s->params[i];
    }
}

// which: 0 conflicting, 1 redundant, 2 partially redundant. Writes at most `cap` tags and returns the full count.
int32_t fc_gcs_tags(void* h, int32_t which, int32_t* out, int32_t cap)
{
    Sys* s = static_cast<Sys*>(h);
    VEC_I tags;
    if (which == 0) {
        s->gcs.getConflicting(tags);
    }
    else if (which == 1) {
        s->gcs.getRedundant(tags);
    }
    else {
        s->gcs.getPartiallyRedundant(tags);
    }
    for (std::size_t i = 0; i < tags.size() && int32_t(i) < cap; i++) {
        out[i] = tags[i];
    }
    return int32_t(tags.size());
}
}
