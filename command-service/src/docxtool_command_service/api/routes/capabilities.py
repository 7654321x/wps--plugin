from ...core.command_policy import ALLOWED_COMMANDS
from ...core.version import CLIENT_CAPABILITIES_VERSION


def payload():
    return {"schema_version": CLIENT_CAPABILITIES_VERSION, "commands": sorted(ALLOWED_COMMANDS)}
