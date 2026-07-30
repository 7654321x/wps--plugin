from .profile_loader import load_profile
from .validation import CommandServiceError


def resolve_profile(profile_id, profile_version):
    profile = load_profile(profile_id)
    if profile.get("version") != profile_version:
        raise CommandServiceError("PROFILE_VERSION_MISMATCH", "unsupported formatting profile version")
    return profile
