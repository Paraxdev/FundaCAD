"""The runner every test file here shares: call every test_* in the module,
report, and exit non-zero if any failed.

Copied in spirit from sidecar/tests, which have the same shape. These are
`__main__` scripts rather than pytest files because that is what this repository
runs in CI, and a second discovery mechanism is a second thing to forget.
"""

import sys
import traceback


def run(namespace, label):
    failed = 0
    for name, fn in sorted(namespace.items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
    print(f"{label}:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
