// Copyright (c) 1995-1999 Matra Datavision
// Copyright (c) 1999-2014 OPEN CASCADE SAS
//
// This file is part of Open CASCADE Technology software library.
//
// This library is free software; you can redistribute it and/or modify it under
// the terms of the GNU Lesser General Public License version 2.1 as published
// by the Free Software Foundation, with special exception defined in the file
// OCCT_LGPL_EXCEPTION.txt. Consult the file LICENSE_LGPL_21.txt included in OCCT
// distribution for complete text of the license and disclaimer of any warranty.
//
// Alternatively, this file may be used under the terms of Open CASCADE
// commercial license or contractual agreement.


#include <Bnd_Box.hxx>
#include <BndLib_Add3dCurve.hxx>
#include <BndLib_AddSurface.hxx>
#include <BRep_Tool.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <Geom_Surface.hxx>
#include <Poly_Polygon3D.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_HArray1OfInteger.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <Adaptor3d_Curve.hxx>
#include <Adaptor3d_Surface.hxx>
#include <BRepTools.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_BezierSurface.hxx>
#include <Bnd_Box2d.hxx>
#include <BndLib_Add2dCurve.hxx>
#include <BRepTopAdaptor_FClass2d.hxx>
#include <ElCLib.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>
#include <gp_XYZ.hxx>
#include <Precision.hxx>
#include <Standard_ErrorHandler.hxx>
#include <Standard_Failure.hxx>
#include <TopAbs_State.hxx>

#include <algorithm>
#include <memory>
#include <utility>
#include <vector>
//
static Standard_Boolean CanUseEdges(const Adaptor3d_Surface& BS);
//
static void FindExactUVBounds(const TopoDS_Face& F, 
                              Standard_Real& umin, Standard_Real& umax, 
                              Standard_Real& vmin, Standard_Real& vmax,
                              const Standard_Real Tol, 
                              Standard_Boolean& isNaturalRestriction);
//
static void AdjustFaceBox(const BRepAdaptor_Surface& BS, 
                          const Standard_Real umin, const Standard_Real umax, 
                          const Standard_Real vmin, const Standard_Real vmax,
                          Bnd_Box& FaceBox,
                          const Bnd_Box& EdgeBox, const Standard_Real Tol);

//
//=======================================================================
//function : Add
//purpose  : Add a shape bounding to a box
//=======================================================================
void BRepBndLib::Add(const TopoDS_Shape& S, Bnd_Box& B, Standard_Boolean useTriangulation)
{
  TopExp_Explorer ex;

  // Add the faces
  BRepAdaptor_Surface BS;
  TopLoc_Location l, aDummyLoc;
  Standard_Integer i, nbNodes;
  BRepAdaptor_Curve BC;

  for (ex.Init(S,TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Face& F = TopoDS::Face(ex.Current());
    const Handle(Poly_Triangulation)& T = BRep_Tool::Triangulation(F, l);
    const Handle(Geom_Surface)& GS = BRep_Tool::Surface (F, aDummyLoc);
    if ((useTriangulation || GS.IsNull()) && !T.IsNull() && T->MinMax (B, l))
    {
      //       B.Enlarge(T->Deflection());
      B.Enlarge (T->Deflection() + BRep_Tool::Tolerance (F));
    } else
    {
      if (!GS.IsNull()) {
        BS.Initialize(F, Standard_False);
        if (BS.GetType() != GeomAbs_Plane) {
          BS.Initialize(F);
          BndLib_AddSurface::Add(BS, BRep_Tool::Tolerance(F), B);
        }
        else {
          // on travaille directement sur les courbes 3d.
          TopExp_Explorer ex2(F, TopAbs_EDGE);
          if (!ex2.More()) {
            BS.Initialize(F);
            BndLib_AddSurface::Add(BS, BRep_Tool::Tolerance(F), B);
          }
          else {
            for (;ex2.More();ex2.Next()) {
              const TopoDS_Edge& anEdge = TopoDS::Edge(ex2.Current());
              if (BRep_Tool::IsGeometric (anEdge))
              {
                BC.Initialize (anEdge);
                BndLib_Add3dCurve::Add (BC, BRep_Tool::Tolerance (anEdge), B);
              }
            }
            B.Enlarge(BRep_Tool::Tolerance(F));
          }
        }
      }
    }
  }

  // Add the edges not in faces
  Handle(TColStd_HArray1OfInteger) HIndices;
  Handle(Poly_PolygonOnTriangulation) Poly;
  Handle(Poly_Triangulation) T;
  for (ex.Init(S,TopAbs_EDGE,TopAbs_FACE); ex.More(); ex.Next())
  {
    const TopoDS_Edge& E = TopoDS::Edge(ex.Current());
 
    if (!useTriangulation && BRep_Tool::IsGeometric(E))
    {
      BC.Initialize(E);
      BndLib_Add3dCurve::Add(BC, BRep_Tool::Tolerance(E), B);
      continue;
    }

    Handle(Poly_Polygon3D) P3d = BRep_Tool::Polygon3D(E, l);
    if (!P3d.IsNull() && P3d->NbNodes() > 0)
    {
      const TColgp_Array1OfPnt& Nodes = P3d->Nodes();
      nbNodes = P3d->NbNodes();
      for (i = 1; i <= nbNodes; i++)
      {
        if (l.IsIdentity()) B.Add(Nodes[i]);
        else B.Add(Nodes[i].Transformed(l));
      }
      //       B.Enlarge(P3d->Deflection());
      B.Enlarge(P3d->Deflection() + BRep_Tool::Tolerance(E));
    }
    else
    {
      BRep_Tool::PolygonOnTriangulation(E, Poly, T, l);
      if (!Poly.IsNull() && !T.IsNull() && T->NbNodes() > 0)
      {
        const TColStd_Array1OfInteger& Indices = Poly->Nodes();
        nbNodes = Indices.Length();
        if (l.IsIdentity())
        {
          for (i = 1; i <= nbNodes; i++)
          {
            B.Add (T->Node (Indices[i]));
          }
        }
        else
        {
          for (i = 1; i <= nbNodes; i++)
          {
            B.Add (T->Node (Indices[i]).Transformed (l));
          }
        }
        // 	B.Enlarge(T->Deflection());
        B.Enlarge(Poly->Deflection() + BRep_Tool::Tolerance(E));
      }
      else {
        if (BRep_Tool::IsGeometric(E))
        {
          BC.Initialize(E);
          BndLib_Add3dCurve::Add(BC, BRep_Tool::Tolerance(E), B);
        }
      }
    }
  }

  // Add the vertices not in edges

  for (ex.Init(S,TopAbs_VERTEX,TopAbs_EDGE); ex.More(); ex.Next()) {
    B.Add(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())));
    B.Enlarge(BRep_Tool::Tolerance(TopoDS::Vertex(ex.Current())));
  }
}



