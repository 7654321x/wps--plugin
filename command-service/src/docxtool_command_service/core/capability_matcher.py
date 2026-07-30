"""Apply one capability policy to both local and cloud command generation."""


def match_capabilities(commands, capabilities):
    supported = set(capabilities)
    retained = []
    warnings = []
    for command in commands:
        if command["required_capability"] in supported:
            retained.append(command)
        elif command["on_unsupported"] == "skip":
            warnings.append("unsupported capability: %s" % command["required_capability"])
        else:
            raise ValueError("required client capability is unavailable")
    return retained, warnings
