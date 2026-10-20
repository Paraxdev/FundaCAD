"""Stands in for fundacad-engine --ws: prints the ready line, or exits 3 once when asked."""

import os
import sys
import time
from pathlib import Path

once = os.environ.get("FAKE_BUSY_ONCE")
if once and not Path(once).exists():
    Path(once).write_text("x")
    sys.exit(3)
print(f"LISTENING {os.environ.get('FUNDACAD_ENGINE_PORT')}", flush=True)
print(f"TOKEN_SEEN {os.environ.get('FUNDACAD_ENGINE_TOKEN')}", flush=True)
time.sleep(600)
