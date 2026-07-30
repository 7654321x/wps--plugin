from ...core.command_builder import build_formatting_commands


def handle_commands(payload):
    return build_formatting_commands(payload)
