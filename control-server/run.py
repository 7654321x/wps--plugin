"""Source-tree launcher used by the WPS developer entry point."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "command-service" / "src"))

from wps_control_server.__main__ import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
