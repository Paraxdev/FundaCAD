#pragma once
// XCAF documents for STEP: a writer that labels shapes with product names and
// colours (the Python engine reached it through build123d's `_create_xde` and
// `export_step`), and a reader that walks the product tree with names, colours
// and placements (the Python engine's `step_assembly.py` `read_assembly`).

#include "rust/cxx.h"
#include <APIHeaderSection_MakeHeader.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_Printer.hxx>
#include <Quantity_Color.hxx>
#include <Quantity_ColorRGBA.hxx>
#include <STEPCAFControl_Controller.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPControl_Controller.hxx>
#include <STEPControl_StepModelType.hxx>
#include <StepData_StepModel.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TCollection_HAsciiString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopAbs.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_ColorType.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XSControl_WorkSession.hxx>
#include <bindings_common.hxx>
#include <cmath>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

inline TDF_Label xcaf_referred(const TDF_Label &label) {
  if (!label.IsNull() && XCAFDoc_ShapeTool::IsReference(label)) {
    TDF_Label referred;
    if (XCAFDoc_ShapeTool::GetReferredShape(label, referred) && !referred.IsNull()) {
      return referred;
    }
  }
  return label;
}

inline void xcaf_quiet_messages() {
  const Message_SequenceOfPrinters &printers = Message::DefaultMessenger()->Printers();
  for (Message_SequenceOfPrinters::Iterator it(printers); it.More(); it.Next()) {
    it.Value()->SetTraceLevel(Message_Fail);
  }
}

class XcafStepWriter {
public:
  Handle(XCAFApp_Application) app;
  Handle(TDocStd_Document) doc;
  Handle(XCAFDoc_ShapeTool) shapes;
  Handle(XCAFDoc_ColorTool) colors;
  std::vector<TDF_Label> labels;

  XcafStepWriter() {
    app = XCAFApp_Application::GetApplication();
    app->NewDocument(TCollection_ExtendedString("MDTV-XCAF"), doc);
    XCAFDoc_DocumentTool::SetLengthUnit(doc, 0.001);
    shapes = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    colors = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    XCAFDoc_ShapeTool::SetAutoNaming(true);
  }

  ~XcafStepWriter() {
    if (!doc.IsNull() && doc->IsOpened()) {
      app->Close(doc);
    }
  }
};

inline std::unique_ptr<XcafStepWriter> xcaf_step_writer_new() {
  return std::unique_ptr<XcafStepWriter>(new XcafStepWriter());
}

// A root when `parent` is negative, else a component of node `parent`. The
// name and colour go on the instance label and on the product it refers to,
// which is what keeps a STEP PRODUCT name. Returns the node index or -1.
inline int32_t xcaf_step_writer_add(XcafStepWriter &w, const TopoDS_Shape &shape, int32_t parent,
                                    rust::Str name, bool has_color, double r, double g, double b) {
  TDF_Label label;
  if (parent < 0) {
    label = w.shapes->AddShape(shape, false);
  } else {
    if (static_cast<size_t>(parent) >= w.labels.size()) {
      return -1;
    }
    TDF_Label owner = xcaf_referred(w.labels[parent]);
    if (owner.IsNull()) {
      return -1;
    }
    label = w.shapes->AddComponent(owner, shape);
  }
  if (label.IsNull()) {
    return -1;
  }
  w.labels.push_back(label);
  TDF_Label referred = xcaf_referred(label);
  if (name.size() > 0) {
    TCollection_ExtendedString text(std::string(name.data(), name.size()).c_str(), true);
    TDataStd_Name::Set(label, text);
    if (referred != label) {
      TDataStd_Name::Set(referred, text);
    }
  }
  if (has_color) {
    Quantity_Color color(r, g, b, Quantity_TOC_sRGB);
    w.colors->SetColor(label, color, XCAFDoc_ColorGen);
    if (referred != label) {
      w.colors->SetColor(referred, color, XCAFDoc_ColorGen);
    }
  }
  return static_cast<int32_t>(w.labels.size() - 1);
}

