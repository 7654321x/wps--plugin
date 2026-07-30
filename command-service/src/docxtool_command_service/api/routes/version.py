from ...core.version import PROTOCOL_VERSION, SERVICE_VERSION


def payload():
    return {"schema_version": PROTOCOL_VERSION, "service_version": SERVICE_VERSION}
