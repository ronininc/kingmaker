"""Kingmaker CLI Hub: where it keeps its state and which catalog it reads (Ronin's, not upstream's).

KINGMAKER_CLI_HUB_HOME   state (installed list, caches, matrix skills); default ~/.kingmaker-cli-hub
KINGMAKER_CLI_CATALOG    the catalog folder (registry.json, public_registry.json, matrix_registry.json); default the
                         one shipped beside this package, which the owner edits
KINGMAKER_CLI_REGISTRY_URL / KINGMAKER_CLI_PUBLIC_REGISTRY_URL / KINGMAKER_CLI_MATRIX_REGISTRY_URL
                         an https catalog the owner hosts instead (optional)
"""
import os
from pathlib import Path

HUB_HOME = Path(os.environ.get("KINGMAKER_CLI_HUB_HOME") or (Path.home() / ".kingmaker-cli-hub"))
CATALOG = Path(os.environ.get("KINGMAKER_CLI_CATALOG") or (Path(__file__).resolve().parent.parent / "catalog"))


def catalog(name, env):
    """The URL or local path for one catalog file."""
    return os.environ.get(env) or str(CATALOG / name)