inline void xcaf_step_writer_write(XcafStepWriter &w, rust::Str header_name, rust::Str path) {
  w.shapes->UpdateAssemblies();
  xcaf_quiet_messages();
  Handle(XSControl_WorkSession) session = new XSControl_WorkSession();
  STEPCAFControl_Writer writer(session, false);
  writer.SetColorMode(true);
  writer.SetLayerMode(true);
  writer.SetNameMode(true);
  Handle(StepData_StepModel) model = writer.ChangeWriter().Model();
  APIHeaderSection_MakeHeader header(model);
  if (!header.IsDone()) {
    header = APIHeaderSection_MakeHeader(0);
    header.Apply(model);
  }
  if (header_name.size() > 0) {
    header.SetName(new TCollection_HAsciiString(std::string(header_name.data(), header_name.size()).c_str()));
  }
  header.SetOriginatingSystem(new TCollection_HAsciiString("FundaCAD"));
  STEPCAFControl_Controller::Init();
  STEPControl_Controller::Init();
  Interface_Static::SetIVal("write.surfacecurve.mode", 1);
  Interface_Static::SetIVal("write.precision.mode", 0);
  if (!writer.Transfer(w.doc, STEPControl_AsIs)) {
    throw std::runtime_error("the shapes could not be transferred to the STEP writer");
  }
  std::string file(path.data(), path.size());
  if (writer.Write(file.c_str()) != IFSelect_RetDone) {
    throw std::runtime_error("Failed to write STEP file");
  }
}

// -1 for no colour, else 0xRRGGBB in sRGB, rounded half to even as Python does.
inline int32_t xcaf_pack_srgb(const Quantity_ColorRGBA &rgba) {
  const Quantity_Color &linear = rgba.GetRGB();
  int32_t out = 0;
  for (double v : {linear.Red(), linear.Green(), linear.Blue()}) {
    double s = std::nearbyint(Quantity_Color::Convert_LinearRGB_To_sRGB(v) * 255.0);
    int32_t c = static_cast<int32_t>(s < 0.0 ? 0.0 : (s > 255.0 ? 255.0 : s));
    out = (out << 8) | c;
  }
  return out;
}

inline int32_t xcaf_label_color(const TDF_Label &label) {
  Quantity_ColorRGBA rgba;
  for (XCAFDoc_ColorType kind : {XCAFDoc_ColorSurf, XCAFDoc_ColorGen, XCAFDoc_ColorCurv}) {
    if (XCAFDoc_ColorTool::GetColor(label, kind, rgba)) {
      return xcaf_pack_srgb(rgba);
    }
  }
  return -1;
}

inline int32_t xcaf_shape_color(const Handle(XCAFDoc_ColorTool) &tool, const TopoDS_Shape &shape) {
  Quantity_ColorRGBA rgba;
  for (XCAFDoc_ColorType kind : {XCAFDoc_ColorSurf, XCAFDoc_ColorGen, XCAFDoc_ColorCurv}) {
    if (tool->GetColor(shape, kind, rgba)) {
      return xcaf_pack_srgb(rgba);
    }
  }
  return -1;
}

inline std::string xcaf_label_name(const TDF_Label &label) {
  Handle(TDataStd_Name) attr;
  if (label.FindAttribute(TDataStd_Name::GetID(), attr)) {
    TCollection_AsciiString utf8(attr->Get());
    return std::string(utf8.ToCString());
  }
  return std::string();
}

inline std::vector<TopoDS_Shape> xcaf_explore(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind) {
  std::vector<TopoDS_Shape> out;
  for (TopExp_Explorer exp(shape, kind); exp.More(); exp.Next()) {
    out.push_back(exp.Current());
  }
  return out;
}

class StepAssembly {
public:
  struct Node {
    std::string name;
    int32_t parent;
    int32_t color;
  };
  struct Leaf {
    int32_t node;
    TopoDS_Shape shape;
    std::vector<int32_t> face_colors;
    int32_t solid_color;
    // "<product label entry>#<solid index>", with the product's own unplaced
    // solid and the placement that makes `shape` of it; empty for no solid.
    std::string product;
    TopoDS_Shape local;
    TopLoc_Location location;
  };
  std::vector<Node> nodes;
  std::vector<Leaf> leaves;
  std::vector<TopoDS_Shape> roots;
  bool is_assembly = false;
};

struct StepAssemblyWalk {
  StepAssembly &tree;
  Handle(XCAFDoc_ShapeTool) shapes;
  Handle(XCAFDoc_ColorTool) colors;
  bool reads_faces;
  std::map<std::string, std::vector<std::vector<int32_t>>> face_cache;
  std::map<std::string, std::vector<int32_t>> solid_cache;

