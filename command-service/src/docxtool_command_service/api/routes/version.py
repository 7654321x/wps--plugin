from ...core.version import FORMATTING_COMMAND_SET_VERSION, SERVICE_VERSION


def payload():
    return {"schema_version": FORMATTING_COMMAND_SET_VERSION, "service_version": SERVICE_VERSION}
