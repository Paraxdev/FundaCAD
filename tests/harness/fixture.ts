// A small slice of the app's DOM, enough for the harness walker to read.

import type { Box } from "../../src/harness/screenTree";

export const APP_HTML = `
<header id="titlebar">
  <button id="undo-btn" class="tb-btn" title="Undo (Ctrl+Z)" aria-label="Undo"></button>
  <button id="redo-btn" class="tb-btn" title="Redo (Ctrl+Y)" aria-label="Redo" disabled></button>
  <span id="docname" class="docname dirty"><!-- a dev build keeps comments -->Untitled<span class="dirty-mark">*</span></span>
  <nav id="menubar">
    <div class="menu"><button class="btn menu-btn" aria-expanded="false">File</button></div>
    <div class="menu"><button class="btn menu-btn is-open" aria-expanded="true">Edit</button></div>
  </nav>
</header>
<div class="ui-menu" role="menu" aria-label="Edit"><div class="menubar-rows" role="none">
  <div class="ui-menu-item menu-item" role="menuitem"><span class="ui-menu-label">Preferences...</span><span class="ui-menu-keys">Ctrl+,</span></div>
</div></div>
<div class="ui-menu" role="menu" aria-label="File" style="visibility:hidden">
  <div class="ui-menu-item menu-item" role="menuitem"><span class="ui-menu-label">Open...</span><span class="ui-menu-keys">Ctrl+O</span></div>
</div>
<nav id="toolrail" data-mode="model">
  <button class="rail-btn" data-action="sketch" aria-label="Sketch (S)"></button>
  <button class="rail-btn" data-family="cat:CREATE" aria-label="Create"></button>
  <button class="rail-btn" data-family="cat:MODIFY" aria-label="Modify"></button>
  <button class="rail-btn disabled" data-action="measure" aria-label="Measure (I)" disabled></button>
</nav>
<div id="timeline">
  <div class="timeline-item"><div class="timeline-node" data-id="s1"><span class="t-name">Sketch 1</span></div></div>
  <div class="timeline-item"><div class="timeline-node selected" data-id="e1"><span class="t-name">Extrude 1</span></div></div>
</div>
<div class="dim-input" style="display:none"><label class="dim-field" data-field="distance"><span>D</span><input aria-label="D" /></label></div>
<div class="dim-input" style="display:flex">
  <label class="dim-field" data-field="angle"><span>Angle</span><input aria-label="Angle" value="3 deg" /></label>
  <button class="dim-btn dim-ok" title="Confirm (Enter)" aria-label="Confirm"></button>
</div>
<div inert><button>Behind Home</button></div>
<aside id="browser"><div class="float-card-body" style="overflow-y:auto">
  <div class="tree-folder" data-key="n:f1/0" aria-expanded="false"><span class="tree-label">Robot</span><span class="tree-eye" data-visible="false"></span></div>
  <div class="feature-row tree-child" data-id="body1"><span class="tree-label">Plate</span><span class="tree-eye" data-visible="true"></span></div>
  <div class="feature-row tree-child" data-id="body2" data-y="400"><span class="tree-label">Boss</span></div>
  <div class="feature-row tree-child" data-id="body3" data-y="500"><span class="tree-label">Rib</span></div>
</div></aside>
<div class="ui-menu" role="menu"><div class="ui-menu-item ctx-item" role="menuitem"><span class="ui-menu-label">Rename</span><span class="ui-menu-keys">F2</span></div></div>
<div class="prompt"><span id="prompt" class="prompt-text">Pick a face to draft</span></div>
<button class="plain">Cancel</button>
<button class="plain">Cancel</button>
`;

/** Lists are 100 px tall, a row with data-y below that is scrolled out. */
export function rect(el: Element): Box {
  if (el.matches(".float-card-body")) return { left: 0, top: 0, width: 200, height: 100 };
  return { left: 0, top: Number(el.getAttribute("data-y") ?? 10), width: 20, height: 10 };
}

export function mountApp(html = APP_HTML): void {
  document.body.innerHTML = html;
}
