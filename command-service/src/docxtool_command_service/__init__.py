"""Versioned, declarative command service shared by local and cloud editions."""

from .core.command_builder import build_formatting_commands

__all__ = ["build_formatting_commands"]
