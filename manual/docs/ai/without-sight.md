# Model without sight

These routes let you model without looking at the screen, and you can mix them in one document.

## In the app, with keys and a screen reader

1. [Draw with keys](../sketch/keyboard.md): each point and shape is spoken with its size.
2. [Pick with keys](../model/picking.md#pick-with-keys) and [the Geometry tab](../model/items.md#the-geometry-tab): faces and edges are read with their type, size and facing.
3. [The view as text](../model/picking.md#the-view-as-text): Describe Model gives every body with its size, center and volume.
4. The Items tree and History are walked with the arrows, see [Accessibility](../reference/accessibility.md#keyboard).

The names and roles a screen reader reads are checked by every build, but no screen reader run has been recorded yet, see [what is still checked by hand](../reference/accessibility.md#what-is-still-checked-by-hand).

## With an AI assistant

An assistant [connected over MCP](connect.md) builds and checks parts with the same engine as the app, and tells you the results in words: sizes, volumes, sections, clashes, print problems and stress. You talk to it in its own window, so pick one your screen reader can read, such as a terminal it supports.

With Live document set to Share, and allow edits, it changes the document you have open, and Ctrl+Z undoes each change as one step ([Share your document](sharing.md)).

| System | Assistants that can connect |
| --- | --- |
| Windows | Claude Code, in a terminal, and Claude Desktop |
| macOS | Claude Code, in a terminal, and Claude Desktop |
| Linux | Claude Code, in a terminal. Claude Desktop has no Linux version |
| Any | Another program that supports MCP, see [Connect an AI assistant](connect.md) |

Ask for real sizes and named parameters, for example "make a box 60 by 40 by 20 mm with 2 mm walls, and tell me its volume". Then ask it to check what you need, such as "is anything thinner than 1.2 mm" or "does it clash with the lid".

FundaCAD does not speak what an assistant changed. Its reply says it, and a feature it adds shows in History.

A guide from an assistant ([Let an assistant guide you](guide.md)) points at the screen with a ring. When the assistant gives a step's keys, the caption box says them in words after With keys, so the step does not depend on seeing the ring. You can also ask the assistant to tell you each step in its own window.
