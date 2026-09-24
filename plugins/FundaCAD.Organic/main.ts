// Node bodies: rounded, organic solids from sized nodes. The feature type, its
// rows, its tool and its geometry (geometry-rs/) all live here; the app only
// carries a node body it cannot build when this plugin is gone.

import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import { NodeTool } from "./nodeTool";
import NodePanel from "./NodePanel.vue";
import * as panel from "./panel";
import { NODE_CHOICE_FIELDS, NODE_TARGETS, NODE_TYPE, nodeNumFields } from "./nodeForm";

const ID = "FundaCAD.Organic";

/** Three nodes of falling size strung on a curved spine. A compile-time
 *  constant: it reaches the DOM through the app's Icon component. */
const NODE_ICON =
  '<circle cx="5.5" cy="16.5" r="3.2"/><circle cx="12.6" cy="10.4" r="2.3"/><circle cx="18.8" cy="5.4" r="1.5"/>' +
  '<path d="M8 14.4c1-1 1.9-1.9 2.8-2.6"/><path d="M14.5 9c1.1-.9 2-1.6 3-2.4"/>';

export async function activate(e: Engine): Promise<() => void> {
  const tool = new NodeTool(e);

  function start() {
    if (e.toolBusy()) return;
    tool.start((id) => {
      e.noteCommitted(id);
      if (id) e.selectFeature(id);
    });
  }

  const off = contribute(ID, {
    tools: [{
      id: "nodeBody",
      label: "Node Body",
      iconName: "node-body",
      consumes: [],
      source: "selection",
      busy: () => tool.active,
    }],
    actions: { nodeBody: start },
    ribbon: [{ group: "CREATE", items: [{ action: "nodeBody", label: "Node Body", iconName: "node-body" }] }],
    icons: { "node-body": NODE_ICON },
    overlays: [NodePanel],
    features: [{
      type: NODE_TYPE,
      meta: { icon: "node-body", label: "Node body" },
      choiceFields: NODE_CHOICE_FIELDS,
      numFields: nodeNumFields,
      targets: NODE_TARGETS,
      edit: (featureId, done) => tool.startEdit(featureId, done),
    }],
  });

  return () => {
    tool.cancel();
    panel.close();
    off();
  };
}