  static std::string entry(const TDF_Label &label) {
    TCollection_AsciiString e;
    TDF_Tool::Entry(label, e);
    return std::string(e.ToCString());
  }

  // Per product, grouped by solid, empty when nothing on it is coloured.
  const std::vector<std::vector<int32_t>> &face_colors(const TDF_Label &referred) {
    std::string key = entry(referred);
    auto hit = face_cache.find(key);
    if (hit != face_cache.end()) {
      return hit->second;
    }
    std::vector<std::vector<int32_t>> out;
    if (reads_faces) {
      TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(referred);
      std::vector<TopoDS_Shape> groups = xcaf_explore(shape, TopAbs_SOLID);
      if (groups.empty()) {
        groups.push_back(shape);
      }
      bool colored = false;
      for (const TopoDS_Shape &g : groups) {
        std::vector<int32_t> row;
        for (const TopoDS_Shape &f : xcaf_explore(g, TopAbs_FACE)) {
          int32_t c = xcaf_shape_color(colors, f);
          colored = colored || c >= 0;
          row.push_back(c);
        }
        out.push_back(row);
      }
      if (!colored) {
        out.clear();
      }
    }
    return face_cache.emplace(key, out).first->second;
  }

  const std::vector<int32_t> &solid_colors(const TDF_Label &referred) {
    std::string key = entry(referred);
    auto hit = solid_cache.find(key);
    if (hit != solid_cache.end()) {
      return hit->second;
    }
    std::vector<int32_t> out;
    if (reads_faces) {
      for (const TopoDS_Shape &s : xcaf_explore(XCAFDoc_ShapeTool::GetShape(referred), TopAbs_SOLID)) {
        out.push_back(xcaf_shape_color(colors, s));
      }
    }
    return solid_cache.emplace(key, out).first->second;
  }

  void visit(const TDF_Label &label, int32_t parent, const TopLoc_Location &location) {
    TDF_Label referred = label;
    if (XCAFDoc_ShapeTool::IsReference(label)) {
      referred = TDF_Label();
      XCAFDoc_ShapeTool::GetReferredShape(label, referred);
    }
    int32_t color = xcaf_label_color(label);
    if (color < 0) {
      color = xcaf_label_color(referred);
    }
    int32_t index = static_cast<int32_t>(tree.nodes.size());
    tree.nodes.push_back({xcaf_label_name(referred) + std::string(1, '\0') + xcaf_label_name(label), parent, color});

    if (XCAFDoc_ShapeTool::IsAssembly(referred)) {
      tree.is_assembly = true;
      TDF_LabelSequence components;
      XCAFDoc_ShapeTool::GetComponents(referred, components);
      for (int i = 1; i <= components.Length(); ++i) {
        const TDF_Label &component = components.Value(i);
        visit(component, index, location * XCAFDoc_ShapeTool::GetLocation(component));
      }
      return;
    }

    TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(referred).Moved(location);
    std::vector<TopoDS_Shape> solids = xcaf_explore(shape, TopAbs_SOLID);
    const std::vector<std::vector<int32_t>> &by_solid = face_colors(referred);
    std::vector<int32_t> solid_cols;
    if (!solids.empty()) {
      solid_cols = solid_colors(referred);
    }
    std::vector<TopoDS_Shape> local;
    if (!solids.empty()) {
      local = xcaf_explore(XCAFDoc_ShapeTool::GetShape(referred), TopAbs_SOLID);
    } else {
      solids.push_back(shape);
    }
    for (size_t k = 0; k < solids.size(); ++k) {
      StepAssembly::Leaf leaf;
      leaf.node = index;
      leaf.shape = solids[k];
      leaf.solid_color = k < solid_cols.size() ? solid_cols[k] : -1;
      if (k < local.size()) {
        leaf.product = entry(referred) + "#" + std::to_string(k);
        leaf.local = local[k];
        leaf.location = location;
      }
      if (k < by_solid.size()) {
        bool any = false;
        for (int32_t c : by_solid[k]) {
          any = any || c >= 0;
        }
        if (any) {
          leaf.face_colors = by_solid[k];
        }
      }
      tree.leaves.push_back(leaf);
    }
  }
};

