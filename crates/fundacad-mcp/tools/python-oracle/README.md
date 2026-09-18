# The Python MCP server, kept as a parity oracle

This is the MCP server FundaCAD shipped as the `FundaCAD.MCP` plugin before the
Rust engine. `crates/fundacad-mcp` is its port and is what the app ships now
(`fundacad-mcp`, beside the app, set up from Preferences, AI assistants).

It stays only so `../diff_servers.py` can compare the two servers reply by
reply, and so its suites in `tests/` can still be run against the sidecar they
were written for. It needs the Python sidecar and goes with it: when `sidecar/`
is deleted, delete this directory and the left side of `diff_servers.py`.

    uv run --project sidecar python crates/fundacad-mcp/tools/python-oracle/tests/_run.py
    python crates/fundacad-mcp/tools/diff_servers.py crates/fundacad-mcp/tools/parity.jsonl

The generic MCP test client these use lives one level up, `../client.py`, and
drives the Rust server by default.
