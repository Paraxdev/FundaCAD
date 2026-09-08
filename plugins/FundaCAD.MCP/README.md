# MCP server

Lets an AI assistant build, measure and edit models here.

`server.py` speaks the Model Context Protocol on stdio. It is launched by the
assistant's host (Claude Code, Claude Desktop, an editor), not by this app; what
the app produces is the command line that host needs. See `docs/MCP.md`.

## Why these grants

Not `process.spawn`, and the distinction is the point of having a closed
vocabulary. The server does start a second process when it works on its own
copy, but that process is the geometry engine this app already ships, started
from a path this app hands it. "Start other programs on your computer" would be
a true sentence describing something else.

Not `network` either. It speaks to the engine over loopback, and putting
"connect to 127.0.0.1" on a consent screen teaches people to skim it.
