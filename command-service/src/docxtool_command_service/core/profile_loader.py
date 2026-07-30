"""Load a named semantic profile without importing an editor implementation."""

import json
from pathlib import Path

from .validation import CommandServiceError


def load_profile(profile_id):
    if profile_id != "default":
        raise CommandServiceError("PROFILE_NOT_FOUND", "unknown formatting profile")
    path = Path(__file__).resolve().parent.parent / "profiles" / "docxtool-default.json"
    return json.loads(path.read_text(encoding="utf-8"))
