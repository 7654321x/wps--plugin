from ...core.command_policy import ALLOWED_COMMANDS
from ...core.version import PROTOCOL_VERSION


def payload():
    return {"schema_version": PROTOCOL_VERSION, "commands": sorted(ALLOWED_COMMANDS)}