inline std::unique_ptr<StepAssembly> step_assembly_read(rust::Str path) {
  std::string file(path.data(), path.size());
  Handle(TDocStd_Document) doc = new TDocStd_Document(TCollection_ExtendedString("XCAF"));
  STEPCAFControl_Reader reader;
  reader.SetNameMode(true);
  reader.SetColorMode(true);
  reader.SetLayerMode(true);
  if (reader.ReadFile(file.c_str()) != IFSelect_RetDone) {
    throw std::runtime_error("could not read the STEP file (it may be truncated or not STEP)");
  }
  if (!reader.Transfer(doc)) {
    throw std::runtime_error("the STEP file was read but contained no transferable shape");
  }
  std::unique_ptr<StepAssembly> tree(new StepAssembly());
  StepAssemblyWalk walk{*tree, XCAFDoc_DocumentTool::ShapeTool(doc->Main()),
                        XCAFDoc_DocumentTool::ColorTool(doc->Main()), false, {}, {}};
  TDF_LabelSequence styled;
  walk.colors->GetColors(styled);
  walk.reads_faces = styled.Length() > 0;

  TDF_LabelSequence roots;
  walk.shapes->GetFreeShapes(roots);
  if (roots.Length() == 0) {
    throw std::runtime_error("the STEP file contains no shapes");
  }
  for (int i = 1; i <= roots.Length(); ++i) {
    const TDF_Label &label = roots.Value(i);
    TopLoc_Location location;
    tree->roots.push_back(XCAFDoc_ShapeTool::GetShape(xcaf_referred(label)).Moved(location));
    walk.visit(label, -1, location);
  }
  if (tree->nodes.size() > static_cast<size_t>(roots.Length()) || tree->leaves.size() > tree->nodes.size()) {
    tree->is_assembly = true;
  }
  return tree;
}

inline int32_t step_assembly_node_count(const StepAssembly &a) { return static_cast<int32_t>(a.nodes.size()); }
// The product label's name, a NUL, then the instance label's name, both UTF-8.
inline rust::Vec<uint8_t> step_assembly_node_names(const StepAssembly &a, int32_t i) {
  rust::Vec<uint8_t> out;
  for (char c : a.nodes.at(i).name) {
    out.push_back(static_cast<uint8_t>(c));
  }
  return out;
}
inline int32_t step_assembly_node_parent(const StepAssembly &a, int32_t i) { return a.nodes.at(i).parent; }
inline int32_t step_assembly_node_color(const StepAssembly &a, int32_t i) { return a.nodes.at(i).color; }
inline int32_t step_assembly_leaf_count(const StepAssembly &a) { return static_cast<int32_t>(a.leaves.size()); }
inline int32_t step_assembly_leaf_node(const StepAssembly &a, int32_t i) { return a.leaves.at(i).node; }
inline std::unique_ptr<TopoDS_Shape> step_assembly_leaf_shape(const StepAssembly &a, int32_t i) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(a.leaves.at(i).shape));
}
inline rust::Vec<int32_t> step_assembly_leaf_face_colors(const StepAssembly &a, int32_t i) {
  rust::Vec<int32_t> out;
  for (int32_t c : a.leaves.at(i).face_colors) {
    out.push_back(c);
  }
  return out;
}
inline int32_t step_assembly_leaf_solid_color(const StepAssembly &a, int32_t i) { return a.leaves.at(i).solid_color; }
inline int32_t step_assembly_root_count(const StepAssembly &a) { return static_cast<int32_t>(a.roots.size()); }
inline std::unique_ptr<TopoDS_Shape> step_assembly_root_shape(const StepAssembly &a, int32_t i) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(a.roots.at(i)));
}
inline bool step_assembly_is_assembly(const StepAssembly &a) { return a.is_assembly; }
inline rust::String step_assembly_leaf_product(const StepAssembly &a, int32_t i) {
  return rust::String(a.leaves.at(i).product);
}
inline std::unique_ptr<TopoDS_Shape> step_assembly_leaf_local(const StepAssembly &a, int32_t i) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(a.leaves.at(i).local));
}
inline std::unique_ptr<TopoDS_Shape> step_assembly_leaf_place(const StepAssembly &a, int32_t i,
                                                              const TopoDS_Shape &shape) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(shape.Moved(a.leaves.at(i).location)));
}