//=======================================================================
//function : AddClose
//purpose  : Add a precise shape bounding to a box
//=======================================================================

void BRepBndLib::AddClose(const TopoDS_Shape& S, Bnd_Box& B)
{
  TopExp_Explorer ex;

  // No faces

  // Add the edges

  BRepAdaptor_Curve BC;

  for (ex.Init(S,TopAbs_EDGE); ex.More(); ex.Next()) {
    const TopoDS_Edge& anEdge = TopoDS::Edge (ex.Current());
    if (BRep_Tool::IsGeometric (anEdge))
    {
      BC.Initialize (anEdge);
      BndLib_Add3dCurve::Add(BC,0.,B);
    }
  }

  // Add the vertices not in edges

  for (ex.Init(S,TopAbs_VERTEX,TopAbs_EDGE); ex.More(); ex.Next()) {
    B.Add(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())));
  }
}

//=======================================================================
//function : AddOptimal
//purpose  : Add a shape bounding to a box
//=======================================================================
void BRepBndLib::AddOptimal(const TopoDS_Shape& S, Bnd_Box& B, 
                            const Standard_Boolean useTriangulation, 
                            const Standard_Boolean useShapeTolerance)
{
  TopExp_Explorer ex;

  // Add the faces
  BRepAdaptor_Surface BS;
  Handle(Poly_Triangulation) T;
  TopLoc_Location l;
  Standard_Integer i, nbNodes;
  BRepAdaptor_Curve BC;

  for (ex.Init(S,TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Face& F = TopoDS::Face(ex.Current());
    T = BRep_Tool::Triangulation(F, l);
    Bnd_Box aLocBox;
    if (useTriangulation && !T.IsNull() && T->MinMax (aLocBox, l))
    {
      //       B.Enlarge(T->Deflection());
      aLocBox.Enlarge(T->Deflection() + BRep_Tool::Tolerance(F));
      Standard_Real xmin, ymin, zmin, xmax, ymax, zmax;
      aLocBox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
      B.Update(xmin, ymin, zmin, xmax, ymax, zmax);
    }
    else
    {
      const Handle(Geom_Surface)& GS = BRep_Tool::Surface(F, l);
      if (!GS.IsNull()) {
        BS.Initialize(F, Standard_False);
        if (CanUseEdges(BS)) {
          TopExp_Explorer ex2(F, TopAbs_EDGE);
          if (!ex2.More()) {
            BS.Initialize(F);
            Standard_Real Tol = useShapeTolerance?  BRep_Tool::Tolerance(F) : 0.;
            BndLib_AddSurface::AddOptimal(BS, Tol, aLocBox);
          }
          else
          {
            Standard_Real Tol;
            for (;ex2.More();ex2.Next()) {
              Bnd_Box anEBox;
              const TopoDS_Edge& anE = TopoDS::Edge(ex2.Current());
              if (BRep_Tool::Degenerated (anE) || !BRep_Tool::IsGeometric (anE))
              {
                continue;
              }
              BC.Initialize(anE);
              Tol = useShapeTolerance?  BRep_Tool::Tolerance(anE) : 0.;
              BndLib_Add3dCurve::AddOptimal(BC, Tol, anEBox);
              aLocBox.Add(anEBox);
            }
          }
        }
        else
        {
          Standard_Real umin, umax, vmin, vmax;
          Standard_Boolean isNaturalRestriction = Standard_False;
          Standard_Real Tol = useShapeTolerance?  BRep_Tool::Tolerance(F) : 0.;
          FindExactUVBounds(F, umin, umax, vmin, vmax, Tol, isNaturalRestriction);
          BndLib_AddSurface::AddOptimal(BS, umin, umax, vmin, vmax, 
                                        Tol, aLocBox);
          //
          if(!isNaturalRestriction)
          {
            TopExp_Explorer ex2(F, TopAbs_EDGE);
            Bnd_Box EBox;
            for (;ex2.More();ex2.Next()) {
              Bnd_Box anEBox;
              const TopoDS_Edge& anE = TopoDS::Edge(ex2.Current());
              if (BRep_Tool::Degenerated (anE) || !BRep_Tool::IsGeometric (anE))
              {
                continue;
              }
              BC.Initialize(anE);
              Tol = useShapeTolerance?  BRep_Tool::Tolerance(anE) : 0.;
              BndLib_Add3dCurve::AddOptimal(BC, Tol, anEBox);
              EBox.Add(anEBox);
            }
            Tol = useShapeTolerance?  BRep_Tool::Tolerance(F) : 0.;
            AdjustFaceBox(BS, umin, umax, vmin, vmax, aLocBox, EBox, 
                          Tol);
          }
        }

        if (!aLocBox.IsVoid())
        {
          Standard_Real xmin, ymin, zmin, xmax, ymax, zmax;
          aLocBox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
          B.Update(xmin, ymin, zmin, xmax, ymax, zmax);
        }
      }
    }
  }

  // Add the edges not in faces
  Handle(TColStd_HArray1OfInteger) HIndices;
  Handle(Poly_PolygonOnTriangulation) Poly;

  for (ex.Init(S,TopAbs_EDGE,TopAbs_FACE); ex.More(); ex.Next())
  {
    const TopoDS_Edge& E = TopoDS::Edge(ex.Current());
    Bnd_Box aLocBox;
    Handle(Poly_Polygon3D) P3d = BRep_Tool::Polygon3D(E, l);
    if (useTriangulation && !P3d.IsNull() && P3d->NbNodes() > 0)
    {
      const TColgp_Array1OfPnt& Nodes = P3d->Nodes();
      nbNodes = P3d->NbNodes();
      for (i = 1; i <= nbNodes; i++)
      {
        if (l.IsIdentity()) aLocBox.Add(Nodes[i]);
        else aLocBox.Add(Nodes[i].Transformed(l));
      }
      Standard_Real Tol = useShapeTolerance?  BRep_Tool::Tolerance(E) : 0.;
      aLocBox.Enlarge(P3d->Deflection() + Tol);
    }
    else
    {
      BRep_Tool::PolygonOnTriangulation(E, Poly, T, l);
      if (useTriangulation && !Poly.IsNull() && !T.IsNull() && T->NbNodes() > 0)
      {
        const TColStd_Array1OfInteger& Indices = Poly->Nodes();
        nbNodes = Indices.Length();
        for (i = 1; i <= nbNodes; i++)
        {
          if (l.IsIdentity())
          {
            aLocBox.Add (T->Node (Indices[i]));
          }
          else
          {
            aLocBox.Add (T->Node (Indices[i]).Transformed (l));
          }
        }
        Standard_Real Tol = useShapeTolerance?  BRep_Tool::Tolerance(E) : 0.;
        aLocBox.Enlarge(Poly->Deflection() + Tol);
      }
      else {
        if (BRep_Tool::IsGeometric(E))
        {
          BC.Initialize(E);
          Standard_Real Tol = useShapeTolerance?  BRep_Tool::Tolerance(E) : 0.;
          BndLib_Add3dCurve::AddOptimal(BC, Tol, aLocBox);
        }
      }
    }
    if (!aLocBox.IsVoid())
    {
      Standard_Real xmin, ymin, zmin, xmax, ymax, zmax;
      aLocBox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
      B.Update(xmin, ymin, zmin, xmax, ymax, zmax);
    }
  }

  // Add the vertices not in edges

  for (ex.Init(S,TopAbs_VERTEX,TopAbs_EDGE); ex.More(); ex.Next()) {
    Bnd_Box aLocBox;
    const TopoDS_Vertex& aV = TopoDS::Vertex(ex.Current());
    aLocBox.Add(BRep_Tool::Pnt(aV));
    Standard_Real Tol = useShapeTolerance?  BRep_Tool::Tolerance(aV) : 0.;
    aLocBox.Enlarge(Tol);
    Standard_Real xmin, ymin, zmin, xmax, ymax, zmax;
    aLocBox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    B.Update(xmin, ymin, zmin, xmax, ymax, zmax);
  }
}

//=======================================================================
//function : CanUseEdges
//purpose  : Define is it possible using only edges bnd boxes 
//           to get face bnd box
//=======================================================================
Standard_Boolean CanUseEdges(const Adaptor3d_Surface& BS)
{
  GeomAbs_SurfaceType aST = BS.GetType();
  if(aST == GeomAbs_Plane ||
     aST == GeomAbs_Cylinder ||
     aST == GeomAbs_Cone ||
     aST == GeomAbs_SurfaceOfExtrusion)
  {
    return Standard_True;
  }
  else if(aST == GeomAbs_SurfaceOfRevolution)
  {
    const Handle(Adaptor3d_Curve)& aBC = BS.BasisCurve();
    if(aBC->GetType() == GeomAbs_Line)
    {
      return Standard_True;
    }
    else
    {
      return Standard_False;
    }
  }
  else if(aST == GeomAbs_OffsetSurface)
  {
    const Handle(Adaptor3d_Surface)& aS = BS.BasisSurface();
    return CanUseEdges (*aS);
  }
  else if(aST == GeomAbs_BSplineSurface)
  {
    Handle(Geom_BSplineSurface) aBSpl = BS.BSpline();
    if((aBSpl->UDegree() == 1 && aBSpl->NbUKnots() == 2) ||
       (aBSpl->VDegree() == 1 && aBSpl->NbVKnots() == 2))
    {
      return Standard_True;
    }
    else
    {
      return Standard_False;
    }
  }
  else if(aST == GeomAbs_BezierSurface)
  {
    Handle(Geom_BezierSurface) aBz = BS.Bezier();
    if((aBz->UDegree() == 1 ) ||
       (aBz->VDegree() == 1 ))
    {
      return Standard_True;
    }
    else
    {
      return Standard_False;
    }
  }
  return Standard_False;
}

//=======================================================================
//function : FindExactUVBounds
//purpose  : 
//=======================================================================
void FindExactUVBounds(const TopoDS_Face& FF, 
                       Standard_Real& umin, Standard_Real& umax, 
                       Standard_Real& vmin, Standard_Real& vmax,
                       const Standard_Real Tol, 
                       Standard_Boolean& isNaturalRestriction)
{
  TopoDS_Face F = FF;
  F.Orientation(TopAbs_FORWARD);
  TopExp_Explorer ex(F,TopAbs_EDGE);
  //
  //Check Natural restriction
  isNaturalRestriction = BRep_Tool::NaturalRestriction(F); //Can we trust this flag?
  BRepAdaptor_Surface aBAS(F, Standard_False);
  if(!isNaturalRestriction)
  {
    //Check by comparing pcurves and surface boundaries
    umin = aBAS.FirstUParameter();
    umax = aBAS.LastUParameter();
    vmin = aBAS.FirstVParameter();
    vmax = aBAS.LastVParameter();
    Standard_Boolean isUperiodic = aBAS.IsUPeriodic(), isVperiodic = aBAS.IsVPeriodic();
    Standard_Real aT1, aT2;
    Standard_Real TolU = Max(aBAS.UResolution(Tol), Precision::PConfusion());
    Standard_Real TolV = Max(aBAS.VResolution(Tol), Precision::PConfusion());
    Standard_Integer Nu = 0, Nv = 0, NbEdges = 0;
    gp_Vec2d Du(1, 0), Dv(0, 1);
    gp_Pnt2d aP;
    gp_Vec2d aV;
    for (;ex.More();ex.Next()) {
      NbEdges++;
      if(NbEdges > 4)
      {
        break;
      }
      const TopoDS_Edge& aE = TopoDS::Edge(ex.Current());
      const Handle(Geom2d_Curve) aC2D = BRep_Tool::CurveOnSurface(aE, F, aT1, aT2);
      if (aC2D.IsNull()) 
      {
        break;
      }
      //
      aC2D->D1((aT1 + aT2)/2., aP, aV);
      Standard_Real magn = aV.SquareMagnitude();
      if(magn < gp::Resolution())
      {
        break;
      }
      else
      {
        aV /= Sqrt(magn);
      }
      Standard_Real u = aP.X(), v = aP.Y();
      if(isUperiodic)
      {
        ElCLib::InPeriod(u, umin, umax);
      }
      if(isVperiodic)
      {
        ElCLib::InPeriod(v, vmin, vmax);
      }
      //
      if(Abs(u - umin) <= TolU || Abs(u - umax) <= TolU)
      {
        Standard_Real d = Dv * aV;
        if(1. - Abs(d) <= Precision::PConfusion())
        {
          Nu++;
          if(Nu > 2)
          {
            break;
          }
        }
        else
        {
          break;
        }
      }
      else if(Abs(v - vmin) <= TolV || Abs(v - vmax) <= TolV)
      {
        Standard_Real d = Du * aV;
        if(1. - Abs(d) <= Precision::PConfusion())
        {
          Nv++;
          if(Nv > 2)
          {
            break;
          }
        }
        else
        {
          break;
        }
      }
      else
      {
        break;
      }
    }
    if(Nu == 2 && Nv == 2)
    {
      isNaturalRestriction = Standard_True;
    }
  }
  //
  if(isNaturalRestriction)
  {
    umin = aBAS.FirstUParameter();
    umax = aBAS.LastUParameter();
    vmin = aBAS.FirstVParameter();
    vmax = aBAS.LastVParameter();
    return;
  }

  // fill box for the given face
  Standard_Real aT1, aT2;
  Standard_Real TolU = Max(aBAS.UResolution(Tol), Precision::PConfusion());
  Standard_Real TolV = Max(aBAS.VResolution(Tol), Precision::PConfusion());
  Standard_Real TolUV = Max(TolU, TolV);
  Bnd_Box2d aBox;
  ex.Init(F,TopAbs_EDGE);
  for (;ex.More();ex.Next()) {
    const TopoDS_Edge& aE = TopoDS::Edge(ex.Current());
    const Handle(Geom2d_Curve) aC2D = BRep_Tool::CurveOnSurface(aE, F, aT1, aT2);
    if (aC2D.IsNull()) 
    {
      continue;
    }
    //
    BndLib_Add2dCurve::AddOptimal(aC2D, aT1, aT2, TolUV, aBox);
    //
  }
  //
  aBox.Get(umin, vmin, umax, vmax);
  //
  TopLoc_Location aLoc;
  Handle(Geom_Surface) aS = BRep_Tool::Surface(FF, aLoc);
  Standard_Real aUmin, aUmax, aVmin, aVmax;
  aS->Bounds(aUmin, aUmax, aVmin, aVmax);
  if(!aS->IsUPeriodic())
  {
    umin = Max(aUmin, umin);
    umax = Min(aUmax, umax);
  }
  else
  {
    if(umax - umin > aS->UPeriod())
    {
      Standard_Real delta = umax - umin - aS->UPeriod();
      umin += delta/2.;
      umax -= delta/2;
    }
  }
  //
  if(!aS->IsVPeriodic())
  {
    vmin = Max(aVmin, vmin);
    vmax = Min(aVmax, vmax);
  }
  else
  {
    if(vmax - vmin > aS->VPeriod())
    {
      Standard_Real delta = vmax - vmin - aS->VPeriod();
      vmin += delta/2.;
      vmax -= delta/2;
    }
  }
}
// FundaCAD: the surface box handed to AdjustFaceBox is taken over the UV
// rectangle of the face, and where a trim crosses the iso-lines that rectangle
// also holds the surface left beyond the trim. The original test kept a side
// of that box whenever the stationary point nearest to it lay in the face,
// however far from the side that point was, so a face cut off askew was boxed
// together with the surface outside it.
//
// Every edge of the face is within the edge box, so a part of the surface
// that rises past an edge box side is either all in the face or all outside
// it, and one classified point settles it. TrimmedExtent samples the
// rectangle, climbs from the sampled tops to the tops of the surface, and
// classifies those, highest first.
namespace
{
class TrimmedExtent
{
public:
  TrimmedExtent(const BRepAdaptor_Surface& theBS,
                const Standard_Real theUMin, const Standard_Real theUMax,
                const Standard_Real theVMin, const Standard_Real theVMax,
                const Standard_Real theTol)
  : myBS(theBS),
    myUMin(theUMin), myUMax(theUMax), myVMin(theVMin), myVMax(theVMax),
    myEps(Max(theTol, Precision::Confusion())),
    myTol(theTol), myNbU(0), myNbV(0), myDU(0.), myDV(0.)
  {
  }

  //! How far the face reaches along theSign times the coordinate theCoord
  //! (1, 2 or 3), given how far its edges and its surface over the whole UV
  //! rectangle do. False leaves the surface box side as it is.
  Standard_Boolean Side(const Standard_Integer theCoord, const Standard_Real theSign,
                        const Standard_Real theEdge, const Standard_Real theSurf,
                        Standard_Real& theSide);

private:
  struct Top
  {
    Standard_Real    Height; // of the sample
    Standard_Real    Reach;  // the surface around the sample is taken to stay below this
    Standard_Integer I, J;
  };

  Standard_Boolean Sample();
  Standard_Real    Climb(const Top& theTop, const Standard_Integer theCoord,
                         const Standard_Real theSign, gp_Pnt2d& theUV) const;
  Standard_Boolean IsInside(const gp_Pnt2d& theUV);

  Standard_Real Height(const Standard_Integer i, const Standard_Integer j,
                       const Standard_Integer theCoord, const Standard_Real theSign) const
  {
    return theSign * myPnts[i * (myNbV + 1) + j].Coord(theCoord);
  }

  static Standard_Integer NbCells(const BRepAdaptor_Surface& theBS, const Standard_Boolean isU,
                                  const Standard_Real theFirst, const Standard_Real theLast);

  const BRepAdaptor_Surface&               myBS;
  Standard_Real                            myUMin, myUMax, myVMin, myVMax;
  Standard_Real                            myEps, myTol;
  Standard_Integer                         myNbU, myNbV;
  Standard_Real                            myDU, myDV;
  std::vector<gp_XYZ>                      myPnts;
  std::unique_ptr<BRepTopAdaptor_FClass2d> myClass;
};

//=======================================================================
//function : NbCells
//purpose  : about the density BndLib_AddSurface samples a surface at
//=======================================================================
Standard_Integer TrimmedExtent::NbCells(const BRepAdaptor_Surface& theBS, const Standard_Boolean isU,
                                        const Standard_Real theFirst, const Standard_Real theLast)
{
  Standard_Integer aNb = 32;
  Standard_Real aPart = 1.;
  switch (theBS.GetType())
  {
    case GeomAbs_BezierSurface:
    {
      aNb = 2 * (isU ? theBS.NbUPoles() : theBS.NbVPoles());
      aPart = theLast - theFirst;
      break;
    }
    case GeomAbs_BSplineSurface:
    {
      const Handle(Geom_BSplineSurface) aBSpl = theBS.BSpline();
      Standard_Real aU1, aU2, aV1, aV2;
      aBSpl->Bounds(aU1, aU2, aV1, aV2);
      aNb = isU ? 2 * (aBSpl->UDegree() + 1) * (aBSpl->NbUKnots() - 1)
                : 2 * (aBSpl->VDegree() + 1) * (aBSpl->NbVKnots() - 1);
      aPart = (theLast - theFirst) / (isU ? aU2 - aU1 : aV2 - aV1);
      break;
    }
    default:
      break;
  }
  if (aPart < 0.9)
  {
    aNb = RealToInt(aPart * aNb) + 1;
  }
  return Max(8, Min(64, aNb));
}

//=======================================================================
//function : Sample
//purpose  :
//=======================================================================
Standard_Boolean TrimmedExtent::Sample()
{
  if (!myPnts.empty())
  {
    return Standard_True;
  }
  if (Precision::IsInfinite(myUMin) || Precision::IsInfinite(myUMax) ||
      Precision::IsInfinite(myVMin) || Precision::IsInfinite(myVMax) ||
      !(myUMax > myUMin) || !(myVMax > myVMin))
  {
    return Standard_False;
  }
  myNbU = NbCells(myBS, Standard_True, myUMin, myUMax);
  myNbV = NbCells(myBS, Standard_False, myVMin, myVMax);
  myDU = (myUMax - myUMin) / myNbU;
  myDV = (myVMax - myVMin) / myNbV;
  myPnts.reserve((myNbU + 1) * (myNbV + 1));
  for (Standard_Integer i = 0; i <= myNbU; ++i)
  {
    for (Standard_Integer j = 0; j <= myNbV; ++j)
    {
      myPnts.push_back(myBS.Value(myUMin + myDU * i, myVMin + myDV * j).XYZ());
    }
  }
  return Standard_True;
}

//=======================================================================
//function : IsInside
//purpose  :
//=======================================================================
Standard_Boolean TrimmedExtent::IsInside(const gp_Pnt2d& theUV)
{
  if (!myClass)
  {
    const Standard_Real aTolU = Max(myBS.UResolution(myTol), Precision::PConfusion());
    const Standard_Real aTolV = Max(myBS.VResolution(myTol), Precision::PConfusion());
    myClass.reset(new BRepTopAdaptor_FClass2d(myBS.Face(), Max(aTolU, aTolV)));
  }
  return myClass->Perform(theUV) != TopAbs_OUT;
}

//=======================================================================
//function : Climb
//purpose  : Newton up the coordinate from a sample, held to the two
//           cells around it either way. Only steps that gain height
//           are taken, so the result is a point of the surface no
//           lower than the sample.
//=======================================================================
Standard_Real TrimmedExtent::Climb(const Top& theTop, const Standard_Integer theCoord,
                                   const Standard_Real theSign, gp_Pnt2d& theUV) const
{
  const Standard_Real aCell[2] = {myDU, myDV};
  const Standard_Real aLow[2] = {Max(myUMin, myUMin + myDU * (theTop.I - 2)),
                                 Max(myVMin, myVMin + myDV * (theTop.J - 2))};
  const Standard_Real anUpp[2] = {Min(myUMax, myUMin + myDU * (theTop.I + 2)),
                                  Min(myVMax, myVMin + myDV * (theTop.J + 2))};
  Standard_Real aX[2] = {myUMin + myDU * theTop.I, myVMin + myDV * theTop.J};
  Standard_Real aHeight = theTop.Height;
  for (Standard_Integer anIter = 0; anIter < 30; ++anIter)
  {
    gp_Pnt aP;
    gp_Vec aD1U, aD1V, aD2U, aD2V, aD2UV;
    try
    {
      OCC_CATCH_SIGNALS
      myBS.D2(aX[0], aX[1], aP, aD1U, aD1V, aD2U, aD2V, aD2UV);
    }
    catch (Standard_Failure const&)
    {
      break;
    }
    const Standard_Real aG[2] = {theSign * aD1U.Coord(theCoord), theSign * aD1V.Coord(theCoord)};
    const Standard_Real aHuu = theSign * aD2U.Coord(theCoord);
    const Standard_Real aHuv = theSign * aD2UV.Coord(theCoord);
    const Standard_Real aHvv = theSign * aD2V.Coord(theCoord);
    // A parameter at a bound the slope pushes it against stays there.
    Standard_Boolean isFree[2];
    for (Standard_Integer k = 0; k < 2; ++k)
    {
      isFree[k] = !((aX[k] <= aLow[k] && aG[k] < 0.) || (aX[k] >= anUpp[k] && aG[k] > 0.));
    }
    if (!isFree[0] && !isFree[1])
    {
      break;
    }
    Standard_Real aStep[2] = {0., 0.};
    Standard_Boolean hasTop = Standard_False;
    if (isFree[0] && isFree[1])
    {
      const Standard_Real aDet = aHuu * aHvv - aHuv * aHuv;
      if (aHuu < 0. && aDet > 0.)
      {
        aStep[0] = -(aHvv * aG[0] - aHuv * aG[1]) / aDet;
        aStep[1] = -(aHuu * aG[1] - aHuv * aG[0]) / aDet;
        hasTop = Standard_True;
      }
    }
    else if (isFree[0] ? aHuu < 0. : aHvv < 0.)
    {
      const Standard_Integer k = isFree[0] ? 0 : 1;
      aStep[k] = -aG[k] / (k == 0 ? aHuu : aHvv);
      hasTop = Standard_True;
    }
    if (!hasTop)
    {
      // No top in the quadratic model: one cell up the slope.
      const Standard_Real aSlope = Max(isFree[0] ? Abs(aG[0]) * aCell[0] : 0.,
                                       isFree[1] ? Abs(aG[1]) * aCell[1] : 0.);
      if (aSlope <= 0.)
      {
        break;
      }
      for (Standard_Integer k = 0; k < 2; ++k)
      {
        aStep[k] = isFree[k] ? aG[k] * aCell[k] * aCell[k] / aSlope : 0.;
      }
    }
    if (Max(Abs(aStep[0]) / aCell[0], Abs(aStep[1]) / aCell[1]) < 1.e-9)
    {
      break;
    }
    Standard_Real aMoved = 0.;
    for (Standard_Integer aTry = 0; aTry < 20; ++aTry)
    {
      const Standard_Real aY[2] = {Min(Max(aX[0] + aStep[0], aLow[0]), anUpp[0]),
                                   Min(Max(aX[1] + aStep[1], aLow[1]), anUpp[1])};
      if (aY[0] == aX[0] && aY[1] == aX[1])
      {
        break;
      }
      const Standard_Real aNew = theSign * myBS.Value(aY[0], aY[1]).Coord(theCoord);
      if (aNew > aHeight)
      {
        aMoved = Max(Abs(aY[0] - aX[0]) / aCell[0], Abs(aY[1] - aX[1]) / aCell[1]);
        aX[0] = aY[0];
        aX[1] = aY[1];
        aHeight = aNew;
        break;
      }
      aStep[0] *= 0.5;
      aStep[1] *= 0.5;
    }
    if (aMoved < 1.e-9)
    {
      break;
    }
  }
  theUV.SetCoord(aX[0], aX[1]);
  return aHeight;
}

//=======================================================================
//function : Side
//purpose  :
//=======================================================================
Standard_Boolean TrimmedExtent::Side(const Standard_Integer theCoord, const Standard_Real theSign,
                                     const Standard_Real theEdge, const Standard_Real theSurf,
                                     Standard_Real& theSide)
{
  // The surface box is enlarged by myEps, so this close it adds nothing.
  if (theSurf - theEdge <= 2. * myEps)
  {
    theSide = theEdge;
    return Standard_True;
  }
  if (!Sample())
  {
    return Standard_False;
  }

  std::vector<Top> aTops;
  for (Standard_Integer i = 0; i <= myNbU; ++i)
  {
    for (Standard_Integer j = 0; j <= myNbV; ++j)
    {
      const Standard_Real aH = Height(i, j, theCoord, theSign);
      Standard_Real aLowest = aH;
      Standard_Boolean isTop = Standard_True;
      for (Standard_Integer ii = Max(0, i - 1); ii <= Min(myNbU, i + 1) && isTop; ++ii)
      {
        for (Standard_Integer jj = Max(0, j - 1); jj <= Min(myNbV, j + 1); ++jj)
        {
          const Standard_Real aN = Height(ii, jj, theCoord, theSign);
          // Of equal neighbours only the first is a top.
          if (aN > aH || (aN == aH && (ii < i || (ii == i && jj < j))))
          {
            isTop = Standard_False;
            break;
          }
          aLowest = Min(aLowest, aN);
        }
      }
      if (isTop)
      {
        const Top aTop = {aH, aH + (aH - aLowest), i, j};
        aTops.push_back(aTop);
      }
    }
  }
  std::sort(aTops.begin(), aTops.end(), [](const Top& a, const Top& b) {
    return a.Height != b.Height ? a.Height > b.Height : (a.I != b.I ? a.I < b.I : a.J < b.J);
  });

  // 0 not known yet, 1 in the face, 2 outside it
  std::vector<char> aState(myPnts.size(), 0);
  std::vector<std::pair<Standard_Integer, Standard_Integer> > aStack;
  // A classified sample above the edges speaks for all it is joined to by
  // samples above the edges.
  auto aSpread = [&](const Standard_Integer i0, const Standard_Integer j0, const char theState) {
    aStack.clear();
    aStack.push_back(std::make_pair(i0, j0));
    aState[i0 * (myNbV + 1) + j0] = theState;
    while (!aStack.empty())
    {
      const std::pair<Standard_Integer, Standard_Integer> aCur = aStack.back();
      aStack.pop_back();
      for (Standard_Integer ii = Max(0, aCur.first - 1); ii <= Min(myNbU, aCur.first + 1); ++ii)
      {
        for (Standard_Integer jj = Max(0, aCur.second - 1); jj <= Min(myNbV, aCur.second + 1); ++jj)
        {
          char& aSt = aState[ii * (myNbV + 1) + jj];
          if (aSt == 0 && Height(ii, jj, theCoord, theSign) > theEdge + myEps)
          {
            aSt = theState;
            aStack.push_back(std::make_pair(ii, jj));
          }
        }
      }
    }
  };

  // A classification costs milliseconds on a face with a poor outline, and a
  // surface with more tops than this is left its surface box side.
  const Standard_Integer aMaxClimbs = 32, aMaxClassified = 12;
  Standard_Integer aNbClimbs = 0, aNbClassified = 0;
  // The highest point found in the face so far.
  Standard_Real aBest = theEdge;
  // Whether the search came upon the point the surface box side is taken
  // from. Until it has, it cannot tell whether that point is in the face.
  Standard_Boolean isReached = Standard_False;
  for (size_t n = 0; n < aTops.size(); ++n)
  {
    const Top& aTop = aTops[n];
    if (n > 0 && aTop.Reach <= aBest + myEps)
    {
      continue;
    }
    char aSt = aState[aTop.I * (myNbV + 1) + aTop.J];
    if (aSt == 2)
    {
      continue;
    }
    if (aNbClimbs == aMaxClimbs)
    {
      return Standard_False;
    }
    ++aNbClimbs;
    gp_Pnt2d aUV;
    const Standard_Real aH = Climb(aTop, theCoord, theSign, aUV);
    if (aH >= theSurf - 2. * myEps)
    {
      isReached = Standard_True;
    }
    if (aH <= aBest + myEps)
    {
      continue;
    }
    if (aSt == 0)
    {
      if (aNbClassified == aMaxClassified)
      {
        return Standard_False;
      }
      ++aNbClassified;
      aSt = IsInside(aUV) ? 1 : 2;
      if (aTop.Height > theEdge + myEps)
      {
        aSpread(aTop.I, aTop.J, aSt);
      }
    }
    if (aSt == 1)
    {
      aBest = aH;
    }
  }
  if (!isReached)
  {
    return Standard_False;
  }
  if (aBest >= theSurf - 2. * myEps)
  {
    theSide = Max(theSurf, aBest);
  }
  else if (aBest > theEdge)
  {
    theSide = Min(theSurf, aBest + myEps);
  }
  else
  {
    theSide = theEdge;
  }
  return Standard_True;
}
} // namespace

//=======================================================================
//function : AdjustFaceBox
//purpose  :
//=======================================================================
void AdjustFaceBox(const BRepAdaptor_Surface& BS,
                   const Standard_Real umin, const Standard_Real umax,
                   const Standard_Real vmin, const Standard_Real vmax,
                   Bnd_Box& FaceBox,
                   const Bnd_Box& EdgeBox, const Standard_Real Tol)
{
  if (EdgeBox.IsVoid())
  {
    return;
  }
  if (FaceBox.IsVoid())
  {
    FaceBox = EdgeBox;
    return;
  }

  // xmin, ymin, zmin, xmax, ymax, zmax
  Standard_Real aFace[6], anEdge[6];
  FaceBox.Get(aFace[0], aFace[1], aFace[2], aFace[3], aFace[4], aFace[5]);
  EdgeBox.Get(anEdge[0], anEdge[1], anEdge[2], anEdge[3], anEdge[4], anEdge[5]);
  //
  TrimmedExtent aTrimmed(BS, umin, umax, vmin, vmax, Tol);
  Standard_Boolean isModified = Standard_False;
  for (Standard_Integer k = 0; k < 6; ++k)
  {
    // Both as heights along the way out of this side.
    const Standard_Real aSign = k < 3 ? -1. : 1.;
    const Standard_Real aSurf = aSign * aFace[k];
    Standard_Real aSide = aSurf;
    if (aSign * anEdge[k] < aSurf
     && aTrimmed.Side(k % 3 + 1, aSign, aSign * anEdge[k], aSurf, aSide)
     && aSide != aSurf)
    {
      aFace[k] = aSign * aSide;
      isModified = Standard_True;
    }
  }
  //
  if(isModified)
  {
    FaceBox.SetVoid();
    FaceBox.Update(aFace[0], aFace[1], aFace[2], aFace[3], aFace[4], aFace[5]);
  }
}
